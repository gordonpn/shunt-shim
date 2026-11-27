/**
 * Exponential backoff progression in seconds for consecutive upstream failures.
 */
export const BACKOFF_STEPS_SECONDS = [30, 60, 120] as const;

/**
 * Default cooldown in seconds applied on an initial HTTP 429 when Retry-After is absent or invalid.
 */
export const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 60;

/**
 * Snapshot of in-memory rate-limit and quota tracking state for a single search provider.
 */
export interface ProviderWindowStatus {
  readonly consecutiveFailures: number;
  readonly cooldownUntil: number | null;
  readonly estimatedQueriesThisWindow: number;
}

interface MutableProviderWindowState {
  consecutiveFailures: number;
  cooldownUntil: number | null;
  estimatedQueriesThisWindow: number;
}

/**
 * Parses an HTTP Retry-After header value (delta-seconds or HTTP-date) into positive seconds.
 * Returns null when the header is missing, malformed, or points to a non-future time.
 */
export function parseRetryAfterSeconds(
  headerValue: string | number | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (headerValue === null || headerValue === undefined) {
    return null;
  }

  if (typeof headerValue === "number") {
    if (!Number.isFinite(headerValue) || headerValue <= 0) {
      return null;
    }
    return Math.ceil(headerValue);
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numericSeconds = Number(trimmed);
    if (!Number.isFinite(numericSeconds) || numericSeconds <= 0) {
      return null;
    }
    return Math.ceil(numericSeconds);
  }

  const parsedDateMs = Date.parse(trimmed);
  if (Number.isNaN(parsedDateMs)) {
    return null;
  }

  const deltaSeconds = Math.ceil((parsedDateMs - nowMs) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : null;
}

/**
 * Computes the exponential backoff duration in seconds for a 1-based consecutive failure count.
 */
export function getBackoffSeconds(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) {
    return BACKOFF_STEPS_SECONDS[0];
  }
  if (consecutiveFailures === 2) {
    return BACKOFF_STEPS_SECONDS[1];
  }
  return BACKOFF_STEPS_SECONDS[2];
}

function normalizeProviderKey(providerId: string): string {
  return providerId.trim().toLowerCase();
}

/**
 * Ephemeral in-memory tracker for per-provider cooldown windows, Retry-After headers,
 * and estimated query counts within the current worker isolate lifetime.
 */
export class SearchQuotaTracker {
  private readonly stateByProvider = new Map<
    string,
    MutableProviderWindowState
  >();

  /**
   * Returns a read-only snapshot of the provider status.
   * Cold-start providers initialize with zero failures and no active cooldown.
   */
  getStatus(providerId: string): ProviderWindowStatus {
    const key = normalizeProviderKey(providerId);
    const existing = this.stateByProvider.get(key);
    if (!existing) {
      return {
        consecutiveFailures: 0,
        cooldownUntil: null,
        estimatedQueriesThisWindow: 0,
      };
    }
    return {
      consecutiveFailures: existing.consecutiveFailures,
      cooldownUntil: existing.cooldownUntil,
      estimatedQueriesThisWindow: existing.estimatedQueriesThisWindow,
    };
  }

  /**
   * Returns true if the provider has no active cooldown or its cooldown has expired.
   */
  isAvailable(providerId: string, nowMs: number = Date.now()): boolean {
    const key = normalizeProviderKey(providerId);
    const existing = this.stateByProvider.get(key);
    if (!existing || existing.cooldownUntil === null) {
      return true;
    }
    return nowMs >= existing.cooldownUntil;
  }

  /**
   * Records a successful provider call, incrementing estimated query count
   * and clearing any failure/cooldown state.
   */
  recordSuccess(providerId: string): void {
    const key = normalizeProviderKey(providerId);
    const existing = this.getOrCreateState(key);
    existing.estimatedQueriesThisWindow += 1;
    existing.consecutiveFailures = 0;
    existing.cooldownUntil = null;
  }

  /**
   * Records an HTTP 429 rate-limit response and places the provider into cooldown.
   */
  recordRateLimit(
    providerId: string,
    retryAfter?: string | number | null,
    nowMs: number = Date.now(),
  ): ProviderWindowStatus {
    const key = normalizeProviderKey(providerId);
    const existing = this.getOrCreateState(key);
    existing.consecutiveFailures += 1;

    const parsedRetryAfter = parseRetryAfterSeconds(retryAfter, nowMs);
    const fallbackSeconds =
      existing.consecutiveFailures === 1
        ? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS
        : getBackoffSeconds(existing.consecutiveFailures);
    const cooldownSeconds = parsedRetryAfter ?? fallbackSeconds;

    existing.cooldownUntil = nowMs + cooldownSeconds * 1000;
    return this.getStatus(key);
  }

  /**
   * Records a transient upstream failure and applies exponential backoff (30s -> 60s -> 120s).
   */
  recordFailure(
    providerId: string,
    nowMs: number = Date.now(),
  ): ProviderWindowStatus {
    const key = normalizeProviderKey(providerId);
    const existing = this.getOrCreateState(key);
    existing.consecutiveFailures += 1;

    const cooldownSeconds = getBackoffSeconds(existing.consecutiveFailures);
    existing.cooldownUntil = nowMs + cooldownSeconds * 1000;
    return this.getStatus(key);
  }

  /**
   * Resets tracked state for a specific provider or all providers when omitted.
   */
  reset(providerId?: string): void {
    if (providerId !== undefined) {
      this.stateByProvider.delete(normalizeProviderKey(providerId));
      return;
    }
    this.stateByProvider.clear();
  }

  private getOrCreateState(key: string): MutableProviderWindowState {
    let existing = this.stateByProvider.get(key);
    if (!existing) {
      existing = {
        consecutiveFailures: 0,
        cooldownUntil: null,
        estimatedQueriesThisWindow: 0,
      };
      this.stateByProvider.set(key, existing);
    }
    return existing;
  }
}

/**
 * Default isolate-scoped quota tracker instance.
 */
export const defaultQuotaTracker = new SearchQuotaTracker();

/**
 * Resets the default isolate-scoped quota tracker.
 */
export function resetDefaultQuotaTracker(): void {
  defaultQuotaTracker.reset();
}
