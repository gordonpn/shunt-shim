#!/usr/bin/env bash
set -euo pipefail

# Deterministic verification of just check-secrets behavior across
# environment variables, .dev.vars, empty strings, and secret redaction.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cp "$REPO_ROOT/Justfile" "$TMP_DIR/Justfile"

# 1. All required variables absent in environment and no .dev.vars
rm -f "$TMP_DIR/.dev.vars"
set +e
output=$(env -i PATH="$PATH" HOME="$HOME" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected check-secrets to fail when all required variables are absent" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GATEWAY_TOKENS"; then
  echo "Expected diagnostic for GATEWAY_TOKENS missing" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GEMINI_API_KEY"; then
  echo "Expected diagnostic for GEMINI_API_KEY missing" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GROQ_API_KEY"; then
  echo "Expected diagnostic for GROQ_API_KEY missing" >&2
  exit 1
fi

# 2. Individual missing variables
# 2a. GATEWAY_TOKENS missing
set +e
output=$(env -i PATH="$PATH" HOME="$HOME" \
  GEMINI_API_KEY="dummy-gemini" \
  GROQ_API_KEY="dummy-groq" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "Expected check-secrets to fail when GATEWAY_TOKENS is missing" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GATEWAY_TOKENS"; then
  echo "Expected diagnostic for GATEWAY_TOKENS missing" >&2
  exit 1
fi
if echo "$output" | grep -q "GEMINI_API_KEY"; then
  echo "Unexpected diagnostic for GEMINI_API_KEY when provided" >&2
  exit 1
fi

# 2b. GEMINI_API_KEY missing
set +e
output=$(env -i PATH="$PATH" HOME="$HOME" \
  GATEWAY_TOKENS="dummy-token" \
  GROQ_API_KEY="dummy-groq" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "Expected check-secrets to fail when GEMINI_API_KEY is missing" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GEMINI_API_KEY"; then
  echo "Expected diagnostic for GEMINI_API_KEY missing" >&2
  exit 1
fi

# 2c. GROQ_API_KEY missing
set +e
output=$(env -i PATH="$PATH" HOME="$HOME" \
  GATEWAY_TOKENS="dummy-token" \
  GEMINI_API_KEY="dummy-gemini" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "Expected check-secrets to fail when GROQ_API_KEY is missing" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GROQ_API_KEY"; then
  echo "Expected diagnostic for GROQ_API_KEY missing" >&2
  exit 1
fi

# 3. Empty string variable values fail validation
set +e
output=$(env -i PATH="$PATH" HOME="$HOME" \
  GATEWAY_TOKENS="" \
  GEMINI_API_KEY="dummy-gemini" \
  GROQ_API_KEY="dummy-groq" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "Expected check-secrets to fail when GATEWAY_TOKENS is empty" >&2
  exit 1
fi
if ! echo "$output" | grep -q "Missing required environment variable: GATEWAY_TOKENS"; then
  echo "Expected diagnostic for empty GATEWAY_TOKENS" >&2
  exit 1
fi

# 4. All required variables present via environment
DUMMY_GW="secret-gateway-token-alpha"
DUMMY_GEM="secret-gemini-key-bravo"
DUMMY_GROQ="secret-groq-key-charlie"

output=$(env -i PATH="$PATH" HOME="$HOME" \
  GATEWAY_TOKENS="$DUMMY_GW" \
  GEMINI_API_KEY="$DUMMY_GEM" \
  GROQ_API_KEY="$DUMMY_GROQ" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)

# Verify secrets are never leaked in output
if echo "$output" | grep -E -q "$DUMMY_GW|$DUMMY_GEM|$DUMMY_GROQ"; then
  echo "Secrets leaked in command output" >&2
  exit 1
fi

# 5. All required variables loaded via .dev.vars
cat <<EOF > "$TMP_DIR/.dev.vars"
GATEWAY_TOKENS="$DUMMY_GW"
GEMINI_API_KEY="$DUMMY_GEM"
GROQ_API_KEY="$DUMMY_GROQ"
EOF

output=$(env -i PATH="$PATH" HOME="$HOME" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)

if echo "$output" | grep -E -q "$DUMMY_GW|$DUMMY_GEM|$DUMMY_GROQ"; then
  echo "Secrets from .dev.vars leaked in command output" >&2
  exit 1
fi
rm -f "$TMP_DIR/.dev.vars"

# 6. Optional OPENROUTER_API_KEY
DUMMY_OR="secret-openrouter-key-delta"
# 6a. Absent OPENROUTER_API_KEY passes
env -i PATH="$PATH" HOME="$HOME" \
  GATEWAY_TOKENS="$DUMMY_GW" \
  GEMINI_API_KEY="$DUMMY_GEM" \
  GROQ_API_KEY="$DUMMY_GROQ" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets >/dev/null

# 6b. Present OPENROUTER_API_KEY passes without leaking
output=$(env -i PATH="$PATH" HOME="$HOME" \
  GATEWAY_TOKENS="$DUMMY_GW" \
  GEMINI_API_KEY="$DUMMY_GEM" \
  GROQ_API_KEY="$DUMMY_GROQ" \
  OPENROUTER_API_KEY="$DUMMY_OR" \
  just --justfile "$TMP_DIR/Justfile" --working-directory "$TMP_DIR" check-secrets 2>&1)

if echo "$output" | grep -q "$DUMMY_OR"; then
  echo "Optional OPENROUTER_API_KEY leaked in command output" >&2
  exit 1
fi

echo "All check-secrets test cases passed successfully."
