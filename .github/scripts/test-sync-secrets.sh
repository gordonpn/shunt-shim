#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
JUST="$(command -v just)"
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/.github/scripts" "$TMP_DIR/expected"
cp "$REPO_ROOT/Justfile" "$TMP_DIR/Justfile"
cp "$REPO_ROOT/.github/scripts/sync-secrets.sh" "$TMP_DIR/.github/scripts/"
for tool in bash sh cat; do
  ln -s "$(command -v "$tool")" "$TMP_DIR/bin/$tool"
done

cat > "$TMP_DIR/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_ROOT/calls"
[[ -z "${GROQ_API_KEY:-}" && -z "${GEMINI_API_KEY:-}" ]]
if [[ "$*" == 'auth status' ]]; then
  exit "${MOCK_AUTH_STATUS:-0}"
fi
if [[ "$1" == 'api' ]]; then
  if [[ "$2 $3" == '-X PUT' && "$4" == 'repos/{owner}/{repo}/environments/production' ]]; then
    exit "${MOCK_ENV_FAIL:-0}"
  fi
  if [[ "$2" == 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' ]]; then
    printf '%s\n' "${MOCK_MAIN_POLICY_COUNT:-0}"
    exit 0
  fi
  if [[ "$2 $3" == '-X POST' && "$4" == 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' ]]; then
    [[ "${MOCK_MAIN_POLICY_COUNT:-0}" == '0' ]] || exit 92
    exit 0
  fi
  exit 93
fi
if [[ "$1 $2" == 'secret list' ]]; then
  if [[ -n "${MOCK_REPO_SECRETS:-}" ]]; then
    printf '%b\n' "$MOCK_REPO_SECRETS"
  fi
  exit 0
fi
if [[ "$1 $2" == 'secret delete' && "$#" == 3 ]]; then
  case "$3" in
    CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|GATEWAY_TOKENS) ;;
    *) exit 94 ;;
  esac
  printf '%s\n' "$3" >> "$MOCK_ROOT/deletes"
  exit 0
fi
[[ "$#" == 5 && "$1 $2 $3 $4" == 'secret set --env production' ]]
case "$5" in
  CLOUDFLARE_PRODUCTION_API_TOKEN|CLOUDFLARE_PRODUCTION_ACCOUNT_ID|PRODUCTION_GATEWAY_TOKENS) ;;
  *) exit 91 ;;
esac
value=$(cat)
[[ "$value" == "$(cat "$MOCK_ROOT/expected/$5")" ]]
if [[ "${MOCK_FAIL_NAME:-}" == "$5" ]]; then
  printf 'untrusted output: %s\n' "$value"
  printf 'untrusted diagnostic: %s\n' "$value" >&2
  exit 1
fi
printf '%s\n' "$5" >> "$MOCK_ROOT/writes"
MOCK
chmod +x "$TMP_DIR/bin/gh"

fail() { echo "$1" >&2; exit 1; }
fixture() {
  cat > "$TMP_DIR/.dev.vars" <<'VARS'
CLOUDFLARE_API_TOKEN='dummy-cloudflare-token-$literal'
CLOUDFLARE_ACCOUNT_ID="dummy-account-id"
GATEWAY_TOKENS="dummy-gateway-token"
GROQ_API_KEY="dummy-upstream-groq"
GEMINI_API_KEY="dummy-upstream-gemini"
VARS
}
# Verify dotenv keeps a dollar sign literal rather than expanding shell code.
# shellcheck disable=SC2016
printf '%s' 'dummy-cloudflare-token-$literal' > "$TMP_DIR/expected/CLOUDFLARE_PRODUCTION_API_TOKEN"
printf '%s' 'dummy-account-id' > "$TMP_DIR/expected/CLOUDFLARE_PRODUCTION_ACCOUNT_ID"
printf '%s' 'dummy-gateway-token' > "$TMP_DIR/expected/PRODUCTION_GATEWAY_TOKENS"

