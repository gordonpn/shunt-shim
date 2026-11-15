import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSearchHttpError,
  SearchExecutionError,
  SearchTimeoutError,
} from "../src/search/errors.js";
import {
  routeSearchRequest,
  SEARCH_CONNECT_TIMEOUT_MS,
  SEARCH_TOTAL_DEADLINE_MS,
  type SearchProvider,
  SearchRouter,
  type SearchRouterEnv,
} from "../src/search/router.js";

const mockSearchEnv: SearchRouterEnv = {
  TAVILY_API_KEY: "tvly-test-key-123",
  EXA_API_KEY: "exa-test-key-456",
};

describe("Sequential Search Fallback Router (Story #138)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("Primary Provider Success (No Fallback)", () => {
    it("returns Tavily results immediately and does not call Exa when Tavily succeeds", async () => {
      const tavilySpy = vi.fn(async () => ({
        id: "tvly-req-1",
        results: [
          {
            title: "Cloudflare Workers Docs",
            url: "https://developers.cloudflare.com/workers",
            snippet: "Build serverless applications on Cloudflare's network.",
            score: 0.98,
          },
        ],
        creditsUsed: 1,
      }));
      const exaSpy = vi.fn();

      const router = new SearchRouter([
        { id: "tavily", search: tavilySpy },
        { id: "exa", search: exaSpy },
      ]);

      const result = await router.route(
        { query: "cloudflare workers" },
        mockSearchEnv,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.provider).toBe("tavily");
        expect(result.data.query).toBe("cloudflare workers");
        expect(result.data.results).toHaveLength(1);
        expect(result.data.usage.credits).toBe(1);
        expect(result.diagnostic).toEqual({
          provider: "tavily",
          attempts: 1,
          fallbackOccurred: false,
        });
      }
      expect(tavilySpy).toHaveBeenCalledTimes(1);
      expect(exaSpy).not.toHaveBeenCalled();
    });
  });

  describe("Eligible Primary Failures Triggering Sequential Fallback to Exa", () => {
    const eligiblePrimaryFailures = [
      {
        label: "HTTP 429 Too Many Requests",
        error: () => createSearchHttpError(429, "tavily", "10"),
        expectedReason: "rate_limit_exceeded",
      },
      {
        label: "HTTP 402 Quota Exceeded",
        error: () => createSearchHttpError(402, "tavily"),
        expectedReason: "quota_exceeded",
      },
      {
        label: "HTTP 503 Service Unavailable",
        error: () => createSearchHttpError(503, "tavily"),
        expectedReason: "upstream_unavailable",
      },
      {
        label: "5s Connection Timeout",
        error: () =>
          new SearchTimeoutError(
            "Search provider 'tavily' timed out after 5000ms",
            "tavily",
          ),
        expectedReason: "upstream_timeout",
      },
      {
        label: "Network TypeError",
        error: () => new TypeError("fetch failed: socket hang up"),
        expectedReason: "network_error",
      },
    ];

    for (const testCase of eligiblePrimaryFailures) {
      it(`falls back to Exa and returns provider="exa" when Tavily fails with ${testCase.label}`, async () => {
        const tavilyProvider: SearchProvider = {
          id: "tavily",
          search: async () => {
            throw testCase.error();
          },
        };

        const exaProvider: SearchProvider = {
          id: "exa",
          search: async () => ({
            id: "exa-req-99",
            results: [
              {
                title: "Exa Search Result",
                url: "https://exa.ai/result",
                snippet: "Fallback search result served by Exa.",
              },
            ],
            creditsUsed: 1,
          }),
        };

        const result = await routeSearchRequest(
          { query: "resilient web search" },
          [tavilyProvider, exaProvider],
          mockSearchEnv,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.provider).toBe("exa");
          expect(result.data.id).toBe("exa-req-99");
          expect(result.data.results[0]?.url).toBe("https://exa.ai/result");
          expect(result.diagnostic).toEqual({
            provider: "exa",
            attempts: 2,
            fallbackOccurred: true,
            fallbackReason: testCase.expectedReason,
          });
        }
      });
    }

    it("aborts a hanging primary fetch after 5s and succeeds via Exa fallback using default HTTP adapters", async () => {
      vi.useFakeTimers();

      const calledUrls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          calledUrls.push(url);

          if (new URL(url).hostname === "api.tavily.com") {
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(
                  new DOMException("Connection timed out", "TimeoutError"),
                );
              });
            });
          }

          return new Response(
            JSON.stringify({
              requestId: "exa-http-1",
              results: [
                {
                  title: "Exa HTTP Fallback",
                  url: "https://exa.ai/docs",
                  text: "Exa neural search documentation.",
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      );

      const router = new SearchRouter();
      const routePromise = router.route(
        { query: "timeout failover test" },
        mockSearchEnv,
      );

      await vi.advanceTimersByTimeAsync(SEARCH_CONNECT_TIMEOUT_MS);
      const result = await routePromise;

      expect(calledUrls).toEqual([
        "https://api.tavily.com/search",
        "https://api.exa.ai/search",
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.provider).toBe("exa");
        expect(result.data.results[0]?.snippet).toBe(
          "Exa neural search documentation.",
        );
        expect(result.diagnostic.fallbackOccurred).toBe(true);
        expect(result.diagnostic.fallbackReason).toBe("upstream_timeout");
      }
    });
  });

  describe("Terminal Primary Failures (Fallback Prohibited)", () => {
    it("aborts immediately on HTTP 400 Bad Request without calling Exa", async () => {
      const exaSpy = vi.fn();
      const result = await routeSearchRequest(
        { query: "invalid query params" },
        [
          {
            id: "tavily",
            search: async () => {
              throw createSearchHttpError(
                400,
                "tavily",
                null,
                "Invalid search_depth parameter",
              );
            },
          },
          { id: "exa", search: exaSpy },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.code).toBe("bad_request");
        expect(result.diagnostic.attempts).toBe(1);
        expect(result.diagnostic.fallbackOccurred).toBe(false);
      }
      expect(exaSpy).not.toHaveBeenCalled();
    });

    it("aborts immediately on HTTP 401 Unauthorized without calling Exa", async () => {
      const exaSpy = vi.fn();
      const result = await routeSearchRequest(
        { query: "unauthorized query" },
        [
          {
            id: "tavily",
            search: async () => {
              throw createSearchHttpError(401, "tavily");
            },
          },
          { id: "exa", search: exaSpy },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.error.error.code).toBe("invalid_api_key");
        expect(result.diagnostic.attempts).toBe(1);
        expect(result.diagnostic.fallbackOccurred).toBe(false);
      }
      expect(exaSpy).not.toHaveBeenCalled();
    });

    it("filters out providers requiring a credit card when FREE_ONLY_POLICY is active", async () => {
      const paidProviderSpy = vi.fn();
      const exaSpy = vi.fn(async () => ({
        id: "exa-free-1",
        results: [
          {
            title: "Free Tier Result",
            url: "https://exa.ai/free",
            snippet: "No credit card required.",
          },
        ],
      }));

      const result = await routeSearchRequest(
        { query: "free tier routing" },
        [
          {
            id: "paid-provider",
            requiresCreditCard: true,
            search: paidProviderSpy,
          },
          {
            id: "exa",
            requiresCreditCard: false,
            search: exaSpy,
          },
        ],
        { ...mockSearchEnv, FREE_ONLY_POLICY: "true" },
      );

      expect(paidProviderSpy).not.toHaveBeenCalled();
      expect(exaSpy).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.provider).toBe("exa");
        expect(result.diagnostic.attempts).toBe(1);
      }
    });
  });

  describe("30s Total Wall-Clock Deadline Enforcement", () => {
    it("aborts remaining fallback attempts and returns HTTP 504 when the 30s total deadline expires", async () => {
      let simulatedClockMs = 1_000;
      const exaSpy = vi.fn();

      const slowFailingPrimary: SearchProvider = {
        id: "tavily",
        search: async () => {
          simulatedClockMs += SEARCH_TOTAL_DEADLINE_MS;
          throw createSearchHttpError(503, "tavily");
        },
      };

      const exaFallback: SearchProvider = {
        id: "exa",
        search: exaSpy,
      };

      const result = await routeSearchRequest(
        { query: "deadline exhaustion" },
        [slowFailingPrimary, exaFallback],
        mockSearchEnv,
        {
          now: () => simulatedClockMs,
          totalDeadlineMs: SEARCH_TOTAL_DEADLINE_MS,
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.error.error.code).toBe("gateway_timeout");
        expect(result.error.error.message).toContain("deadline exceeded");
        expect(result.diagnostic.attempts).toBe(1);
        expect(result.diagnostic.fallbackReason).toBe("upstream_unavailable");
      }
      expect(exaSpy).not.toHaveBeenCalled();
    });
  });

  describe("Structured Error Envelope When All Providers Fail", () => {
    it("returns HTTP 429 with preserved Retry-After header when all providers are rate-limited", async () => {
      const result = await routeSearchRequest(
        { query: "rate limited everywhere" },
        [
          {
            id: "tavily",
            search: async () => {
              throw createSearchHttpError(429, "tavily", "12");
            },
          },
          {
            id: "exa",
            search: async () => {
              throw createSearchHttpError(429, "exa", "30");
            },
          },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(429);
        expect(result.headers?.["Retry-After"]).toBe("30");
        expect(result.error).toEqual({
          error: {
            message:
              "All upstream search providers exceeded rate limits or quota",
            type: "invalid_request_error",
            param: null,
            code: "rate_limit_exceeded",
          },
        });
        expect(result.diagnostic).toEqual({
          provider: "exa",
          attempts: 2,
          fallbackOccurred: true,
          fallbackReason: "rate_limit_exceeded",
        });
      }
    });

    it("returns HTTP 502 bad_gateway when primary fails with 429 and fallback fails with invalid payload", async () => {
      const result = await routeSearchRequest(
        { query: "bad gateway after fallback" },
        [
          {
            id: "tavily",
            search: async () => {
              throw createSearchHttpError(429, "tavily");
            },
          },
          {
            id: "exa",
            search: async () => {
              throw new SearchExecutionError("Invalid upstream JSON", {
                status: 502,
                reason: "invalid_upstream_response",
                provider: "exa",
              });
            },
          },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(502);
        expect(result.error.error.code).toBe("bad_gateway");
        expect(result.diagnostic.attempts).toBe(2);
        expect(result.diagnostic.fallbackOccurred).toBe(true);
        expect(result.diagnostic.fallbackReason).toBe("rate_limit_exceeded");
      }
    });

    it("returns HTTP 504 gateway_timeout when all providers time out", async () => {
      const result = await routeSearchRequest(
        { query: "all providers timeout" },
        [
          {
            id: "tavily",
            search: async () => {
              throw new SearchTimeoutError("Tavily timed out", "tavily");
            },
          },
          {
            id: "exa",
            search: async () => {
              throw new SearchTimeoutError("Exa timed out", "exa");
            },
          },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.error.error.code).toBe("gateway_timeout");
        expect(result.diagnostic).toEqual({
          provider: "exa",
          attempts: 2,
          fallbackOccurred: true,
          fallbackReason: "upstream_timeout",
        });
      }
    });
  });
});
