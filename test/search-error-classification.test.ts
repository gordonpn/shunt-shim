import { describe, expect, it } from "vitest";
import {
  classifyHttpStatusToReason,
  createSearchHttpError,
  getDefaultStatusForSearchReason,
  isEligibleSearchFallbackError,
  isSearchErrorReason,
  SearchClientAbortError,
  type SearchErrorReason,
  SearchExecutionError,
  SearchTimeoutError,
} from "../src/search/errors.js";

describe("Search Fallback Error Classification (Task #140)", () => {
  interface ClassificationCase {
    name: string;
    error: unknown;
    expected: boolean;
  }

  const classificationTable: ClassificationCase[] = [
    {
      name: "HTTP 429 rate_limit_exceeded via createSearchHttpError",
      error: createSearchHttpError(429, "tavily", "15"),
      expected: true,
    },
    {
      name: "HTTP 402 quota_exceeded via createSearchHttpError",
      error: createSearchHttpError(402, "tavily"),
      expected: true,
    },
    {
      name: "HTTP 500 upstream_unavailable via createSearchHttpError",
      error: createSearchHttpError(500, "tavily"),
      expected: true,
    },
    {
      name: "HTTP 502 Bad Gateway via createSearchHttpError",
      error: createSearchHttpError(502, "tavily"),
      expected: true,
    },
    {
      name: "HTTP 503 Service Unavailable via createSearchHttpError",
      error: createSearchHttpError(503, "tavily"),
      expected: true,
    },
    {
      name: "HTTP 504 Gateway Timeout via createSearchHttpError",
      error: createSearchHttpError(504, "tavily"),
      expected: true,
    },
    {
      name: "SearchTimeoutError instance (upstream_timeout)",
      error: new SearchTimeoutError("Timed out after 5000ms", "tavily"),
      expected: true,
    },
    {
      name: "SearchExecutionError with network_error reason",
      error: new SearchExecutionError("Socket closed", {
        reason: "network_error",
        provider: "tavily",
      }),
      expected: true,
    },
    {
      name: "SearchExecutionError with invalid_upstream_response reason",
      error: new SearchExecutionError("Malformed JSON", {
        status: 502,
        reason: "invalid_upstream_response",
        provider: "tavily",
      }),
      expected: true,
    },
    {
      name: "Native fetch TypeError network failure",
      error: new TypeError("fetch failed: connect ECONNREFUSED"),
      expected: true,
    },
    {
      name: "DOMException TimeoutError",
      error: new DOMException("The operation timed out", "TimeoutError"),
      expected: true,
    },
    {
      name: "HTTP 400 bad_request via createSearchHttpError",
      error: createSearchHttpError(400, "tavily"),
      expected: false,
    },
    {
      name: "HTTP 401 unauthorized via createSearchHttpError",
      error: createSearchHttpError(401, "tavily"),
      expected: false,
    },
    {
      name: "HTTP 403 forbidden via createSearchHttpError",
      error: createSearchHttpError(403, "tavily"),
      expected: false,
    },
    {
      name: "SearchExecutionError with policy_quarantine reason",
      error: new SearchExecutionError(
        "Provider requires credit card under free-only policy",
        {
          status: 403,
          reason: "policy_quarantine",
          provider: "paid-search",
        },
      ),
      expected: false,
    },
    {
      name: "SearchClientAbortError instance (client_cancelled)",
      error: new SearchClientAbortError("Client disconnected", "tavily"),
      expected: false,
    },
    {
      name: "SearchExecutionError with isClientAbort=true even if status is 503",
      error: new SearchExecutionError("Aborted during 503 handling", {
        status: 503,
        reason: "upstream_unavailable",
        isClientAbort: true,
      }),
      expected: false,
    },
    {
      name: "DOMException AbortError",
      error: new DOMException("The operation was aborted", "AbortError"),
      expected: false,
    },
    {
      name: "Null or undefined error value",
      error: null,
      expected: false,
    },
    {
      name: "Undefined error value",
      error: undefined,
      expected: false,
    },
    {
      name: "Primitive string error value",
      error: "boom",
      expected: false,
    },
    {
      name: "SearchExecutionError with terminal HTTP 400 even when reason is upstream_unavailable",
      error: new SearchExecutionError("Bad query", {
        status: 400,
        reason: "upstream_unavailable",
      }),
      expected: false,
    },
    {
      name: "SearchExecutionError with unrecognized reason and eligible status 503",
      error: new SearchExecutionError("Transient", {
        status: 503,
        reason: "custom_unknown" as SearchErrorReason,
      }),
      expected: true,
    },
    {
      name: "SearchExecutionError with unrecognized reason and non-eligible status 418",
      error: new SearchExecutionError("Teapot", {
        status: 418,
        reason: "custom_unknown" as SearchErrorReason,
      }),
      expected: false,
    },
    {
      name: "SearchExecutionError with unrecognized reason and no status",
      error: new SearchExecutionError("Unknown", {
        reason: "custom_unknown" as SearchErrorReason,
      }),
      expected: false,
    },
    {
      name: "Plain object with isClientAbort=true",
      error: { isClientAbort: true, status: 503 },
      expected: false,
    },
    {
      name: "Plain object with terminal reason policy_quarantine",
      error: { reason: "policy_quarantine" },
      expected: false,
    },
    {
      name: "Plain object with eligible reason rate_limit_exceeded",
      error: { reason: "rate_limit_exceeded" },
      expected: true,
    },
    {
      name: "Plain object with unrecognized reason",
      error: { reason: "unrecognized_reason" },
      expected: false,
    },
    {
      name: "Plain object with terminal status 401",
      error: { status: 401 },
      expected: false,
    },
    {
      name: "Plain object with eligible status 503",
      error: { status: 503 },
      expected: true,
    },
    {
      name: "Plain object with unhandled status 418",
      error: { status: 418 },
      expected: false,
    },
    {
      name: "Error mentioning quarantine",
      error: new Error("Provider in policy quarantine"),
      expected: false,
    },
    {
      name: "Error mentioning client closed",
      error: new Error("Client closed socket"),
      expected: false,
    },
    {
      name: "Error mentioning client cancelled",
      error: new Error("Client cancelled request"),
      expected: false,
    },
    {
      name: "Error mentioning client canceled",
      error: new Error("Client canceled request"),
      expected: false,
    },
    {
      name: "Error mentioning timeout",
      error: new Error("Connection timeout"),
      expected: true,
    },
    {
      name: "Error mentioning timed out",
      error: new Error("Upstream timed out"),
      expected: true,
    },
    {
      name: "Error mentioning network",
      error: new Error("Network unreachable"),
      expected: true,
    },
    {
      name: "Error mentioning fetch failed",
      error: new Error("fetch failed"),
      expected: true,
    },
    {
      name: "Error mentioning ECONNREFUSED",
      error: new Error("connect ECONNREFUSED 127.0.0.1"),
      expected: true,
    },
    {
      name: "Error mentioning ENOTFOUND",
      error: new Error("getaddrinfo ENOTFOUND api.tavily.com"),
      expected: true,
    },
    {
      name: "Error mentioning socket hang up",
      error: new Error("socket hang up"),
      expected: true,
    },
    {
      name: "Unrecognized generic Error",
      error: new Error("unexpected runtime failure"),
      expected: false,
    },
  ];

  it.each(classificationTable)(
    "returns $expected for $name",
    ({ error, expected }) => {
      expect(isEligibleSearchFallbackError(error)).toBe(expected);
    },
  );

  it("returns false immediately for otherwise eligible errors when clientSignal is aborted", () => {
    const controller = new AbortController();
    controller.abort();

    const rateLimitError = createSearchHttpError(429, "tavily");
    const timeoutError = new SearchTimeoutError("Timed out", "tavily");
    const serverError = createSearchHttpError(503, "tavily");

    expect(
      isEligibleSearchFallbackError(rateLimitError, controller.signal),
    ).toBe(false);
    expect(isEligibleSearchFallbackError(timeoutError, controller.signal)).toBe(
      false,
    );
    expect(isEligibleSearchFallbackError(serverError, controller.signal)).toBe(
      false,
    );
  });

  it("maps HTTP status codes to expected SearchErrorReason values", () => {
    const expectedMappings: Array<[number, SearchErrorReason]> = [
      [400, "bad_request"],
      [401, "unauthorized"],
      [402, "quota_exceeded"],
      [403, "forbidden"],
      [429, "rate_limit_exceeded"],
      [500, "upstream_unavailable"],
      [502, "upstream_unavailable"],
      [503, "upstream_unavailable"],
      [504, "upstream_timeout"],
    ];

    for (const [status, reason] of expectedMappings) {
      expect(classifyHttpStatusToReason(status)).toBe(reason);
    }
  });

  it("creates HTTP errors without provider or retryAfter and validates SearchErrorReason helpers", () => {
    const err = createSearchHttpError(500, undefined, "");
    expect(err.message).toBe("Upstream search provider returned HTTP 500");
    expect(err.provider).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
    expect(err.reason).toBe("upstream_unavailable");

    expect(isSearchErrorReason("unauthorized")).toBe(true);
    expect(isSearchErrorReason("rate_limit_exceeded")).toBe(true);
    expect(isSearchErrorReason("not_a_reason")).toBe(false);
    expect(isSearchErrorReason(401)).toBe(false);

    expect(getDefaultStatusForSearchReason("unauthorized")).toBe(401);
    expect(getDefaultStatusForSearchReason("network_error")).toBeUndefined();
  });
});
