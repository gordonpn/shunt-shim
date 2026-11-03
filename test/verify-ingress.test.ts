import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateToken } from "../scripts/generate-token.js";
import {
  type IngressVerifySummary,
  normalizeBaseUrl,
  parseArgs,
  reportSummary,
  runIngressVerification,
} from "../scripts/verify-ingress.js";
import { app } from "../src/index.js";

const mockEnv = {
  GATEWAY_TOKENS: "valid-test-token-xyz",
  GROQ_API_KEY: "test-groq-key",
  GEMINI_API_KEY: "test-gemini-key",
};

describe("Deployment and Ingress Verification (Task #38)", () => {
  describe("generateToken", () => {
    it("generates a 64-character lowercase hex string", () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique tokens across multiple invocations", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 50; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(50);
    });
  });

  describe("normalizeBaseUrl", () => {
    it("strips trailing slashes and trims whitespace", () => {
      expect(normalizeBaseUrl("http://localhost:8787/")).toBe(
        "http://localhost:8787",
      );
      expect(normalizeBaseUrl("https://example.workers.dev///  ")).toBe(
        "https://example.workers.dev",
      );
      expect(normalizeBaseUrl("http://127.0.0.1:8787")).toBe(
        "http://127.0.0.1:8787",
      );
    });
  });

  describe("parseArgs", () => {
    it("returns 'help' when -h or --help is passed", () => {
      expect(parseArgs(["-h"])).toBe("help");
      expect(parseArgs(["--help"])).toBe("help");
      expect(parseArgs(["http://localhost:8787", "--help"])).toBe("help");
    });

    it("returns 'invalid' when baseUrl is missing", () => {
      expect(parseArgs([])).toBe("invalid");
      expect(parseArgs(["--live"])).toBe("invalid");
      expect(parseArgs(["--token", "xyz"])).toBe("invalid");
    });

    it("parses baseUrl and options correctly", () => {
      const result = parseArgs([
        "http://localhost:8787",
        "--token",
        "secret-key",
        "--live",
        "--timeout",
        "5000",
      ]);

      expect(result).toEqual({
        baseUrl: "http://localhost:8787",
        token: "secret-key",
        live: true,
        timeoutMs: 5000,
      });
    });

    it("parses equals syntax for options", () => {
      const result = parseArgs([
        "http://localhost:8787",
        "--token=equal-secret",
        "--timeout=3000",
      ]);

      expect(result).toEqual({
        baseUrl: "http://localhost:8787",
        token: "equal-secret",
        timeoutMs: 3000,
      });
    });

    it("falls back to process.env.GATEWAY_TOKENS when token is not provided", () => {
      const originalEnv = process.env.GATEWAY_TOKENS;
      process.env.GATEWAY_TOKENS = "env-token-123";
      try {
        const result = parseArgs(["http://localhost:8787"]);
        expect(result).toEqual({
          baseUrl: "http://localhost:8787",
          token: "env-token-123",
        });
      } finally {
        if (originalEnv === undefined) {
          delete process.env.GATEWAY_TOKENS;
        } else {
          process.env.GATEWAY_TOKENS = originalEnv;
        }
      }
    });
  });

  describe("reportSummary", () => {
    it("returns 0 when all probes pass", () => {
      const summary: IngressVerifySummary = {
        total: 2,
        passed: 2,
        failed: 0,
        results: [
          {
            name: "Probe 1",
            passed: true,
            message: "OK",
            status: 200,
            durationMs: 5,
          },
          {
            name: "Probe 2",
            passed: true,
            message: "OK",
            status: 200,
            durationMs: 8,
          },
        ],
      };
      expect(reportSummary(summary)).toBe(0);
    });

    it("returns 1 when any probe fails", () => {
      const summary: IngressVerifySummary = {
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          {
            name: "Probe 1",
            passed: true,
            message: "OK",
            status: 200,
            durationMs: 5,
          },
          {
            name: "Probe 2",
            passed: false,
            message: "Failed",
            status: 500,
            durationMs: 12,
          },
        ],
      };
      expect(reportSummary(summary)).toBe(1);
    });
  });

  describe("runIngressVerification against Gateway Application", () => {
    const targetUrl = "https://gateway.test";
    const testToken = mockEnv.GATEWAY_TOKENS;

    beforeEach(() => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          const urlStr =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          // Handle upstream provider dispatches in live probe
          if (
            urlStr.includes("api.groq.com") ||
            urlStr.includes("generativelanguage.googleapis.com")
          ) {
            return new Response(
              JSON.stringify({
                id: "chatcmpl-mock-live-test",
                object: "chat.completion",
                created: 1712000000,
                model: "qwen/qwen3.8-27b",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "pong" },
                    finish_reason: "stop",
                  },
                ],
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Route to Hono gateway entrypoint
          const request = new Request(urlStr, init);
          return await app.fetch(request, mockEnv);
        },
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("verifies all standard probes pass against the real gateway application", async () => {
      const summary = await runIngressVerification({
        baseUrl: targetUrl,
        token: testToken,
      });

      expect(summary.total).toBe(11);
      expect(summary.passed).toBe(11);
      expect(summary.failed).toBe(0);
      for (const result of summary.results) {
        expect(result.passed).toBe(true);
      }
    });

    it("verifies unauthenticated probes pass when token is omitted", async () => {
      const summary = await runIngressVerification({
        baseUrl: targetUrl,
      });

      expect(summary.total).toBe(5);
      expect(summary.passed).toBe(5);
      expect(summary.failed).toBe(0);
    });

    it("verifies live probe succeeds when --live is enabled", async () => {
      const summary = await runIngressVerification({
        baseUrl: targetUrl,
        token: testToken,
        live: true,
      });

      expect(summary.total).toBe(12);
      expect(summary.passed).toBe(12);
      expect(summary.failed).toBe(0);
      const liveProbe = summary.results.find((r) =>
        r.name.includes("live end-to-end completion"),
      );
      expect(liveProbe).toBeDefined();
      expect(liveProbe?.passed).toBe(true);
      expect(liveProbe?.status).toBe(200);
    });

    it("fails when health check endpoint returns 500 error", async () => {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response(JSON.stringify({ error: "server error" }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "err-uuid",
          },
        });
      });

      const summary = await runIngressVerification({
        baseUrl: targetUrl,
        token: testToken,
      });

      expect(summary.failed).toBeGreaterThan(0);
      const healthProbe = summary.results.find((r) =>
        r.name.includes("root health probe"),
      );
      expect(healthProbe?.passed).toBe(false);
      expect(healthProbe?.status).toBe(500);
    });

    it("fails when health check response lacks x-request-id correlation header", async () => {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response(
          JSON.stringify({ status: "ok", service: "shunt-shim" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

      const summary = await runIngressVerification({
        baseUrl: targetUrl,
      });

      const healthProbe = summary.results.find((r) =>
        r.name.includes("root health probe"),
      );
      expect(healthProbe?.passed).toBe(false);
      expect(healthProbe?.message).toContain("Missing expected x-request-id");
    });

    it("reports failure when endpoint times out or is unreachable", async () => {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:1");
      });

      const summary = await runIngressVerification({
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 1000,
      });

      expect(summary.total).toBe(5);
      expect(summary.failed).toBe(5);
      for (const result of summary.results) {
        expect(result.passed).toBe(false);
        expect(result.message).toContain("connect ECONNREFUSED");
      }
    });
  });
});
