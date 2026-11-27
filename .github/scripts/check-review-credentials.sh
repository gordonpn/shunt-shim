#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${REVIEW_GATEWAY_TOKEN:-}" && -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo '::error::Configure REVIEW_GATEWAY_TOKEN or DEEPSEEK_API_KEY in repository secrets.' >&2
  exit 1
fi
