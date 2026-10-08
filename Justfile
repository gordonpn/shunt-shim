# shunt-shim project task runner

default:
    @just --list

# Check documentation diff formatting
check-docs:
    git diff --check
    git diff --cached --check

# Resolve deterministic OCR coverage and review rules
review-docs:
    ocr delegate preview --format json
    ocr delegate rule --format json Justfile README.md docs/MVP.md docs/COMPATIBILITY.md docs/ARCHITECTURE.md docs/CONFIGURATION.md docs/RUNBOOK.md

# Start local edge development server using wrangler
dev:
    bunx wrangler dev

# Deploy edge worker to Cloudflare
deploy:
    bunx wrangler deploy

# Inspect real-time edge runtime logs
tail:
    bunx wrangler tail

# Validate environment secrets
check-secrets:
    @test -n "$$GEMINI_API_KEY" || echo "GEMINI_API_KEY is not set"
    @test -n "$$GROQ_API_KEY" || echo "GROQ_API_KEY is not set"
    @test -n "$$OPENROUTER_API_KEY" || echo "OPENROUTER_API_KEY is not set"
