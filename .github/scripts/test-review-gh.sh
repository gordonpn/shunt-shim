#!/usr/bin/env bash
set -euo pipefail

echo "$*" >>"$REVIEW_TEST_API_CALLS"
[[ "$*" == 'api repos/gordonpn/shunt-shim/pulls/123' ]]
if [[ "${REVIEW_TEST_API_FAILURE:-false}" == true ]]; then
  echo 'Simulated GitHub API failure' >&2
  exit 1
fi
cat "$REVIEW_TEST_PR_FILE"
