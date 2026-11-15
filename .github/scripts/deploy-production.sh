#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured. Skipping production deployment."
  exit 0
fi

echo "Deploying to production..."
if ! OUTPUT=$(just deploy 2>&1); then
  echo "${OUTPUT}"
  echo "Error: Production deployment command failed." >&2
  exit 1
fi
echo "${OUTPUT}"

DEPLOY_URL=$(echo "${OUTPUT}" | grep -E -o 'https://[^[:space:]]+workers\.dev' | head -n 1 || true)

if [ -z "$DEPLOY_URL" ]; then
  echo "Error: Could not extract deployed URL from production deployment output." >&2
  exit 1
fi

echo "Production deployed successfully: ${DEPLOY_URL}"
# Wait across brief edge DNS/TLS propagation windows when the custom domain is
# newly attached or rotated, without retrying if workers.dev already failed.
verify_custom_domain() {
  local attempts="${CUSTOM_DOMAIN_VERIFY_ATTEMPTS:-6}"
  local delay="${CUSTOM_DOMAIN_VERIFY_DELAY_SECONDS:-5}"
  local attempt=1

  if [ "$attempts" -lt 1 ]; then
    attempts=1
  fi

  while true; do
    if just verify-ingress "https://shunt-shim.gordon-pn.com"; then
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      return 1
    fi
    echo "Custom domain ingress check failed (attempt ${attempt}/${attempts}); retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

# Check both public ingress paths; a healthy workers.dev URL cannot mask a
# missing custom-domain DNS record, route, or TLS certificate.
verify_endpoints() {
  local mode="${1:-once}"
  local status=0
  just verify-ingress "${DEPLOY_URL}" || status=1
  if [ "$mode" = "retry" ] && [ "$status" -eq 0 ]; then
    verify_custom_domain || status=1
  else
    just verify-ingress "https://shunt-shim.gordon-pn.com" || status=1
  fi
  return "$status"
}

echo "Running post-deploy ingress verification..."
if ! verify_endpoints retry; then
  echo "Post-deploy ingress verification failed on production; rolling back to previous deployment..." >&2
  just rollback
  echo "Running post-rollback ingress verification..."
  if ! verify_endpoints once; then
    echo "Error: Post-rollback ingress verification also failed. Production remains unhealthy." >&2
    exit 1
  fi
  echo "Rollback restored healthy ingress, but exiting non-zero due to failed deployment." >&2
  exit 1
fi

echo "Production deployment and ingress verification succeeded."
