#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

prompt_file="${repo_dir}/.github/prompts/deepseek-review.md"
output_file="${tmp_dir}/github_output"
script="${repo_dir}/.github/scripts/write-deepseek-review-prompt.sh"

GITHUB_OUTPUT="$output_file" "$script" "$prompt_file"

delimiter="$(sed -n 's/^prompt<<//p' "$output_file")"
[[ "$delimiter" =~ ^DEEPSEEK_PROMPT_[0-9]+_[0-9]+_[0-9]+$ ]]
[[ "$(sed '1d;$d' "$output_file")" == "$(cat "$prompt_file")" ]]

assert_failure() {
  local expected_status="$1" expected_message="$2" status=0
  shift 2
  "$@" >"${tmp_dir}/stdout" 2>"${tmp_dir}/stderr" || status=$?
  [[ "$status" -eq "$expected_status" ]]
  [[ ! -s "${tmp_dir}/stdout" ]]
  grep -Fq "$expected_message" "${tmp_dir}/stderr"
}

assert_failure 2 "Usage:" env GITHUB_OUTPUT="$output_file" "$script"
assert_failure 2 "Usage:" env GITHUB_OUTPUT="$output_file" "$script" "${tmp_dir}/missing.md"
assert_failure 2 "Usage:" env GITHUB_OUTPUT="$output_file" "$script" "$tmp_dir"
assert_failure 1 "GITHUB_OUTPUT is required" env -u GITHUB_OUTPUT "$script" "$prompt_file"

no_newline_file="${tmp_dir}/no-newline.md"
printf 'A prompt without a trailing newline' >"$no_newline_file"
: >"$output_file"
GITHUB_OUTPUT="$output_file" "$script" "$no_newline_file"
[[ "$(sed '1d;$d' "$output_file")" == "A prompt without a trailing newline" ]]

echo "deepseek-review-prompt checks passed"
