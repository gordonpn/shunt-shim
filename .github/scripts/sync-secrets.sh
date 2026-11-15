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

resolve_value() {
  local primary="$1"
  local fallback="$2"
  if [[ -n "${!primary+x}" ]]; then
    printf '%s' "${!primary}"
  else
    printf '%s' "${!fallback:-}"
  fi
}

cf_token=$(resolve_value CLOUDFLARE_PRODUCTION_API_TOKEN CLOUDFLARE_API_TOKEN)
cf_account=$(resolve_value CLOUDFLARE_PRODUCTION_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID)
gw_tokens=$(resolve_value PRODUCTION_GATEWAY_TOKENS GATEWAY_TOKENS)

validate_secret() {
  local primary="$1"
  local fallback="$2"
  local val="$3"
  if [[ -n "${val//[[:space:]]/}" ]]; then
    return 0
  fi
  if [[ -n "${!primary+x}" ]]; then
    printf 'Missing required environment variable: %s\n' "$primary" >&2
  else
    printf 'Missing required environment variable: %s (or %s)\n' "$primary" "$fallback" >&2
  fi
  return 1
}

status=0
validate_secret CLOUDFLARE_PRODUCTION_API_TOKEN CLOUDFLARE_API_TOKEN "$cf_token" || status=1
validate_secret CLOUDFLARE_PRODUCTION_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID "$cf_account" || status=1
validate_secret PRODUCTION_GATEWAY_TOKENS GATEWAY_TOKENS "$gw_tokens" || status=1
[[ "$status" == 0 ]] || exit 1

if ! gh api -X PUT 'repos/{owner}/{repo}/environments/production' \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true' >/dev/null 2>&1; then
  echo 'Failed to configure production environment deployment branch policy.' >&2
  exit 1
fi

policies=$(gh api 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
  --jq '.branch_policies[] | "\(.id)\t\(.name)\t\(.type)"')
has_main=false
while IFS=$'\t' read -r policy_id policy_name policy_type; do
  [[ -n "$policy_id" ]] || continue
  if [[ "$policy_name" == 'main' && "$policy_type" == 'branch' ]]; then
    has_main=true
  elif ! gh api -X DELETE "repos/{owner}/{repo}/environments/production/deployment-branch-policies/${policy_id}" >/dev/null 2>&1; then
    printf 'Failed to remove non-main deployment policy %s (%s) from production environment.\n' "$policy_name" "$policy_type" >&2
    exit 1
  fi
done <<< "$policies"

if [[ "$has_main" != true ]]; then
  if ! gh api -X POST 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
    -f name=main -f type=branch >/dev/null 2>&1; then
    echo 'Failed to add main deployment branch policy to production environment.' >&2
    exit 1
  fi
fi

sync_env_secret() {
  local name="$1"
  local value="$2"
  # Suppress CLI diagnostics too: they are not guaranteed to redact stdin.
  if ! printf '%s' "$value" | gh secret set --env production "$name" >/dev/null 2>&1; then
    printf 'Failed to synchronize %s; check repository access and retry. Earlier writes may have succeeded.\n' "$name" >&2
    exit 1
  fi
  printf 'Synchronized %s\n' "$name"
}

sync_env_secret CLOUDFLARE_PRODUCTION_API_TOKEN "$cf_token"
sync_env_secret CLOUDFLARE_PRODUCTION_ACCOUNT_ID "$cf_account"
sync_env_secret PRODUCTION_GATEWAY_TOKENS "$gw_tokens"

repo_secrets=$(gh secret list --json name --jq '.[].name')
while IFS= read -r existing; do
  case "$existing" in
    CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|GATEWAY_TOKENS)
      if ! gh secret delete "$existing" >/dev/null 2>&1; then
        printf 'Failed to remove legacy repository secret %s.\n' "$existing" >&2
        exit 1
      fi
      printf 'Removed legacy repository secret %s\n' "$existing"
      ;;
  esac
done <<< "$repo_secrets"
