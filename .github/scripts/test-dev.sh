#!/usr/bin/env bash
# Exercise the configured Worker entrypoint in the real local runtime, without secrets.
set -euo pipefail

cd "$(dirname "$0")/../.."
log_file=$(mktemp)
worker_pid=""
# Called indirectly by the EXIT trap; resetting that trap below confuses ShellCheck.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$worker_pid" ]]; then
    kill -- "-$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  if [[ "$status" -ne 0 ]]; then
    cat "$log_file" >&2
  fi
  rm -f "$log_file"
  exit "$status"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A process group lets cleanup stop Wrangler and its workerd child together.
WRANGLER_SEND_METRICS=false setsid pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8797 >"$log_file" 2>&1 &
worker_pid=$!
for _ in {1..60}; do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "Local Worker exited before readiness" >&2
    exit 1
  fi
  if curl --fail --silent --max-time 1 http://127.0.0.1:8797/health >/dev/null; then
    pnpm run verify-ingress http://127.0.0.1:8797
    exit 0
  fi
  sleep 0.5
done
echo "Local Worker did not become ready within the startup deadline" >&2
exit 1
