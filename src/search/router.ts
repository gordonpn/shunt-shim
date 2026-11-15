import { type ApiError, createErrorResponse } from "../errors.js";
import type { GatewayEnv } from "../index.js";
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
} from "./errors.js";

/**
 * Default per-provider connection and response timeout in milliseconds (5 seconds).
 */
export const SEARCH_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Default total wall-clock deadline across all sequential search attempts in milliseconds (30 seconds).
 */
export const SEARCH_TOTAL_DEADLINE_MS = 30_000;

/**
 * Normalized individual search result item returned by a search provider.
 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number | undefined;
  publishedDate?: string | undefined;
}

/**
 * Validated search query request parameters.
 */
export interface SearchRequest {
  query: string;
  maxResults?: number | undefined;
  searchDepth?: "basic" | "advanced" | undefined;
  includeDomains?: string[] | undefined;
  excludeDomains?: string[] | undefined;
  topic?: "general" | "news" | undefined;
}

/**
 * Raw result returned by an individual search provider adapter.
 */
export interface SearchProviderResponse {
  id?: string | undefined;
  results: SearchResultItem[];
  creditsUsed?: number | undefined;
}

/**
 * Environment bindings used by search providers and the fallback router.
 */
export interface SearchRouterEnv extends GatewayEnv {
  TAVILY_API_KEY?: string | undefined;
  EXA_API_KEY?: string | undefined;
  TAVILY_BASE_URL?: string | undefined;
  EXA_BASE_URL?: string | undefined;
  SEARCH_PRIMARY_PROVIDER?: string | undefined;
  SEARCH_FALLBACK_PROVIDER?: string | undefined;
  FREE_ONLY_POLICY?: string | undefined;
}

/**
 * Contract implemented by each upstream search provider adapter.
 */
export interface SearchProvider {
  readonly id: string;
  readonly requiresCreditCard?: boolean | undefined;
  search: (
    req: SearchRequest,
    env: SearchRouterEnv,
    signal: AbortSignal,
  ) => Promise<SearchProviderResponse>;
}

/**
 * Options for bounding a single search provider dispatch attempt.
 */
export interface DispatchSearchOptions {
  signal?: AbortSignal | undefined;
  clientSignal?: AbortSignal | undefined;
  deadlineSignal?: AbortSignal | undefined;
  connectTimeoutMs?: number | undefined;
}

/**
 * Options for routing a search request across eligible providers.
 */
export interface SearchRouterOptions {
  signal?: AbortSignal | undefined;
  clientSignal?: AbortSignal | undefined;
  connectTimeoutMs?: number | undefined;
  totalDeadlineMs?: number | undefined;
  now?: (() => number) | undefined;
}

/**
 * Normalized search response payload returned on successful routing.
 */
export interface NormalizedSearchResponse {
  id: string;
  query: string;
  results: SearchResultItem[];
  provider: string;
  usage: {
    credits: number;
  };
}

/**
 * Diagnostic metadata captured during sequential search routing.
 */
export interface SearchDiagnosticMetadata {
  provider?: string | undefined;
  attempts: number;
  fallbackOccurred: boolean;
  fallbackReason?: SearchErrorReason | string | undefined;
}

/**
 * HTTP status codes returned by the search router on failure.
 */
export type SearchRouteErrorStatus = 400 | 401 | 403 | 429 | 502 | 503 | 504;

/**
 * Discriminated union result of routing a search request.
 */
export type SearchRouteResult =
  | {
      ok: true;
      data: NormalizedSearchResponse;
      diagnostic: SearchDiagnosticMetadata;
    }
  | {
      ok: false;
      status: SearchRouteErrorStatus;
      error: ApiError;
      headers?: Record<string, string> | undefined;
      diagnostic: SearchDiagnosticMetadata;
    };

