#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || ! -f "$1" || ! -r "$1" ]]; then
  echo "Usage: write-deepseek-review-prompt.sh <prompt-file>" >&2
  exit 2
fi

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
delimiter="DEEPSEEK_PROMPT_$$_${RANDOM}_${RANDOM}"
prompt="$(cat -- "$1")"

{
  printf 'prompt<<%s\n' "$delimiter"
  printf '%s\n' "$prompt"
  printf '%s\n' "$delimiter"
} >>"$GITHUB_OUTPUT"
