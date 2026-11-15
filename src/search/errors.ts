/**
 * Machine-readable classification reasons for search execution failures.
 */
export type SearchErrorReason =
  | "rate_limit_exceeded"
  | "quota_exceeded"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "network_error"
  | "invalid_upstream_response"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "policy_quarantine"
  | "client_cancelled";

/**
 * Construction options for SearchExecutionError.
 */
export interface SearchExecutionErrorOptions {
  status?: number | undefined;
  reason: SearchErrorReason;
  provider?: string | undefined;
  retryAfter?: string | undefined;
  isClientAbort?: boolean | undefined;
  cause?: unknown;
}

/**
 * Structured error representing a failure during upstream search dispatch.
 */
export class SearchExecutionError extends Error {
  readonly status?: number | undefined;
  readonly reason: SearchErrorReason;
  readonly provider?: string | undefined;
  readonly retryAfter?: string | undefined;
  readonly isClientAbort?: boolean | undefined;

  constructor(message: string, options: SearchExecutionErrorOptions) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "SearchExecutionError";
    this.reason = options.reason;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.provider !== undefined) {
      this.provider = options.provider;
    }
    if (options.retryAfter !== undefined) {
      this.retryAfter = options.retryAfter;
    }
    if (options.isClientAbort !== undefined) {
      this.isClientAbort = options.isClientAbort;
    }
  }
}

/**
 * Error thrown when an upstream search provider exceeds its per-attempt or total deadline.
 */
export class SearchTimeoutError extends SearchExecutionError {
  override readonly status = 504;
  override readonly reason = "upstream_timeout" as const;

  constructor(
    message = "Upstream search request timed out",
    provider?: string,
    cause?: unknown,
  ) {
    super(message, {
      status: 504,
      reason: "upstream_timeout",
      provider,
      cause,
    });
    this.name = "SearchTimeoutError";
  }
}

/**
 * Error thrown when the downstream client aborts the search request.
 */
export class SearchClientAbortError extends SearchExecutionError {
  override readonly status = 504;
  override readonly reason = "client_cancelled" as const;
  override readonly isClientAbort = true as const;

  constructor(
    message = "Client closed request before search completed",
    provider?: string,
    cause?: unknown,
  ) {
    super(message, {
      status: 504,
      reason: "client_cancelled",
      provider,
      isClientAbort: true,
      cause,
    });
    this.name = "SearchClientAbortError";
  }
}

const ELIGIBLE_REASONS = new Set<SearchErrorReason>([
  "rate_limit_exceeded",
  "quota_exceeded",
  "upstream_unavailable",
  "upstream_timeout",
  "network_error",
  "invalid_upstream_response",
]);

const TERMINAL_REASONS = new Set<SearchErrorReason>([
  "bad_request",
  "unauthorized",
  "forbidden",
  "policy_quarantine",
  "client_cancelled",
]);

const ELIGIBLE_HTTP_STATUSES = new Set<number>([402, 429, 500, 502, 503, 504]);
const TERMINAL_HTTP_STATUSES = new Set<number>([400, 401, 403]);

/**
 * Maps an upstream HTTP status code to a normalized SearchErrorReason.
 */
export function classifyHttpStatusToReason(status: number): SearchErrorReason {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 402:
      return "quota_exceeded";
    case 403:
      return "forbidden";
    case 429:
      return "rate_limit_exceeded";
    case 504:
      return "upstream_timeout";
    default:
      return "upstream_unavailable";
  }
}

/**
 * Creates a SearchExecutionError from an upstream HTTP status code and response metadata.
 */
export function createSearchHttpError(
  status: number,
  provider?: string,
  retryAfter?: string | null,
  message?: string,
): SearchExecutionError {
  const reason = classifyHttpStatusToReason(status);
  const resolvedMessage =
    message ??
    `Upstream search provider${provider ? ` '${provider}'` : ""} returned HTTP ${status}`;
  return new SearchExecutionError(resolvedMessage, {
    status,
    reason,
    provider,
    retryAfter: retryAfter && retryAfter.length > 0 ? retryAfter : undefined,
  });
}

/**
 * Determines whether an error thrown during a search provider attempt is eligible
 * for sequential fallback to the next configured search provider.
 *
 * Terminal client errors (400, 401, 403, policy quarantine, client abort) return false.
 * Transient or capacity errors (402, 429, 500, 502, 503, 504, timeout, network) return true.
 */
export function isEligibleSearchFallbackError(
  error: unknown,
  clientSignal?: AbortSignal,
): boolean {
  if (clientSignal?.aborted) {
    return false;
  }

  if (error === null || error === undefined) {
    return false;
  }

  if (error instanceof SearchClientAbortError) {
    return false;
  }

  if (error instanceof SearchTimeoutError) {
    return true;
  }

  if (error instanceof SearchExecutionError) {
    if (error.isClientAbort === true) {
      return false;
    }
    if (TERMINAL_REASONS.has(error.reason)) {
      return false;
    }
    if (
      error.status !== undefined &&
      TERMINAL_HTTP_STATUSES.has(error.status)
    ) {
      return false;
    }
    if (ELIGIBLE_REASONS.has(error.reason)) {
      return true;
    }
    if (
      error.status !== undefined &&
      ELIGIBLE_HTTP_STATUSES.has(error.status)
    ) {
      return true;
    }
    return false;
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;

    if (record.isClientAbort === true) {
      return false;
    }

    if (typeof record.reason === "string") {
      if (TERMINAL_REASONS.has(record.reason as SearchErrorReason)) {
        return false;
      }
      if (ELIGIBLE_REASONS.has(record.reason as SearchErrorReason)) {
        return true;
      }
    }

    if (typeof record.status === "number") {
      if (TERMINAL_HTTP_STATUSES.has(record.status)) {
        return false;
      }
      if (ELIGIBLE_HTTP_STATUSES.has(record.status)) {
        return true;
      }
    }
  }

  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return false;
    }
    if (error.name === "TimeoutError") {
      return true;
    }
    const lowerMessage = error.message.toLowerCase();
    if (
      lowerMessage.includes("quarantine") ||
      lowerMessage.includes("client closed") ||
      lowerMessage.includes("client cancelled") ||
      lowerMessage.includes("client canceled")
    ) {
      return false;
    }
    if (
      lowerMessage.includes("timeout") ||
      lowerMessage.includes("timed out") ||
      lowerMessage.includes("network") ||
      lowerMessage.includes("fetch failed") ||
      lowerMessage.includes("econnrefused") ||
      lowerMessage.includes("enotfound") ||
      lowerMessage.includes("socket hang up")
    ) {
      return true;
    }
  }

  return false;
}