run() {
  : > "$TMP_DIR/calls"
  : > "$TMP_DIR/writes"
  : > "$TMP_DIR/deletes"
  status=0
  output=$(env -i PATH="$TMP_DIR/bin" MOCK_ROOT="$TMP_DIR" "$@" \
    "$JUST" --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" \
    sync-github-secrets 2>&1) || status=$?
  if [[ "$output" == *dummy-* ]]; then
    fail 'Secret leaked in command output'
  fi
}
expect_failure() {
  [[ "$status" != 0 && "$output" == *"$1"* ]] || fail "Expected failure: $1"
  [[ ! -s "$TMP_DIR/writes" ]] || fail 'Unexpected secret write before validation'
}

fixture
mv "$TMP_DIR/bin/gh" "$TMP_DIR/gh-disabled"
run
expect_failure 'GitHub CLI (gh) is required'
mv "$TMP_DIR/gh-disabled" "$TMP_DIR/bin/gh"
run MOCK_AUTH_STATUS=1
expect_failure 'gh auth login'
[[ "$(cat "$TMP_DIR/calls")" == 'auth status' ]] || fail 'Continued after authentication failure'

rm "$TMP_DIR/.dev.vars"
run
expect_failure 'Missing .dev.vars'
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GATEWAY_TOKENS; do
  fixture
  grep -v "^$name=" "$TMP_DIR/.dev.vars" > "$TMP_DIR/.dev.vars.tmp" && mv "$TMP_DIR/.dev.vars.tmp" "$TMP_DIR/.dev.vars"
  run
  expect_failure "Missing required environment variable"
  fixture
  printf '%s=""\n' "$name" >> "$TMP_DIR/.dev.vars"
  run
  expect_failure "Missing required environment variable"
  fixture
  printf '%s="   "\n' "$name" >> "$TMP_DIR/.dev.vars"
  run
  expect_failure "Missing required environment variable"
done

# Missing environment setup succeeds cleanly on first run and prunes legacy secrets only.
fixture
run MOCK_MAIN_POLICY_COUNT=0 MOCK_REPO_SECRETS='CLOUDFLARE_API_TOKEN\nDEEPSEEK_API_KEY\nGATEWAY_TOKENS'
[[ "$status" == 0 ]] || fail "Valid dotenv fixture did not synchronize: $output"
printf '%s\n' CLOUDFLARE_PRODUCTION_API_TOKEN CLOUDFLARE_PRODUCTION_ACCOUNT_ID PRODUCTION_GATEWAY_TOKENS > "$TMP_DIR/expected-writes"
cmp -s "$TMP_DIR/writes" "$TMP_DIR/expected-writes" || fail 'Incorrect production secret allowlist/order'
printf '%s\n' CLOUDFLARE_API_TOKEN GATEWAY_TOKENS > "$TMP_DIR/expected-deletes"
cmp -s "$TMP_DIR/deletes" "$TMP_DIR/expected-deletes" || fail 'Legacy repository secrets were not pruned cleanly'
grep -qx 'api -X POST repos/{owner}/{repo}/environments/production/deployment-branch-policies -f name=main -f type=branch' "$TMP_DIR/calls" || fail 'Expected main branch policy creation when absent'
grep -qx 'secret set --env production CLOUDFLARE_PRODUCTION_API_TOKEN' "$TMP_DIR/calls" || fail 'Expected --env production secret write'

# Idempotent rerun when main branch policy already exists and no legacy secrets remain.
run MOCK_MAIN_POLICY_COUNT=1 MOCK_REPO_SECRETS='DEEPSEEK_API_KEY'
[[ "$status" == 0 ]] || fail "Idempotent rerun failed: $output"
[[ ! -s "$TMP_DIR/deletes" ]] || fail 'Attempted to delete unrelated repository secret'
if grep -q 'deployment-branch-policies -f name=main' "$TMP_DIR/calls"; then
  fail 'Recreated existing main branch policy'
fi

# Primary production variables override fallback dotenv names.
printf '%s' 'dummy-prod-override-token' > "$TMP_DIR/expected/CLOUDFLARE_PRODUCTION_API_TOKEN"
run CLOUDFLARE_PRODUCTION_API_TOKEN='dummy-prod-override-token' MOCK_MAIN_POLICY_COUNT=1
[[ "$status" == 0 ]] || fail "Production override failed: $output"
# shellcheck disable=SC2016
printf '%s' 'dummy-cloudflare-token-$literal' > "$TMP_DIR/expected/CLOUDFLARE_PRODUCTION_API_TOKEN"

# Explicit empty primary override must not silently fall back to legacy variable.
run CLOUDFLARE_PRODUCTION_API_TOKEN='   '
expect_failure 'Missing required environment variable: CLOUDFLARE_PRODUCTION_API_TOKEN'

# Local upstream credentials are optional, and environment values override dotenv.
grep -Ev '^(GROQ_API_KEY|GEMINI_API_KEY|GATEWAY_TOKENS)=' "$TMP_DIR/.dev.vars" > "$TMP_DIR/.dev.vars.tmp" && mv "$TMP_DIR/.dev.vars.tmp" "$TMP_DIR/.dev.vars"
run GATEWAY_TOKENS=dummy-gateway-token MOCK_MAIN_POLICY_COUNT=1
[[ "$status" == 0 ]] || fail 'Environment fallback or absent upstream credentials failed'
fixture
run GATEWAY_TOKENS=''
expect_failure 'Missing required environment variable: PRODUCTION_GATEWAY_TOKENS'
run GATEWAY_TOKENS='   '
expect_failure 'Missing required environment variable: PRODUCTION_GATEWAY_TOKENS'

run MOCK_ENV_FAIL=1
expect_failure 'Failed to configure production environment deployment branch policy'

run MOCK_MAIN_POLICY_COUNT=1 MOCK_FAIL_NAME=CLOUDFLARE_PRODUCTION_API_TOKEN
expect_failure 'Failed to synchronize CLOUDFLARE_PRODUCTION_API_TOKEN'
run MOCK_MAIN_POLICY_COUNT=1 MOCK_FAIL_NAME=CLOUDFLARE_PRODUCTION_ACCOUNT_ID
[[ "$status" != 0 && "$output" == *'Failed to synchronize CLOUDFLARE_PRODUCTION_ACCOUNT_ID'* ]] || fail 'Write failure ignored'
[[ "$(cat "$TMP_DIR/writes")" == CLOUDFLARE_PRODUCTION_API_TOKEN ]] || fail 'Continued after failed write'

echo 'All secret synchronization test cases passed successfully.'
