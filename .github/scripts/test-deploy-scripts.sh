#!/usr/bin/env bash
set -euo pipefail

# Deterministic verification of deploy-preview.sh and deploy-production.sh
# behavior across missing credentials, URL extraction, and automated rollback.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# 1. Missing credentials skip cleanly for preview deployment
# 1a. Neither credential configured
set +e
output=$(env -i PATH="$PATH" bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ] || ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected deploy-preview.sh to skip when both credentials missing, got exit: $status, output: $output" >&2
  exit 1
fi

# 1b. Missing CLOUDFLARE_API_TOKEN
set +e
output=$(env -i PATH="$PATH" CLOUDFLARE_ACCOUNT_ID="dummy-acc" bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ] || ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected deploy-preview.sh to skip when CLOUDFLARE_API_TOKEN is missing, got exit: $status, output: $output" >&2
  exit 1
fi

# 1c. Missing CLOUDFLARE_ACCOUNT_ID
set +e
output=$(env -i PATH="$PATH" CLOUDFLARE_API_TOKEN="dummy-token" bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ] || ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected deploy-preview.sh to skip when CLOUDFLARE_ACCOUNT_ID is missing, got exit: $status, output: $output" >&2
  exit 1
fi

# 2. Missing credentials skip cleanly for production deployment
# 2a. Neither credential configured
set +e
output=$(env -i PATH="$PATH" bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ] || ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected deploy-production.sh to skip when both credentials missing, got exit: $status, output: $output" >&2
  exit 1
fi

# 2b. Missing CLOUDFLARE_API_TOKEN
set +e
output=$(env -i PATH="$PATH" CLOUDFLARE_ACCOUNT_ID="dummy-acc" bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ] || ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected deploy-production.sh to skip when CLOUDFLARE_API_TOKEN is missing, got exit: $status, output: $output" >&2
  exit 1
fi

# 2c. Missing CLOUDFLARE_ACCOUNT_ID
set +e
output=$(env -i PATH="$PATH" CLOUDFLARE_API_TOKEN="dummy-token" bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ] || ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected deploy-production.sh to skip when CLOUDFLARE_ACCOUNT_ID is missing, got exit: $status, output: $output" >&2
  exit 1
fi

# Create a mock bin directory to simulate `just` commands
MOCK_BIN="$TMP_DIR/bin"
mkdir -p "$MOCK_BIN"
MOCK_LOG="$TMP_DIR/mock_calls.log"

cat << 'EOF' > "$MOCK_BIN/just"
#!/usr/bin/env bash
set -euo pipefail
MOCK_LOG="${MOCK_LOG:-/tmp/mock_calls.log}"
echo "$@" >> "$MOCK_LOG"

case "$1" in
  deploy-preview)
    alias="${2:-}"
    if [ "${MOCK_DEPLOY_FAIL:-false}" = "true" ]; then
      echo "Fatal upload error: authentication expired" >&2
      exit 1
    fi
    if [ "${MOCK_NO_URL:-false}" = "true" ]; then
      echo "Total Upload: 105.78 KiB"
      echo "Worker Version ID: abcdef12-3456-7890"
      exit 0
    fi
    cat << MOCK_OUT
Total Upload: 105.78 KiB / gzip: 22.93 KiB
Worker Startup Time: 12 ms
Uploaded shunt-shim (1.23 sec)
Worker Version ID: abcdef12-3456-7890-abcd-ef1234567890
Version Preview URL: https://abcdef12-shunt-shim.subdomain.workers.dev
Version Preview Alias URL: https://${alias}-shunt-shim.subdomain.workers.dev
MOCK_OUT
    ;;
  deploy)
    if [ "${MOCK_DEPLOY_FAIL:-false}" = "true" ]; then
      echo "Fatal deployment error: authentication expired" >&2
      exit 1
    fi
    if [ "${MOCK_NO_URL:-false}" = "true" ]; then
      echo "Total Upload: 105.78 KiB"
      echo "Deployment ID: 12345678-abcd-ef12"
      exit 0
    fi
    cat << MOCK_OUT
Total Upload: 105.78 KiB / gzip: 22.93 KiB
Deployed shunt-shim triggers (1.15 sec)
  https://shunt-shim.subdomain.workers.dev