function trimTrailingSlashes(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

async function cancelErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([response.body.cancel(), aborted]);
  } catch {
    // Best-effort stream cancellation to avoid leaking sockets.
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function normalizeProviderResults(
  rawJson: unknown,
  providerId: string,
): SearchProviderResponse {
  if (typeof rawJson !== "object" || rawJson === null) {
    throw new SearchExecutionError(
      `Upstream search provider '${providerId}' returned a non-object JSON payload`,
      {
        status: 502,
        reason: "invalid_upstream_response",
        provider: providerId,
      },
    );
  }

  const record = rawJson as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new SearchExecutionError(
      `Upstream search provider '${providerId}' response is missing a valid results array`,
      {
        status: 502,
        reason: "invalid_upstream_response",
        provider: providerId,
      },
    );
  }

  const results: SearchResultItem[] = [];
  for (const item of record.results) {
    if (typeof item !== "object" || item === null) {
      throw new SearchExecutionError(
        `Upstream search provider '${providerId}' returned a malformed result entry`,
        {
          status: 502,
          reason: "invalid_upstream_response",
          provider: providerId,
        },
      );
    }
    const entry = item as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!url) {
      throw new SearchExecutionError(
        `Upstream search provider '${providerId}' returned a result entry without a URL`,
        {
          status: 502,
          reason: "invalid_upstream_response",
          provider: providerId,
        },
      );
    }
    const snippet =
      typeof entry.snippet === "string"
        ? entry.snippet
        : typeof entry.content === "string"
          ? entry.content
          : typeof entry.text === "string"
            ? entry.text
            : "";

    const normalizedItem: SearchResultItem = {
      title,
      url,
      snippet,
      ...(typeof entry.score === "number" ? { score: entry.score } : {}),
      ...(typeof entry.publishedDate === "string"
        ? { publishedDate: entry.publishedDate }
        : typeof entry.published_date === "string"
          ? { publishedDate: entry.published_date }
          : {}),
    };
    results.push(normalizedItem);
  }

  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : typeof record.requestId === "string" && record.requestId.length > 0
        ? record.requestId
        : undefined;

  const creditsUsed =
    typeof record.creditsUsed === "number"
      ? record.creditsUsed
      : typeof (record.usage as Record<string, unknown> | undefined)
            ?.credits === "number"
        ? ((record.usage as Record<string, unknown>).credits as number)
        : 1;

  return {
    ...(id !== undefined ? { id } : {}),
    results,
    creditsUsed,
  };
}

/**
 * Creates the default Tavily HTTP search provider adapter.
 */
export function createTavilyProvider(): SearchProvider {
  return {
    id: "tavily",
    requiresCreditCard: false,
    async search(
      req: SearchRequest,
      env: SearchRouterEnv,
      signal: AbortSignal,
    ): Promise<SearchProviderResponse> {
      const baseUrl = env.TAVILY_BASE_URL
        ? trimTrailingSlashes(env.TAVILY_BASE_URL)
        : "https://api.tavily.com";
      const apiKey = env.TAVILY_API_KEY ?? "";
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: req.query,
          max_results: req.maxResults ?? 5,
          search_depth: req.searchDepth ?? "basic",
          ...(req.includeDomains
            ? { include_domains: req.includeDomains }
            : {}),
          ...(req.excludeDomains
            ? { exclude_domains: req.excludeDomains }
            : {}),
          ...(req.topic ? { topic: req.topic } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        await cancelErrorBody(response, signal);
        throw createSearchHttpError(response.status, "tavily", retryAfter);
      }

      let rawJson: unknown;
      try {
        rawJson = await response.json();
      } catch (err) {
        throw new SearchExecutionError(
          "Tavily search provider returned malformed JSON",
          {
            status: 502,
            reason: "invalid_upstream_response",
            provider: "tavily",
            cause: err,
          },
        );
      }

      return normalizeProviderResults(rawJson, "tavily");
    },
  };
}

/**
 * Creates the default Exa HTTP search provider adapter.
 */
