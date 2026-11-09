#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "Cloudflare credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) not configured. Skipping preview deployment."
  exit 0
fi

ARG="${1:-}"
ALIAS=""
if [ -n "$ARG" ]; then
  if [[ "$ARG" =~ ^[0-9]+$ ]]; then
    ALIAS="pr-${ARG}"
  else
    ALIAS="$ARG"
  fi
fi

if [ -n "$ALIAS" ]; then
  echo "Deploying preview version with alias: ${ALIAS}..."
  if ! OUTPUT=$(just deploy-preview "${ALIAS}" 2>&1); then
    echo "${OUTPUT}"
    echo "Error: Preview deployment command failed." >&2
    exit 1
  fi
else
  echo "Deploying preview version..."
  if ! OUTPUT=$(just deploy-preview 2>&1); then
    echo "${OUTPUT}"
    echo "Error: Preview deployment command failed." >&2
    exit 1
  fi
fi
echo "${OUTPUT}"

PREVIEW_URL=$(echo "${OUTPUT}" | sed -n 's/.*Version Preview Alias URL:[[:space:]]*\(https:\/\/[^[:space:]]*\).*/\1/p')
if [ -z "$PREVIEW_URL" ]; then
  PREVIEW_URL=$(echo "${OUTPUT}" | sed -n 's/.*Version Preview URL:[[:space:]]*\(https:\/\/[^[:space:]]*\).*/\1/p')
fi
if [ -z "$PREVIEW_URL" ]; then
  PREVIEW_URL=$(echo "${OUTPUT}" | grep -E -o 'https://[^[:space:]]+workers\.dev' | head -n 1 || true)
fi

if [ -z "$PREVIEW_URL" ]; then
  echo "Error: Could not extract preview URL from deployment output." >&2
  exit 1
fi

echo "Preview deployed successfully: ${PREVIEW_URL}"
echo "Running post-deploy ingress verification..."
just verify-ingress "${PREVIEW_URL}"
