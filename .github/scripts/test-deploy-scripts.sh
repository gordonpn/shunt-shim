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
set +e
output=$(env -i PATH="$PATH" bash "$REPO_ROOT/.github/scripts/deploy-preview.sh" 80 2>&1)
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Expected deploy-preview.sh to exit 0 when credentials are missing, got: $status" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected skip message for missing credentials in deploy-preview.sh, got: $output" >&2
  exit 1
fi

# 2. Missing credentials skip cleanly for production deployment
set +e
output=$(env -i PATH="$PATH" bash "$REPO_ROOT/.github/scripts/deploy-production.sh" 2>&1)
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Expected deploy-production.sh to exit 0 when credentials are missing, got: $status" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured"; then
  echo "Expected skip message for missing credentials in deploy-production.sh, got: $output" >&2
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

# 4. Production deployment extracts URL and succeeds when ingress passes
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

# 5. Production deployment triggers rollback when verify-ingress fails
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
if ! echo "$output" | grep -q "rolling back to previous deployment"; then
  echo "Expected rollback notification in output, got: $output" >&2
  exit 1
fi

echo "All deploy script test cases passed successfully."
