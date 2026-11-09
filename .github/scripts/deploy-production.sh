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
echo "Running post-deploy ingress verification..."
if ! just verify-ingress "${DEPLOY_URL}"; then
  echo "Post-deploy ingress verification failed on production; rolling back to previous deployment..." >&2
  just rollback
  echo "Running post-rollback ingress verification..."
  if ! just verify-ingress "${DEPLOY_URL}"; then
    echo "Error: Post-rollback ingress verification also failed. Production remains unhealthy." >&2
    exit 1
  fi
  echo "Rollback restored healthy ingress, but exiting non-zero due to failed deployment." >&2
  exit 1
fi

echo "Production deployment and ingress verification succeeded."
