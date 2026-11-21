#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${script_dir}/check-review-credentials.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
ln -s "${script_dir}/test-review-gh.sh" "${tmp_dir}/gh"

if REVIEW_GATEWAY_TOKEN='' DEEPSEEK_API_KEY='' bash "$script" 2>"${tmp_dir}/stderr"; then
  echo 'Missing credentials unexpectedly passed' >&2
  exit 1
fi
grep -Fq 'Configure REVIEW_GATEWAY_TOKEN or DEEPSEEK_API_KEY' "${tmp_dir}/stderr"
if env -u REVIEW_GATEWAY_TOKEN -u DEEPSEEK_API_KEY bash "$script" 2>"${tmp_dir}/stderr"; then
  echo 'Unset credentials unexpectedly passed' >&2
  exit 1
fi
grep -Fq 'Configure REVIEW_GATEWAY_TOKEN or DEEPSEEK_API_KEY' "${tmp_dir}/stderr"
REVIEW_GATEWAY_TOKEN=test DEEPSEEK_API_KEY='' bash "$script"
REVIEW_GATEWAY_TOKEN='' DEEPSEEK_API_KEY=test bash "$script"
REVIEW_GATEWAY_TOKEN=test DEEPSEEK_API_KEY=test bash "$script"
jq -r -f "${script_dir}/test-review-eligible.jq" "${script_dir}/test-review-eligible.json" >"${tmp_dir}/cases"
while IFS= read -r test_case; do
  expected="$(jq -r '.[2]' <<<"$test_case")"
  actual="$(jq '.[1]' <<<"$test_case" | jq -r --arg repository gordonpn/shunt-shim -f "${script_dir}/review-eligible.jq")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Eligibility case failed: $test_case" >&2
    exit 1
  fi
  jq '.[1]' <<<"$test_case" >"${tmp_dir}/pr.json"
  jq -f "${script_dir}/test-review-event.jq" <<<"$test_case" >"${tmp_dir}/event.json"
  for event_name in pull_request issue_comment; do
    : >"${tmp_dir}/output"
    PATH="${tmp_dir}:$PATH" REVIEW_TEST_PR_FILE="${tmp_dir}/pr.json" \
      GITHUB_REPOSITORY=gordonpn/shunt-shim GITHUB_EVENT_NAME="$event_name" \
      GITHUB_EVENT_PATH="${tmp_dir}/event.json" GITHUB_OUTPUT="${tmp_dir}/output" \
      bash "${script_dir}/check-review-pr.sh"
    [[ "$(cat "${tmp_dir}/output")" == "eligible=$expected" ]]
  done
done <"${tmp_dir}/cases"
: >"${tmp_dir}/output"
if PATH="${tmp_dir}:$PATH" REVIEW_TEST_API_FAILURE=true \
  GITHUB_REPOSITORY=gordonpn/shunt-shim GITHUB_EVENT_NAME=issue_comment \
  GITHUB_EVENT_PATH="${script_dir}/test-review-api-failure.json" GITHUB_OUTPUT="${tmp_dir}/output" \
  bash "${script_dir}/check-review-pr.sh" 2>"${tmp_dir}/stderr"; then
  echo 'Failed API lookup unexpectedly passed' >&2
  exit 1
fi
grep -Fq 'Simulated GitHub API failure' "${tmp_dir}/stderr"
[[ ! -s "${tmp_dir}/output" ]]
echo 'review credential checks passed'
