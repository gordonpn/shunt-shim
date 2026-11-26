import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SearchClientAbortError,
  SearchExecutionError,
  SearchTimeoutError,
} from "../src/search/errors.js";
import {
  createTavilyProvider,
  dispatchSearchWithTimeout,
  routeSearchRequest,
  SEARCH_CONNECT_TIMEOUT_MS,
  type SearchProvider,
} from "../src/search/router.js";

describe("Search Per-Attempt Timeout and Cancellation (Task #139)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts a stagnant upstream fetch after 5s and throws SearchTimeoutError", async () => {
    let capturedSignal: AbortSignal | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              init.signal?.reason ??
                new DOMException("The operation was aborted", "AbortError"),
            );
          });
        });
      },
    );

    const tavily = createTavilyProvider();
    const dispatchPromise = dispatchSearchWithTimeout(
      tavily,
      { query: "cloudflare workers timeout" },
      { TAVILY_API_KEY: "tvly-test-key" },
    );

    const assertion =
      expect(dispatchPromise).rejects.toThrow(SearchTimeoutError);

    await vi.advanceTimersByTimeAsync(SEARCH_CONNECT_TIMEOUT_MS);
    await assertion;

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("includes provider metadata and 504 status on SearchTimeoutError", async () => {
    const stagnantProvider: SearchProvider = {
      id: "tavily",
      search: (_req, _env, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Timed out", "TimeoutError"));
          });
        }),
    };

    const dispatchPromise = dispatchSearchWithTimeout(stagnantProvider, {
      query: "slow query",
    });

    const caughtPromise = dispatchPromise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(SEARCH_CONNECT_TIMEOUT_MS);
    const error = await caughtPromise;

    expect(error).toBeInstanceOf(SearchTimeoutError);
    if (error instanceof SearchTimeoutError) {
      expect(error.status).toBe(504);
      expect(error.reason).toBe("upstream_timeout");
      expect(error.provider).toBe("tavily");
    }
  });

  it("propagates client disconnect immediately without waiting 5s and throws SearchClientAbortError", async () => {
    const clientController = new AbortController();
    let upstreamSignal: AbortSignal | undefined;

    const provider: SearchProvider = {
      id: "tavily",
      search: (_req, _env, signal) => {
        upstreamSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted by client", "AbortError"));
          });
        });
      },
    };

    const dispatchPromise = dispatchSearchWithTimeout(
      provider,
      { query: "abort immediately" },
      {},
      { clientSignal: clientController.signal },
    );

    const caughtPromise = dispatchPromise.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(150);
    clientController.abort(
      new DOMException("Client disconnected", "AbortError"),
    );

    const error = await caughtPromise;
    expect(error).toBeInstanceOf(SearchClientAbortError);
    if (error instanceof SearchClientAbortError) {
      expect(error.status).toBe(504);
      expect(error.reason).toBe("client_cancelled");
      expect(error.isClientAbort).toBe(true);
      expect(error.provider).toBe("tavily");
    }
    expect(upstreamSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws SearchClientAbortError immediately without invoking provider if clientSignal is already aborted", async () => {
    const clientController = new AbortController();
    clientController.abort();

    const searchSpy = vi.fn();
    const provider: SearchProvider = {
      id: "tavily",
      search: searchSpy,
    };

    await expect(
      dispatchSearchWithTimeout(
        provider,
        { query: "already aborted" },
        {},
        { clientSignal: clientController.signal },
      ),
    ).rejects.toThrow(SearchClientAbortError);

    expect(searchSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prevents fallback to secondary provider when client disconnects during primary attempt", async () => {
    const clientController = new AbortController();
    const exaSpy = vi.fn();

    const tavilyProvider: SearchProvider = {
      id: "tavily",
      search: (_req, _env, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Client aborted", "AbortError"));
          });
        }),
    };

    const exaProvider: SearchProvider = {
      id: "exa",
      search: exaSpy,
    };

    const routePromise = routeSearchRequest(
      { query: "no fallback on client abort" },
      [tavilyProvider, exaProvider],
      {},
      { clientSignal: clientController.signal },
    );

    await vi.advanceTimersByTimeAsync(100);
    clientController.abort();

    const result = await routePromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(504);
      expect(result.error.error.code).toBe("gateway_timeout");
      expect(result.diagnostic.attempts).toBe(1);
      expect(result.diagnostic.fallbackOccurred).toBe(false);
    }
    expect(exaSpy).not.toHaveBeenCalled();
  });

  it("clears timer handles in finally block when provider resolves or rejects quickly", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const fastProvider: SearchProvider = {
      id: "tavily",
      search: async () => ({
        id: "fast-1",
        results: [
          {
            title: "Fast Result",
            url: "https://example.com/fast",
            snippet: "Quick response",
          },
        ],
        creditsUsed: 1,
      }),
    };

    const response = await dispatchSearchWithTimeout(fastProvider, {
      query: "quick query",
    });

    expect(response.results.length).toBe(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const failingProvider: SearchProvider = {
      id: "tavily",
      search: async () => {
        throw new TypeError("fetch failed");
      },
    };

    await expect(
      dispatchSearchWithTimeout(failingProvider, { query: "failing query" }),
    ).rejects.toThrow("fetch failed");

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws SearchTimeoutError immediately without calling provider when deadlineSignal is already aborted", async () => {
    const deadlineController = new AbortController();
    deadlineController.abort(new DOMException("Deadline hit", "TimeoutError"));
    const searchSpy = vi.fn();

    await expect(
      dispatchSearchWithTimeout(
        { id: "tavily", search: searchSpy },
        { query: "expired deadline" },
        {},
        { deadlineSignal: deadlineController.signal },
      ),
    ).rejects.toThrow(SearchTimeoutError);

    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("throws SearchClientAbortError if clientSignal aborts during synchronous resolution or via isClientAbort error", async () => {
    const clientController = new AbortController();
    const abortDuringResolve: SearchProvider = {
      id: "tavily",
      search: async () => {
        clientController.abort();
        return { results: [] };
      },
    };

    await expect(
      dispatchSearchWithTimeout(
        abortDuringResolve,
        { query: "abort right before return" },
        {},
        { clientSignal: clientController.signal },
      ),
    ).rejects.toThrow(SearchClientAbortError);

    const clientAbortExecutionErr: SearchProvider = {
      id: "tavily",
      search: async () => {
        throw new SearchExecutionError("Aborted upstream", {
          status: 503,
          reason: "upstream_unavailable",
          isClientAbort: true,
        });
      },
    };

    await expect(
      dispatchSearchWithTimeout(clientAbortExecutionErr, {
        query: "execution client abort",
      }),
    ).rejects.toThrow(SearchClientAbortError);

    const directClientAbortErr: SearchProvider = {
      id: "tavily",
      search: async () => {
        throw new SearchClientAbortError("Direct client abort", "tavily");
      },
    };

    await expect(
      dispatchSearchWithTimeout(directClientAbortErr, {
        query: "direct client abort",
      }),
    ).rejects.toThrow("Direct client abort");
  });

  it("preserves and classifies thrown errors during dispatch", async () => {
    const cases: Array<{
      label: string;
      thrown: unknown;
      assertError: (err: unknown) => void;
    }> = [
      {
        label: "DOMException TimeoutError",
        thrown: new DOMException("Timed out", "TimeoutError"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchTimeoutError);
        },
      },
      {
        label: "TypeError with empty message",
        thrown: new TypeError(""),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).reason).toBe("network_error");
          expect((err as SearchExecutionError).message).toContain(
            "Network failure",
          );
        },
      },
      {
        label: "Structured client abort object",
        thrown: { isClientAbort: true, message: "Client closed" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchClientAbortError);
        },
      },
      {
        label: "Native AbortError without clientSignal",
        thrown: new DOMException("Operation aborted", "AbortError"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchClientAbortError);
        },
      },
      {
        label: "Duck-typed TimeoutError object",
        thrown: { name: "TimeoutError", message: "Custom timeout" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchTimeoutError);
          expect((err as SearchTimeoutError).message).toBe("Custom timeout");
        },
      },
      {
        label: "Structured upstream_timeout reason",
        thrown: { reason: "upstream_timeout" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchTimeoutError);
        },
      },
      {
        label: "Structured unauthorized error object",
        thrown: { status: 401, reason: "unauthorized" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(401);
          expect((err as SearchExecutionError).reason).toBe("unauthorized");
        },
      },
      {
        label: "Structured reason-only unauthorized error object",
        thrown: { reason: "unauthorized" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(401);
          expect((err as SearchExecutionError).reason).toBe("unauthorized");
        },
      },
      {
        label: "Structured status-only 429 error object with retryAfter",
        thrown: { status: 429, retryAfter: "25" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(429);
          expect((err as SearchExecutionError).reason).toBe(
            "rate_limit_exceeded",
          );
          expect((err as SearchExecutionError).retryAfter).toBe("25");
        },
      },
      {
        label: "Quarantine message Error",
        thrown: new Error("Provider in policy quarantine"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(403);
          expect((err as SearchExecutionError).reason).toBe(
            "policy_quarantine",
          );
        },
      },
      {
        label: "Client closed message Error",
        thrown: new Error("Client closed connection"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchClientAbortError);
        },
      },
      {
        label: "Timeout message Error",
        thrown: new Error("Upstream request timed out"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchTimeoutError);
        },
      },
      {
        label: "Network message Error",
        thrown: new Error("connect ECONNREFUSED"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).reason).toBe("network_error");
        },
      },
      {
        label: "Generic Error with non-empty message",
        thrown: new Error("Unexpected upstream exception"),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(502);
          expect((err as SearchExecutionError).reason).toBe(
            "upstream_unavailable",
          );
          expect((err as SearchExecutionError).message).toBe(
            "Unexpected upstream exception",
          );
        },
      },
      {
        label: "Generic Error with empty message",
        thrown: new Error(""),
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(502);
          expect((err as SearchExecutionError).reason).toBe(
            "upstream_unavailable",
          );
        },
      },
      {
        label: "Unrecognized plain object",
        thrown: { foo: "bar" },
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(502);
          expect((err as SearchExecutionError).reason).toBe(
            "upstream_unavailable",
          );
        },
      },
      {
        label: "Non-object primitive rejection",
        thrown: "unexpected string rejection",
        assertError: (err) => {
          expect(err).toBeInstanceOf(SearchExecutionError);
          expect((err as SearchExecutionError).status).toBe(502);
          expect((err as SearchExecutionError).reason).toBe(
            "upstream_unavailable",
          );
        },
      },
    ];

    for (const testCase of cases) {
      const provider: SearchProvider = {
        id: "tavily",
        search: async () => {
          throw testCase.thrown;
        },
      };

      const caught = await dispatchSearchWithTimeout(provider, {
        query: testCase.label,
      }).catch((err: unknown) => err);

      testCase.assertError(caught);
    }
  });
});
