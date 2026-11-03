# shunt-shim project task runner

set dotenv-load
set dotenv-filename := ".dev.vars"

default:
    @just --list

# Check documentation diff formatting
check-docs:
    git diff --check
    git diff --cached --check

# Resolve deterministic OCR coverage and review rules
review-docs:
    ocr delegate preview --format json
    ocr delegate rule --format json Justfile README.md docs/MVP.md docs/COMPATIBILITY.md docs/ARCHITECTURE.md docs/CONFIGURATION.md docs/RUNBOOK.md docs/adr/*.md docs/GROQ_CAPABILITY.md docs/GEMINI_CAPABILITY.md

# Start local edge development server using wrangler
dev *args:
    pnpm exec wrangler dev {{ args }}

# Build edge worker bundle for deployment verification
build:
    pnpm run build

# Format source files using Biome
format:
    pnpm run format

# Check formatting without modifying files
check-format:
    pnpm run format:check

# Lint source files using Biome
lint:
    pnpm run lint

# Generate a cryptographically secure random token for GATEWAY_TOKENS
generate-token:
    @node --experimental-strip-types scripts/generate-token.ts

# Provision runtime secrets from environment to Cloudflare Workers
provision-secrets: check-secrets
    @printf "%s" "$GEMINI_API_KEY" | pnpm exec wrangler secret put GEMINI_API_KEY
    @printf "%s" "$GROQ_API_KEY" | pnpm exec wrangler secret put GROQ_API_KEY
    @printf "%s" "$GATEWAY_TOKENS" | pnpm exec wrangler secret put GATEWAY_TOKENS

# Deploy edge worker to Cloudflare
deploy:
    pnpm exec wrangler deploy

# Inspect deployment history
deployments:
    pnpm exec wrangler deployments list

# Rollback worker deployment to previous or specified version
rollback deployment_id="":
    pnpm exec wrangler rollback {{ if deployment_id != "" { deployment_id } else { "" } }} -y

# Verify ingress endpoints and conformance
verify-ingress url:
    node --experimental-strip-types scripts/verify-ingress.ts {{ url }}

# Verify ingress endpoints with live end-to-end chat completion
verify-ingress-live url:
    node --experimental-strip-types scripts/verify-ingress.ts {{ url }} --live

# Inspect real-time edge runtime logs
tail:
    pnpm exec wrangler tail

# Validate environment secrets
check-secrets:
    @status=0; \
    if [ -z "${GATEWAY_TOKENS:-}" ]; then \
        echo "Missing required environment variable: GATEWAY_TOKENS" >&2; \
        status=1; \
    fi; \
    if [ -z "${GEMINI_API_KEY:-}" ]; then \
        echo "Missing required environment variable: GEMINI_API_KEY" >&2; \
        status=1; \
    fi; \
    if [ -z "${GROQ_API_KEY:-}" ]; then \
        echo "Missing required environment variable: GROQ_API_KEY" >&2; \
        status=1; \
    fi; \
    exit $status

# Verify secret check behavior against edge cases
test-secrets:
    bash .github/scripts/test-check-secrets.sh

# Validate repository automation without application code or secrets
check-workflows: lint-workflows test-secrets
    grep -Eq '^[[:space:]]*"enable_request_signal"' wrangler.jsonc
    shellcheck .github/scripts/*.sh
    git diff --check $(git hash-object -t tree /dev/null)
    git diff --cached --check

lint-workflows:
    actionlint

# Imported pnpm gates run in CI only when the project files exist
install-ci:
    pnpm install --frozen-lockfile

typecheck:
    pnpm run typecheck

test:
    pnpm test

test-coverage:
    pnpm run test:coverage

review-biome:
    bash .github/scripts/biome-review.sh

review-workflows:
    ocr delegate preview --format json
    ocr delegate rule --format json .github/workflows/*.yml .github/scripts/*.sh Justfile mise.toml README.md docs/AUTOMATION.md .pr_agent.toml

# Resolve deterministic OCR coverage and review rules for source code
review-code:
    ocr delegate preview --format json
    ocr delegate rule --format json package.json tsconfig.json biome.json wrangler.jsonc vitest.config.ts src/*.ts test/*.ts scripts/*.ts
