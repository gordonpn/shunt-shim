#!/usr/bin/env bash
set -euo pipefail

log=$(mktemp)
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
  fi
  cat "$log"
  rm -f "$log"
}
trap cleanup EXIT

just dev --ip 127.0.0.1 --port 8787 >"$log" 2>&1 &
server_pid=$!

curl --fail --silent --show-error --retry 30 --retry-connrefused \
  --retry-delay 1 --retry-max-time 30 --max-time 2 \
  http://127.0.0.1:8787/health | grep -Fx '{"status":"ok","service":"shunt-shim"}'
