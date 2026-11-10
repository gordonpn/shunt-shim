import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const valid = {
  GATEWAY_TOKENS: "private-gateway",
  GROQ_API_KEY: "private-groq",
  GEMINI_API_KEY: "private-gemini",
};
function check(extra: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/check-env.mjs"],
    {
      env: { PATH: process.env.PATH, ...valid, ...extra },
      encoding: "utf8",
    },
  );
}
describe("Operator environment preflight (#75)", () => {
  it("accepts defaults and all valid optional settings", () => {
    expect(check({}).status).toBe(0);
    expect(
      check({
        PRIMARY_MODEL: "qwen/qwen3.8-27b",
        FALLBACK_MODEL: "gemini-2.5-flash-lite",
        PRIMARY_PROVIDER: "gemini",
        GROQ_BASE_URL: "https://api.groq.com/openai/v1",
        GEMINI_BASE_URL:
          "https://generativelanguage.googleapis.com/v1beta/openai",
      }).status,
    ).toBe(0);
  });
  it.each([
    ["PRIMARY_MODEL", "private-invalid"],
    ["FALLBACK_MODEL", ""],
    ["PRIMARY_PROVIDER", "unknown"],
    ["GROQ_BASE_URL", "http://private:password@example.com"],
    ["GEMINI_BASE_URL", "private-invalid"],
    ["GATEWAY_TOKENS", "   "],
    ["GROQ_API_KEY", undefined],
    ["GEMINI_API_KEY", ""],
  ])("rejects invalid %s without disclosing values", (name, value) => {
    const result = check({ [name]: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(result.stderr + result.stdout).not.toMatch(/private|password/);
  });
});
