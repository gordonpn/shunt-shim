import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKOFF_STEPS_SECONDS,
  DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS,
  defaultQuotaTracker,
  parseRetryAfterSeconds,
  resetDefaultQuotaTracker,
  SearchQuotaTracker,
} from "../../src/search/quota/tracker.js";

describe("parseRetryAfterSeconds", () => {
  const baseNowMs = Date.parse("2026-11-15T00:00:00.000Z");

  it("parses numeric delta-seconds from strings and numbers", () => {
    expect(parseRetryAfterSeconds("45", baseNowMs)).toBe(45);
    expect(parseRetryAfterSeconds(" 120 ", baseNowMs)).toBe(120);
    expect(parseRetryAfterSeconds(30, baseNowMs)).toBe(30);
    expect(parseRetryAfterSeconds("1.2", baseNowMs)).toBe(2);
  });

  it("parses future HTTP-date strings relative to nowMs", () => {
    const futureDate = "Sun, 15 Nov 2026 00:01:30 GMT";
    expect(parseRetryAfterSeconds(futureDate, baseNowMs)).toBe(90);
  });

  it("returns null for missing, invalid, zero, negative, or past values", () => {
    expect(parseRetryAfterSeconds(null, baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds(undefined, baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds("", baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds("   ", baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds("0", baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds("-15", baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds(0, baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds(-5, baseNowMs)).toBeNull();
    expect(parseRetryAfterSeconds("not-a-date", baseNowMs)).toBeNull();
    expect(
      parseRetryAfterSeconds("Sat, 14 Nov 2026 23:59:00 GMT", baseNowMs),
    ).toBeNull();
  });
});

describe("SearchQuotaTracker", () => {
  let tracker: SearchQuotaTracker;
  const baseNowMs = 1_700_000_000_000;

  beforeEach(() => {
    tracker = new SearchQuotaTracker();
    resetDefaultQuotaTracker();
  });

  it("initializes cold-start providers as available with zero counters", () => {
    expect(tracker.isAvailable("tavily", baseNowMs)).toBe(true);
    expect(tracker.getStatus("tavily")).toEqual({
      consecutiveFailures: 0,
      cooldownUntil: null,
      estimatedQueriesThisWindow: 0,
    });
  });

  it("applies Retry-After duration on HTTP 429 when header is present", () => {
    const status = tracker.recordRateLimit("tavily", "45", baseNowMs);
    expect(status).toEqual({
      consecutiveFailures: 1,
      cooldownUntil: baseNowMs + 45_000,
      estimatedQueriesThisWindow: 0,
    });

    expect(tracker.isAvailable("tavily", baseNowMs + 44_999)).toBe(false);
    expect(tracker.isAvailable("tavily", baseNowMs + 45_000)).toBe(true);
  });

  it("applies default 60s cooldown on first 429 without Retry-After and progresses to 120s on consecutive 429s", () => {
    const first = tracker.recordRateLimit("exa", null, baseNowMs);
    expect(first.consecutiveFailures).toBe(1);
    expect(first.cooldownUntil).toBe(
      baseNowMs + DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS * 1000,
    );

    const secondNow = baseNowMs + 60_000;
    const second = tracker.recordRateLimit("exa", "invalid", secondNow);
    expect(second.consecutiveFailures).toBe(2);
    expect(second.cooldownUntil).toBe(
      secondNow + BACKOFF_STEPS_SECONDS[1] * 1000,
    );

    const thirdNow = secondNow + 60_000;
    const third = tracker.recordRateLimit("exa", undefined, thirdNow);
    expect(third.consecutiveFailures).toBe(3);
    expect(third.cooldownUntil).toBe(
      thirdNow + BACKOFF_STEPS_SECONDS[2] * 1000,
    );
  });

  it("follows 30s -> 60s -> 120s exponential backoff progression on recordFailure", () => {
    const first = tracker.recordFailure("serper", baseNowMs);
    expect(first.consecutiveFailures).toBe(1);
    expect(first.cooldownUntil).toBe(baseNowMs + 30_000);
    expect(tracker.isAvailable("serper", baseNowMs + 29_999)).toBe(false);
    expect(tracker.isAvailable("serper", baseNowMs + 30_000)).toBe(true);

    const second = tracker.recordFailure("serper", baseNowMs + 30_000);
    expect(second.consecutiveFailures).toBe(2);
    expect(second.cooldownUntil).toBe(baseNowMs + 30_000 + 60_000);

    const third = tracker.recordFailure("serper", baseNowMs + 90_000);
    expect(third.consecutiveFailures).toBe(3);
    expect(third.cooldownUntil).toBe(baseNowMs + 90_000 + 120_000);

    const fourth = tracker.recordFailure("serper", baseNowMs + 210_000);
    expect(fourth.consecutiveFailures).toBe(4);
    expect(fourth.cooldownUntil).toBe(baseNowMs + 210_000 + 120_000);
  });

  it("resets consecutiveFailures and cooldownUntil on recordSuccess while incrementing estimatedQueriesThisWindow", () => {
    tracker.recordFailure("tavily", baseNowMs);
    expect(tracker.isAvailable("tavily", baseNowMs + 1_000)).toBe(false);

    tracker.recordSuccess("tavily");
    expect(tracker.isAvailable("tavily", baseNowMs + 1_000)).toBe(true);
    expect(tracker.getStatus("tavily")).toEqual({
      consecutiveFailures: 0,
      cooldownUntil: null,
      estimatedQueriesThisWindow: 1,
    });

    tracker.recordSuccess("TAVILY");
    expect(tracker.getStatus("tavily").estimatedQueriesThisWindow).toBe(2);
  });

  it("supports resetting individual or all providers on defaultQuotaTracker", () => {
    defaultQuotaTracker.recordFailure("tavily", baseNowMs);
    defaultQuotaTracker.recordFailure("exa", baseNowMs);

    defaultQuotaTracker.reset("tavily");
    expect(defaultQuotaTracker.getStatus("tavily").consecutiveFailures).toBe(0);
    expect(defaultQuotaTracker.getStatus("exa").consecutiveFailures).toBe(1);

    resetDefaultQuotaTracker();
    expect(defaultQuotaTracker.getStatus("exa").consecutiveFailures).toBe(0);
  });
});
