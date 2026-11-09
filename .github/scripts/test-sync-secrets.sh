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
[[ "$#" == 3 && "$1 $2" == 'secret set' ]]
case "$3" in
  CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|GATEWAY_TOKENS) ;;
  *) exit 91 ;;
esac
value=$(cat)
[[ "$value" == "$(cat "$MOCK_ROOT/expected/$3")" ]]
if [[ "${MOCK_FAIL_NAME:-}" == "$3" ]]; then
  printf 'untrusted output: %s\n' "$value"
  printf 'untrusted diagnostic: %s\n' "$value" >&2
  exit 1
fi
printf '%s\n' "$3" >> "$MOCK_ROOT/writes"
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
printf '%s' 'dummy-cloudflare-token-$literal' > "$TMP_DIR/expected/CLOUDFLARE_API_TOKEN"
printf '%s' 'dummy-account-id' > "$TMP_DIR/expected/CLOUDFLARE_ACCOUNT_ID"
printf '%s' 'dummy-gateway-token' > "$TMP_DIR/expected/GATEWAY_TOKENS"

run() {
  : > "$TMP_DIR/calls"
  : > "$TMP_DIR/writes"
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
  sed -i "/^$name=/d" "$TMP_DIR/.dev.vars"
  run
  expect_failure "Missing required environment variable: $name"
  fixture
  printf '%s=""\n' "$name" >> "$TMP_DIR/.dev.vars"
  run
  expect_failure "Missing required environment variable: $name"
done

fixture
run
[[ "$status" == 0 ]] || fail 'Valid dotenv fixture did not synchronize'
printf '%s\n' CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GATEWAY_TOKENS > "$TMP_DIR/expected-writes"
cmp -s "$TMP_DIR/writes" "$TMP_DIR/expected-writes" || fail 'Incorrect secret allowlist/order'
printf '%s\n' 'auth status' 'secret set CLOUDFLARE_API_TOKEN' \
  'secret set CLOUDFLARE_ACCOUNT_ID' 'secret set GATEWAY_TOKENS' > "$TMP_DIR/expected-calls"
cmp -s "$TMP_DIR/calls" "$TMP_DIR/expected-calls" || fail 'Secret appeared in gh arguments'

# Local upstream credentials are optional, and environment values override dotenv.
sed -i '/^GROQ_API_KEY=/d; /^GEMINI_API_KEY=/d; /^GATEWAY_TOKENS=/d' "$TMP_DIR/.dev.vars"
run GATEWAY_TOKENS=dummy-gateway-token
[[ "$status" == 0 ]] || fail 'Environment fallback or absent upstream credentials failed'
fixture
run GATEWAY_TOKENS=''
expect_failure 'Missing required environment variable: GATEWAY_TOKENS'

run MOCK_FAIL_NAME=CLOUDFLARE_API_TOKEN
expect_failure 'Failed to synchronize CLOUDFLARE_API_TOKEN'
run MOCK_FAIL_NAME=CLOUDFLARE_ACCOUNT_ID
[[ "$status" != 0 && "$output" == *'Failed to synchronize CLOUDFLARE_ACCOUNT_ID'* ]] || fail 'Write failure ignored'
[[ "$(cat "$TMP_DIR/writes")" == CLOUDFLARE_API_TOKEN ]] || fail 'Continued after failed write'

echo 'All secret synchronization test cases passed successfully.'