export function createExaProvider(): SearchProvider {
  return {
    id: "exa",
    requiresCreditCard: false,
    async search(
      req: SearchRequest,
      env: SearchRouterEnv,
      signal: AbortSignal,
    ): Promise<SearchProviderResponse> {
      const baseUrl = env.EXA_BASE_URL
        ? trimTrailingSlashes(env.EXA_BASE_URL)
        : "https://api.exa.ai";
      const apiKey = env.EXA_API_KEY ?? "";
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: req.query,
          numResults: req.maxResults ?? 5,
          ...(req.includeDomains ? { includeDomains: req.includeDomains } : {}),
          ...(req.excludeDomains ? { excludeDomains: req.excludeDomains } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        await cancelErrorBody(response, signal);
        throw createSearchHttpError(response.status, "exa", retryAfter);
      }

      let rawJson: unknown;
      try {
        rawJson = await response.json();
      } catch (err) {
        throw new SearchExecutionError(
          "Exa search provider returned malformed JSON",
          {
            status: 502,
            reason: "invalid_upstream_response",
            provider: "exa",
            cause: err,
          },
        );
      }

      return normalizeProviderResults(rawJson, "exa");
    },
  };
}

/**
 * Creates the ordered list of default search providers (Tavily primary, Exa fallback).
 */
export function createDefaultSearchProviders(
  env?: SearchRouterEnv,
): SearchProvider[] {
  const tavily = createTavilyProvider();
  const exa = createExaProvider();
  if (env?.SEARCH_PRIMARY_PROVIDER === "exa") {
    return [exa, tavily];
  }
  return [tavily, exa];
}

/**
 * Dispatches a search request to a single provider with a bounded per-attempt timeout
 * and immediate client cancellation propagation.
 *
 * @param provider - Target search provider adapter.
 * @param req - Validated search request parameters.
 * @param env - Environment bindings for upstream credentials.
 * @param options - Timeout and cancellation signal options.
 * @returns Normalized provider search response.
 * @throws SearchClientAbortError when the client signal aborts.
 * @throws SearchTimeoutError when the per-attempt or deadline timeout fires.
 * @throws SearchExecutionError on upstream HTTP or network failure.
 */
export async function dispatchSearchWithTimeout(
  provider: SearchProvider,
  req: SearchRequest,
  env: SearchRouterEnv = {},
  options?: DispatchSearchOptions,
): Promise<SearchProviderResponse> {
  const clientSignal = options?.clientSignal ?? options?.signal;
  const deadlineSignal = options?.deadlineSignal;

  if (clientSignal?.aborted) {
    throw new SearchClientAbortError(
      "Client closed request prior to search dispatch",
      provider.id,
      clientSignal.reason,
    );
  }

  if (deadlineSignal?.aborted) {
    throw new SearchTimeoutError(
      "Total search request deadline exceeded prior to attempt",
      provider.id,
      deadlineSignal.reason,
    );
  }

  const timeoutMs = Math.max(
    1,
    options?.connectTimeoutMs ?? SEARCH_CONNECT_TIMEOUT_MS,
  );

  let timedOut = false;
  const attemptController = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    attemptController.abort(
      new DOMException("Search connection timeout", "TimeoutError"),
    );
  }, timeoutMs);

  const signals: AbortSignal[] = [attemptController.signal];
  if (deadlineSignal) {
    signals.push(deadlineSignal);
  }
  if (clientSignal) {
    signals.push(clientSignal);
  }
  const combinedSignal = AbortSignal.any(signals);

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(combinedSignal.reason);
    };
    combinedSignal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const searchPromise = Promise.resolve().then(() =>
      provider.search(req, env, combinedSignal),
    );
    searchPromise.catch(() => undefined);

    return await Promise.race([searchPromise, abortPromise]);
  } catch (err) {
    if (
      clientSignal?.aborted ||
      err instanceof SearchClientAbortError ||
      (err instanceof SearchExecutionError && err.isClientAbort === true)
    ) {
      throw err instanceof SearchClientAbortError
        ? err
        : new SearchClientAbortError(
            "Client closed request during search dispatch",
            provider.id,
            err,
          );
    }

    if (
      timedOut ||
      attemptController.signal.aborted ||
      deadlineSignal?.aborted ||
      err instanceof SearchTimeoutError ||
      (err instanceof Error && err.name === "TimeoutError")
    ) {
      throw err instanceof SearchTimeoutError
        ? err
        : new SearchTimeoutError(
            `Search provider '${provider.id}' timed out after ${timeoutMs}ms`,
            provider.id,
            err,
          );
    }

    throw toSearchExecutionError(err, provider.id);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      combinedSignal.removeEventListener("abort", onAbort);
    }
  }
}

