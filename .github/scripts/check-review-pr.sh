#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pr_file="$(mktemp)"
trap 'rm -f "$pr_file"' EXIT

if [[ "$GITHUB_EVENT_NAME" == pull_request ]]; then
  jq -f "${script_dir}/review-pr-event.jq" "$GITHUB_EVENT_PATH" >"$pr_file"
else
  pr_number="$(jq -er -f "${script_dir}/review-pr-number.jq" "$GITHUB_EVENT_PATH")"
  gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" >"$pr_file"
fi

eligible="$(jq -r --arg repository "$GITHUB_REPOSITORY" -f "${script_dir}/review-eligible.jq" "$pr_file")"
echo "eligible=$eligible" >>"$GITHUB_OUTPUT"