Current Deployment ID: 12345678-abcd-ef12-3456-7890abcdef12
MOCK_OUT
    ;;
  verify-ingress)
    url="$2"
    if [ "${FAIL_VERIFY:-false}" = "true" ]; then
      if [ "${FAIL_POST_ROLLBACK:-false}" != "true" ] && grep -q "^rollback$" "$MOCK_LOG"; then
        echo "Post-rollback ingress check passed for $url"
        exit 0
      fi
      echo "Ingress check failed for $url" >&2
      exit 1
    fi
    echo "Ingress check passed for $url"
    ;;
  rollback)
    echo "Rolled back successfully"
    ;;
  *)
    echo "Unknown mock command: $1" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$MOCK_BIN/just"

# 3. Preview deployment with alias extracts Version Preview Alias URL and calls verify-ingress
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Expected deploy-preview.sh with mock to succeed, got: $status, output: $output" >&2
  exit 1
fi
if ! grep -q "deploy-preview pr-80" "$MOCK_LOG"; then
  echo "Expected 'deploy-preview pr-80' call in mock log, got: $(cat "$MOCK_LOG")" >&2
  exit 1
fi
if ! grep -q "verify-ingress https://pr-80-shunt-shim.subdomain.workers.dev" "$MOCK_LOG"; then
  echo "Expected 'verify-ingress https://pr-80-shunt-shim.subdomain.workers.dev' in mock log, got: $(cat "$MOCK_LOG")" >&2
  exit 1
fi

# 4. Preview deployment failure preserves output
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  MOCK_DEPLOY_FAIL="true" \
  bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected deploy-preview.sh to fail on deployment error, got: 0" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Fatal upload error: authentication expired"; then
  echo "Expected failure output preserved in deploy-preview.sh, got: $output" >&2
  exit 1
fi

# 5. Preview deployment missing URL reports extraction error
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  MOCK_NO_URL="true" \
  bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected deploy-preview.sh to fail when URL missing, got: 0" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Could not extract preview URL"; then
  echo "Expected URL extraction error message, got: $output" >&2
  exit 1
fi

# 6. Production deployment extracts URL and succeeds when ingress passes
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Expected deploy-production.sh with mock to succeed, got: $status, output: $output" >&2
  exit 1
fi
if ! grep -q "^deploy$" "$MOCK_LOG"; then
  echo "Expected 'deploy' call in mock log, got: $(cat "$MOCK_LOG")" >&2
  exit 1
fi
if ! grep -q "verify-ingress https://shunt-shim.subdomain.workers.dev" "$MOCK_LOG"; then
  echo "Expected 'verify-ingress https://shunt-shim.subdomain.workers.dev' in mock log, got: $(cat "$MOCK_LOG")" >&2
  exit 1
fi

# 7. Production deployment failure preserves output
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  MOCK_DEPLOY_FAIL="true" \
  bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected deploy-production.sh to fail on deployment error, got: 0" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Fatal deployment error: authentication expired"; then
  echo "Expected failure output preserved in deploy-production.sh, got: $output" >&2
  exit 1
fi

# 8. Production deployment missing URL reports extraction error
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  MOCK_NO_URL="true" \
  bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected deploy-production.sh to fail when URL missing, got: 0" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Could not extract deployed URL"; then
  echo "Expected URL extraction error message, got: $output" >&2
  exit 1
fi

# 9. Production deployment triggers rollback and verifies recovery when verify-ingress fails
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  FAIL_VERIFY="true" \
  bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected deploy-production.sh to fail when verify-ingress fails, got exit 0" >&2
  exit 1
fi
if ! grep -q "^rollback$" "$MOCK_LOG"; then
  echo "Expected 'rollback' call in mock log when verification fails, got: $(cat "$MOCK_LOG")" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Rollback restored healthy ingress"; then
  echo "Expected rollback recovery notification in output, got: $output" >&2
  exit 1
fi

# 10. Production deployment reports failed recovery when ingress remains broken after rollback
: > "$MOCK_LOG"
set +e
output=$(env -i PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  CLOUDFLARE_API_TOKEN="dummy-token" \
  CLOUDFLARE_ACCOUNT_ID="dummy-account" \
  FAIL_VERIFY="true" \
  FAIL_POST_ROLLBACK="true" \
  bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected deploy-production.sh to fail when post-rollback verification fails, got exit 0" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Error: Post-rollback ingress verification also failed"; then
  echo "Expected failed recovery report in output, got: $output" >&2
  exit 1
fi

echo "All deploy script test cases passed successfully."
