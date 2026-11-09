#!/usr/bin/env bash
set -euo pipefail

# Just loads .dev.vars without evaluating it as shell code.
# Upstream credentials must not be inherited by GitHub CLI subprocesses.
unset GROQ_API_KEY GEMINI_API_KEY

if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub CLI (gh) is required; install it and run gh auth login.' >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo 'GitHub CLI authentication failed; run gh auth login.' >&2
  exit 1
fi
if [[ ! -f .dev.vars ]]; then
  echo 'Missing .dev.vars; create it with the required GitHub Actions secrets.' >&2
  exit 1
fi

names=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GATEWAY_TOKENS)
status=0
for name in "${names[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "$name" >&2
    status=1
  fi
done
[[ "$status" == 0 ]] || exit 1

for name in "${names[@]}"; do
  # Suppress CLI diagnostics too: they are not guaranteed to redact stdin.
  if ! printf '%s' "${!name}" | gh secret set "$name" >/dev/null 2>&1; then
    printf 'Failed to synchronize %s; check repository access and retry. Earlier writes may have succeeded.\n' "$name" >&2
    exit 1
  fi
  printf 'Synchronized %s\n' "$name"
done
