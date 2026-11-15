import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SearchClientAbortError,
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
});