function classifyErrorMessage(
  message: string,
  providerId: string,
  cause: unknown,
): SearchExecutionError | undefined {
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("quarantine")) {
    return new SearchExecutionError(message, {
      status: 403,
      reason: "policy_quarantine",
      provider: providerId,
      cause,
    });
  }
  if (
    lowerMessage.includes("client closed") ||
    lowerMessage.includes("client cancelled") ||
    lowerMessage.includes("client canceled")
  ) {
    return new SearchClientAbortError(message, providerId, cause);
  }
  if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
    return new SearchTimeoutError(message, providerId, cause);
  }
  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("enotfound") ||
    lowerMessage.includes("socket hang up")
  ) {
    return new SearchExecutionError(message, {
      reason: "network_error",
      provider: providerId,
      cause,
    });
  }
  return undefined;
}

function toSearchExecutionError(
  err: unknown,
  providerId: string,
): SearchExecutionError {
  if (err instanceof SearchExecutionError) {
    return err;
  }

  if (err instanceof TypeError) {
    return new SearchExecutionError(
      err.message || `Network failure while querying '${providerId}'`,
      {
        reason: "network_error",
        provider: providerId,
        cause: err,
      },
    );
  }

  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : `Unexpected search failure from '${providerId}'`;
    const retryAfter =
      typeof record.retryAfter === "string" && record.retryAfter.length > 0
        ? record.retryAfter
        : undefined;
    const status =
      typeof record.status === "number" ? record.status : undefined;

    if (
      record.isClientAbort === true ||
      record.reason === "client_cancelled" ||
      record.name === "AbortError"
    ) {
      return new SearchClientAbortError(message, providerId, err);
    }

    if (record.name === "TimeoutError") {
      return new SearchTimeoutError(message, providerId, err);
    }

    if (isSearchErrorReason(record.reason)) {
      if (record.reason === "upstream_timeout") {
        return new SearchTimeoutError(message, providerId, err);
      }
      return new SearchExecutionError(message, {
        status: status ?? getDefaultStatusForSearchReason(record.reason),
        reason: record.reason,
        provider: providerId,
        retryAfter,
        cause: err,
      });
    }

    if (status !== undefined) {
      return new SearchExecutionError(message, {
        status,
        reason: classifyHttpStatusToReason(status),
        provider: providerId,
        retryAfter,
        cause: err,
      });
    }

    if (err instanceof Error) {
      const classified = classifyErrorMessage(err.message, providerId, err);
      if (classified) {
        return classified;
      }
    }
  }

  const message =
    err instanceof Error && err.message.length > 0
      ? err.message
      : `Unexpected search failure from '${providerId}'`;
  return new SearchExecutionError(message, {
    status: 502,
    reason: "upstream_unavailable",
    provider: providerId,
    cause: err,
  });
}

/**
 * Filters a list of search providers according to the active free-only policy.
 */
export function filterEligibleSearchProviders(
  providers: readonly SearchProvider[],
  env?: SearchRouterEnv,
): SearchProvider[] {
  const enforceFreeOnly = env?.FREE_ONLY_POLICY !== "false";
  if (!enforceFreeOnly) {
    return [...providers];
  }
  return providers.filter((provider) => provider.requiresCreditCard !== true);
}

function buildSearchDiagnostic(
  providerId: string | undefined,
  attempts: number,
  firstFailureReason: SearchErrorReason | undefined,
): SearchDiagnosticMetadata {
  return {
    ...(providerId !== undefined ? { provider: providerId } : {}),
    attempts,
    fallbackOccurred: attempts > 1,
    ...(firstFailureReason !== undefined
      ? { fallbackReason: firstFailureReason }
      : {}),
  };
}

