import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSearchHttpError,
  SearchExecutionError,
  SearchTimeoutError,
} from "../src/search/errors.js";
import {
  createExaProvider,
  createTavilyProvider,
  filterEligibleSearchProviders,
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

    it("returns HTTP 503 service_unavailable when all providers fail with 503", async () => {
      const result = await routeSearchRequest(
        { query: "all 503" },
        [
          {
            id: "tavily",
            search: async () => {
              throw createSearchHttpError(503, "tavily");
            },
          },
          {
            id: "exa",
            search: async () => {
              throw createSearchHttpError(503, "exa");
            },
          },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(503);
        expect(result.error.error.code).toBe("service_unavailable");
      }
    });

    it("omits Retry-After header when all providers fail with 429 without Retry-After", async () => {
      const result = await routeSearchRequest(
        { query: "429 no retry-after" },
        [
          {
            id: "tavily",
            search: async () => {
              throw createSearchHttpError(429, "tavily");
            },
          },
        ],
        mockSearchEnv,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(429);
        expect(result.headers).toBeUndefined();
      }
    });

    it("returns HTTP 403 for forbidden and policy_quarantine terminal errors without calling fallback", async () => {
      const exaSpy = vi.fn();

      const forbiddenResult = await routeSearchRequest({ query: "forbidden" }, [
        {
          id: "tavily",
          search: async () => {
            throw new SearchExecutionError("", {
              status: 403,
              reason: "forbidden",
              provider: "tavily",
            });
          },
        },
        { id: "exa", search: exaSpy },
      ]);

      expect(forbiddenResult.ok).toBe(false);
      if (!forbiddenResult.ok) {
        expect(forbiddenResult.status).toBe(403);
        expect(forbiddenResult.error.error.code).toBe("forbidden");
        expect(forbiddenResult.error.error.message).toContain(
          "forbidden or quarantined",
        );
      }

      const quarantineResult = await routeSearchRequest(
        { query: "quarantined" },
        [
          {
            id: "tavily",
            search: async () => {
              throw new Error("Provider quarantined by budget policy");
            },
          },
          { id: "exa", search: exaSpy },
        ],
      );

      expect(quarantineResult.ok).toBe(false);
      if (!quarantineResult.ok) {
        expect(quarantineResult.status).toBe(403);
        expect(quarantineResult.error.error.code).toBe("policy_quarantine");
      }
      expect(exaSpy).not.toHaveBeenCalled();
    });

    it("preserves structured terminal errors, native AbortError, and fallback defaults during routing", async () => {
      const exaSpy = vi.fn();

      const structuredUnauthorized = await routeSearchRequest(
        { query: "structured 401" },
        [
          {
            id: "tavily",
            search: async () => {
              throw { status: 401, reason: "unauthorized" };
            },
          },
          { id: "exa", search: exaSpy },
        ],
      );
      expect(structuredUnauthorized.ok).toBe(false);
      if (!structuredUnauthorized.ok) {
        expect(structuredUnauthorized.status).toBe(401);
        expect(structuredUnauthorized.error.error.code).toBe("invalid_api_key");
      }

      const nativeAbort = await routeSearchRequest({ query: "native abort" }, [
        {
          id: "tavily",
          search: async () => {
            throw new DOMException("The operation was aborted", "AbortError");
          },
        },
        { id: "exa", search: exaSpy },
      ]);
      expect(nativeAbort.ok).toBe(false);
      if (!nativeAbort.ok) {
        expect(nativeAbort.status).toBe(504);
        expect(nativeAbort.error.error.code).toBe("gateway_timeout");
      }
      expect(exaSpy).not.toHaveBeenCalled();

      const emptyBadRequest = await routeSearchRequest({ query: "empty 400" }, [
        {
          id: "tavily",
          search: async () => {
            throw new SearchExecutionError("", {
              status: 400,
              reason: "bad_request",
            });
          },
        },
      ]);
      expect(emptyBadRequest.ok).toBe(false);
      if (!emptyBadRequest.ok) {
        expect(emptyBadRequest.status).toBe(400);
        expect(emptyBadRequest.error.error.message).toBe(
          "Invalid search request parameters",
        );
      }

      const emptyUnauthorized = await routeSearchRequest(
        { query: "empty 401" },
        [
          {
            id: "tavily",
            search: async () => {
              throw new SearchExecutionError("", {
                status: 401,
                reason: "unauthorized",
              });
            },
          },
        ],
      );
      expect(emptyUnauthorized.ok).toBe(false);
      if (!emptyUnauthorized.ok) {
        expect(emptyUnauthorized.status).toBe(401);
        expect(emptyUnauthorized.error.error.message).toBe(
          "Upstream search provider authentication failed",
        );
      }
    });
  });

  describe("Environment Provider Ordering, Policy Filtering, and Deadline Rechecks", () => {
    it("honors SEARCH_PRIMARY_PROVIDER='exa' when using new SearchRouter().route()", async () => {
      const calledUrls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          calledUrls.push(url);
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "Exa Primary",
                  url: "https://exa.ai/primary",
                  snippet: "Exa served first.",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      );

      const router = new SearchRouter();
      const result = await router.route(
        { query: "primary exa ordering" },
        { ...mockSearchEnv, SEARCH_PRIMARY_PROVIDER: "exa" },
      );

      expect(calledUrls).toEqual(["https://api.exa.ai/search"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.provider).toBe("exa");
        expect(result.data.id).toMatch(/^search-/);
      }
    });

    it("allows paid providers when FREE_ONLY_POLICY is 'false' and quarantines when none are eligible", async () => {
      const paidProvider: SearchProvider = {
        id: "paid-search",
        requiresCreditCard: true,
        search: async () => ({
          results: [
            {
              title: "Paid",
              url: "https://paid.example/1",
              snippet: "Paid result",
            },
          ],
        }),
      };

      expect(
        filterEligibleSearchProviders([paidProvider], {
          FREE_ONLY_POLICY: "false",
        }),
      ).toHaveLength(1);

      const quarantined = await routeSearchRequest({ query: "none" }, [
        paidProvider,
      ]);
      expect(quarantined.ok).toBe(false);
      if (!quarantined.ok) {
        expect(quarantined.status).toBe(403);
        expect(quarantined.error.error.code).toBe("policy_quarantine");
        expect(quarantined.diagnostic.attempts).toBe(0);
      }
    });

    it("returns 504 immediately when clientSignal is already aborted or totalDeadlineMs <= 0", async () => {
      const controller = new AbortController();
      controller.abort();
      const spy = vi.fn();

      const abortedResult = await routeSearchRequest(
        { query: "pre-aborted" },
        [{ id: "tavily", search: spy }],
        mockSearchEnv,
        { clientSignal: controller.signal },
      );
      expect(abortedResult.ok).toBe(false);
      if (!abortedResult.ok) {
        expect(abortedResult.status).toBe(504);
        expect(abortedResult.diagnostic.attempts).toBe(0);
      }

      const expiredResult = await routeSearchRequest(
        { query: "zero deadline" },
        [{ id: "tavily", search: spy }],
        mockSearchEnv,
        { totalDeadlineMs: 0 },
      );
      expect(expiredResult.ok).toBe(false);
      if (!expiredResult.ok) {
        expect(expiredResult.status).toBe(504);
        expect(expiredResult.error.error.message).toContain(
          "deadline exceeded",
        );
        expect(expiredResult.diagnostic.attempts).toBe(0);
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it("rechecks wall-clock deadline before returning success when synchronous work exceeds totalDeadlineMs", async () => {
      let simulatedClockMs = 1_000;
      const slowSyncProvider: SearchProvider = {
        id: "tavily",
        search: async () => {
          simulatedClockMs += 80;
          return {
            id: "late-success",
            results: [
              {
                title: "Late",
                url: "https://example.com/late",
                snippet: "Arrived after deadline",
              },
            ],
          };
        },
      };

      const result = await routeSearchRequest(
        { query: "sync overrun" },
        [slowSyncProvider],
        mockSearchEnv,
        {
          totalDeadlineMs: 10,
          now: () => simulatedClockMs,
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.error.error.code).toBe("gateway_timeout");
        expect(result.error.error.message).toContain("deadline exceeded");
        expect(result.diagnostic).toEqual({
          provider: "tavily",
          attempts: 1,
          fallbackOccurred: false,
        });
      }
    });

    it("aborts in-flight provider when totalDeadlineMs timer fires before connectTimeoutMs", async () => {
      vi.useFakeTimers();

      const hangingProvider: SearchProvider = {
        id: "tavily",
        search: (_req, _env, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(signal.reason);
            });
          }),
      };

      const routePromise = routeSearchRequest(
        { query: "total deadline timer" },
        [hangingProvider],
        mockSearchEnv,
        { connectTimeoutMs: 5_000, totalDeadlineMs: 250 },
      );

      await vi.advanceTimersByTimeAsync(250);
      const result = await routePromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.error.error.message).toContain("deadline exceeded");
      }
    });
  });

  describe("Default HTTP Provider Adapters and Response Normalization", () => {
    it("sends optional search parameters, trims trailing base URL slashes, and normalizes optional fields", async () => {
      const fetchCalls: Array<{ url: string; body: string }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          fetchCalls.push({
            url: typeof input === "string" ? input : input.toString(),
            body: typeof init?.body === "string" ? init.body : "",
          });
          return new Response(
            JSON.stringify({
              id: "tvly-custom-1",
              creditsUsed: 3,
              results: [
                {
                  url: "https://example.com/a",
                  content: "Tavily content snippet",
                  score: 0.92,
                  publishedDate: "2026-01-01",
                },
                {
                  title: "Second",
                  url: "https://example.com/b",
                  published_date: "2026-01-02",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      );

      const tavily = createTavilyProvider();
      const res = await tavily.search(
        {
          query: "custom base",
          maxResults: 3,
          searchDepth: "advanced",
          includeDomains: ["example.com"],
          excludeDomains: ["spam.com"],
          topic: "news",
        },
        { TAVILY_BASE_URL: "https://tavily.proxy.local/v1///" },
        new AbortController().signal,
      );

      expect(fetchCalls[0]?.url).toBe("https://tavily.proxy.local/v1/search");
      expect(res.id).toBe("tvly-custom-1");
      expect(res.creditsUsed).toBe(3);
      expect(res.results).toEqual([
        {
          title: "",
          url: "https://example.com/a",
          snippet: "Tavily content snippet",
          score: 0.92,
          publishedDate: "2026-01-01",
        },
        {
          title: "Second",
          url: "https://example.com/b",
          snippet: "",
          publishedDate: "2026-01-02",
        },
      ]);

      const exaCalls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(
        async (input: RequestInfo | URL) => {
          exaCalls.push(typeof input === "string" ? input : input.toString());
          return new Response(
            JSON.stringify({
              usage: { credits: 2 },
              results: [
                {
                  title: "Exa Result",
                  url: "https://example.com/exa",
                  snippet: "Exa snippet",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      );

      const exa = createExaProvider();
      const exaRes = await exa.search(
        {
          query: "exa base",
          includeDomains: ["docs.example"],
          excludeDomains: ["ads.example"],
        },
        { EXA_BASE_URL: "https://exa.proxy.local///" },
        new AbortController().signal,
      );
      expect(exaCalls).toEqual(["https://exa.proxy.local/search"]);
      expect(exaRes.creditsUsed).toBe(2);
      expect(exaRes.results).toHaveLength(1);
    });

    it("cancels error response bodies and throws structured HTTP errors on non-OK responses", async () => {
      const tavily = createTavilyProvider();
      const exa = createExaProvider();

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "45" },
        }),
      );
      await expect(
        tavily.search({ query: "q" }, {}, new AbortController().signal),
      ).rejects.toMatchObject({
        status: 429,
        reason: "rate_limit_exceeded",
        retryAfter: "45",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(null, { status: 503 }),
      );
      await expect(
        exa.search({ query: "q" }, {}, new AbortController().signal),
      ).rejects.toMatchObject({
        status: 503,
        reason: "upstream_unavailable",
      });

      const abortedController = new AbortController();
      abortedController.abort();
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("forbidden", { status: 403 }),
      );
      await expect(
        tavily.search({ query: "q" }, {}, abortedController.signal),
      ).rejects.toMatchObject({
        status: 403,
        reason: "forbidden",
      });

      const failingCancelBody = new ReadableStream({
        cancel() {
          throw new Error("cancel failed");
        },
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(failingCancelBody, { status: 500 }),
      );
      await expect(
        exa.search({ query: "q" }, {}, new AbortController().signal),
      ).rejects.toMatchObject({
        status: 500,
        reason: "upstream_unavailable",
      });

      const midCancelController = new AbortController();
      const hangingCancelBody = new ReadableStream({
        cancel() {
          midCancelController.abort();
          return new Promise(() => {});
        },
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(hangingCancelBody, { status: 502 }),
      );
      await expect(
        tavily.search({ query: "q" }, {}, midCancelController.signal),
      ).rejects.toMatchObject({
        status: 502,
        reason: "upstream_unavailable",
      });
    });

    it("throws 502 invalid_upstream_response on malformed JSON or invalid result payloads", async () => {
      const tavily = createTavilyProvider();
      const exa = createExaProvider();
      const signal = new AbortController().signal;

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("not-json{", { status: 200 }),
      );
      await expect(
        tavily.search({ query: "q" }, {}, signal),
      ).rejects.toMatchObject({
        status: 502,
        reason: "invalid_upstream_response",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("not-json{", { status: 200 }),
      );
      await expect(
        exa.search({ query: "q" }, {}, signal),
      ).rejects.toMatchObject({
        status: 502,
        reason: "invalid_upstream_response",
      });

      const invalidPayloads = [
        null,
        { results: "not-an-array" },
        { results: [null] },
        { results: [{ title: "Missing URL" }] },
      ];

      for (const payload of invalidPayloads) {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify(payload), { status: 200 }),
        );
        await expect(
          tavily.search({ query: "q" }, {}, signal),
        ).rejects.toMatchObject({
          status: 502,
          reason: "invalid_upstream_response",
        });
      }
    });
  });
});
