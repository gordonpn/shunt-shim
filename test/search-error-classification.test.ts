import { describe, expect, it } from "vitest";
import {
  classifyHttpStatusToReason,
  createSearchHttpError,
  isEligibleSearchFallbackError,
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
});