function createClientAbortRouteResult(
  diagnostic: SearchDiagnosticMetadata,
): SearchRouteResult {
  return {
    ok: false,
    status: 504,
    error: createErrorResponse(
      "Client closed request or operation timed out",
      "api_error",
      "gateway_timeout",
    ),
    diagnostic,
  };
}

function createDeadlineExceededResult(
  diagnostic: SearchDiagnosticMetadata,
  message = "Total search request deadline exceeded",
): SearchRouteResult {
  return {
    ok: false,
    status: 504,
    error: createErrorResponse(message, "api_error", "gateway_timeout"),
    diagnostic,
  };
}

/**
 * Routes a search request sequentially across eligible providers with a 5s per-attempt
 * connection timeout and a 30s total wall-clock deadline.
 */
export async function routeSearchRequest(
  req: SearchRequest,
  providers?: readonly SearchProvider[],
  env: SearchRouterEnv = {},
  options?: SearchRouterOptions,
): Promise<SearchRouteResult> {
  const clientSignal = options?.clientSignal ?? options?.signal;
  if (clientSignal?.aborted) {
    return createClientAbortRouteResult({
      attempts: 0,
      fallbackOccurred: false,
    });
  }

  const candidateProviders = providers ?? createDefaultSearchProviders(env);
  const eligibleProviders = filterEligibleSearchProviders(
    candidateProviders,
    env,
  );

  if (eligibleProviders.length === 0) {
    return {
      ok: false,
      status: 403,
      error: createErrorResponse(
        "No eligible search providers available under free-only policy",
        "invalid_request_error",
        "policy_quarantine",
      ),
      diagnostic: {
        attempts: 0,
        fallbackOccurred: false,
        fallbackReason: "policy_quarantine",
      },
    };
  }

  const connectTimeoutMs =
    options?.connectTimeoutMs ?? SEARCH_CONNECT_TIMEOUT_MS;
  const totalDeadlineMs = options?.totalDeadlineMs ?? SEARCH_TOTAL_DEADLINE_MS;
  const now = options?.now ?? Date.now;
  const startTime = now();

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(
      new DOMException(
        "Total search request deadline exceeded",
        "TimeoutError",
      ),
    );
  }, totalDeadlineMs);

  let attempts = 0;
  let firstFailureReason: SearchErrorReason | undefined;
  let lastError: SearchExecutionError | undefined;
  let lastProviderId: string | undefined;
  let lastRetryAfter: string | undefined;

  try {
    for (const provider of eligibleProviders) {
      const elapsedMs = now() - startTime;
      const remainingMs = totalDeadlineMs - elapsedMs;
      if (remainingMs <= 0 || deadlineController.signal.aborted) {
        return createDeadlineExceededResult(
          buildSearchDiagnostic(lastProviderId, attempts, firstFailureReason),
        );
      }

      const attemptTimeoutMs = Math.max(
        1,
        Math.min(connectTimeoutMs, remainingMs),
      );
      attempts += 1;
      lastProviderId = provider.id;

      try {
        const providerResponse = await dispatchSearchWithTimeout(
          provider,
          req,
          env,
          {
            clientSignal,
            deadlineSignal: deadlineController.signal,
            connectTimeoutMs: attemptTimeoutMs,
          },
        );

        if (
          deadlineController.signal.aborted ||
          now() - startTime >= totalDeadlineMs
        ) {
          return createDeadlineExceededResult(
            buildSearchDiagnostic(lastProviderId, attempts, firstFailureReason),
          );
        }

        const fallbackOccurred = attempts > 1;
        const responseId =
          providerResponse.id && providerResponse.id.length > 0
            ? providerResponse.id
            : `search-${crypto.randomUUID()}`;

        return {
          ok: true,
          data: {
            id: responseId,
            query: req.query,
            results: providerResponse.results,
            provider: provider.id,
            usage: {
              credits: providerResponse.creditsUsed ?? 1,
            },
          },
          diagnostic: {
            provider: provider.id,
            attempts,
            fallbackOccurred,
            ...(fallbackOccurred && firstFailureReason !== undefined
              ? { fallbackReason: firstFailureReason }
              : {}),
          },
        };
      } catch (err) {
        const executionError = toSearchExecutionError(err, provider.id);
        lastError = executionError;
        if (executionError.retryAfter) {
          lastRetryAfter = executionError.retryAfter;
        }
        if (firstFailureReason === undefined) {
          firstFailureReason = executionError.reason;
        }

        const eligibleForFallback = isEligibleSearchFallbackError(
          executionError,
          clientSignal,
        );
        if (!eligibleForFallback) {
          break;
        }
      }
    }

    const diagnostic = buildSearchDiagnostic(
      lastProviderId,
      attempts,
      firstFailureReason,
    );

    if (
      clientSignal?.aborted ||
      lastError instanceof SearchClientAbortError ||
      lastError?.isClientAbort === true ||
      lastError?.reason === "client_cancelled"
    ) {
      return createClientAbortRouteResult(diagnostic);
    }

    if (lastError?.status === 400 || lastError?.reason === "bad_request") {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          lastError.message || "Invalid search request parameters",
          "invalid_request_error",
          "bad_request",
        ),
        diagnostic,
      };
    }

    if (lastError?.status === 401 || lastError?.reason === "unauthorized") {
      return {
        ok: false,
        status: 401,
        error: createErrorResponse(
          lastError.message || "Upstream search provider authentication failed",
          "invalid_request_error",
          "invalid_api_key",
        ),
        diagnostic,
      };
    }

    if (
      lastError?.status === 403 ||
      lastError?.reason === "forbidden" ||
      lastError?.reason === "policy_quarantine"
    ) {
      return {
        ok: false,
        status: 403,
        error: createErrorResponse(
          lastError.message ||
            "Search provider access forbidden or quarantined by policy",
          "invalid_request_error",
          lastError.reason === "policy_quarantine"
            ? "policy_quarantine"
            : "forbidden",
        ),
        diagnostic,
      };
    }

    const isDeadlineExpired =
      deadlineController.signal.aborted || now() - startTime >= totalDeadlineMs;
    if (
      isDeadlineExpired ||
      lastError instanceof SearchTimeoutError ||
      lastError?.reason === "upstream_timeout" ||
      lastError?.status === 504
    ) {
      return createDeadlineExceededResult(
        diagnostic,
        isDeadlineExpired
          ? "Total search request deadline exceeded"
          : "All upstream search providers timed out",
      );
    }

    if (
      lastError?.status === 429 ||
      lastError?.status === 402 ||
      lastError?.reason === "rate_limit_exceeded" ||
      lastError?.reason === "quota_exceeded"
    ) {
      const headers: Record<string, string> = {};
      if (lastRetryAfter) {
        headers["Retry-After"] = lastRetryAfter;
      }
      return {
        ok: false,
        status: 429,
        error: createErrorResponse(
          "All upstream search providers exceeded rate limits or quota",
          "invalid_request_error",
          "rate_limit_exceeded",
        ),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        diagnostic,
      };
    }

    if (lastError?.status === 503) {
      return {
        ok: false,
        status: 503,
        error: createErrorResponse(
          "All upstream search providers are currently unavailable",
          "api_error",
          "service_unavailable",
        ),
        diagnostic,
      };
    }

    return {
      ok: false,
      status: 502,
      error: createErrorResponse(
        "All upstream search providers failed to fulfill the request",
        "api_error",
        "bad_gateway",
      ),
      diagnostic,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Stateful sequential search router with configurable provider priority and timeouts.
 */
export class SearchRouter {
  private readonly providers: readonly SearchProvider[] | undefined;
  private readonly defaultOptions: SearchRouterOptions | undefined;

  constructor(
    providers?: readonly SearchProvider[],
    defaultOptions?: SearchRouterOptions,
  ) {
    this.providers = providers;
    this.defaultOptions = defaultOptions;
  }

  /**
   * Routes a search request across the configured providers.
   */
  async route(
    req: SearchRequest,
    env: SearchRouterEnv = {},
    options?: SearchRouterOptions,
  ): Promise<SearchRouteResult> {
    return routeSearchRequest(req, this.providers, env, {
      ...this.defaultOptions,
      ...options,
    });
  }
}
