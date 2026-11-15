import { describe, expect, it } from "vitest";
import {
  filterEligibleProviders,
  type QuotaCandidateProvider,
  type SearchQuotaPolicyEnv,
} from "../src/search/quota/policy.js";
import { SearchQuotaTracker } from "../src/search/quota/tracker.js";

const CANDIDATE_PROVIDERS: readonly QuotaCandidateProvider[] = [
  { id: "tavily", name: "Tavily", requiresCreditCard: false },
  { id: "exa", name: "Exa", requiresCreditCard: false },
  { id: "brave", name: "Brave Search", requiresCreditCard: true },
  { id: "parallel", name: "Parallel Search", requiresCreditCard: true },
];

describe("Integrated search quota policy and rate-limit tracker (#130)", () => {
  it("combines policy eligibility filtering with cooldown availability for provider selection", () => {
    const tracker = new SearchQuotaTracker();
    const nowMs = 1_700_000_000_000;
    const env: SearchQuotaPolicyEnv = {
      BRAVE_API_KEY: "bsa-present-but-quarantined",
      TAVILY_API_KEY: "tvly-key",
      EXA_API_KEY: "exa-key",
    };

    const policyResult = filterEligibleProviders(
      CANDIDATE_PROVIDERS,
      env,
      "auto",
    );
    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) {
      return;
    }

    expect(policyResult.providers.map((p) => p.id)).toEqual(["tavily", "exa"]);

    // Simulate HTTP 429 on primary free provider (tavily) with Retry-After: 90
    tracker.recordRateLimit("tavily", "90", nowMs);

    const availableAtErrorTime = policyResult.providers.filter((provider) =>
      tracker.isAvailable(provider.id, nowMs + 10_000),
    );
    expect(availableAtErrorTime.map((p) => p.id)).toEqual(["exa"]);

    // Record successful fallback query on exa
    tracker.recordSuccess("exa");
    expect(tracker.getStatus("exa")).toEqual({
      consecutiveFailures: 0,
      cooldownUntil: null,
      estimatedQueriesThisWindow: 1,
    });

    // After 90s cooldown expires, tavily becomes eligible and available again
    const availableAfterCooldown = policyResult.providers.filter((provider) =>
      tracker.isAvailable(provider.id, nowMs + 90_000),
    );
    expect(availableAfterCooldown.map((p) => p.id)).toEqual(["tavily", "exa"]);
  });

  it("enforces fail-closed 403 quarantine for card-backed providers regardless of tracker availability", () => {
    const tracker = new SearchQuotaTracker();
    const env: SearchQuotaPolicyEnv = {
      FREE_ONLY_POLICY: "false",
      ALLOW_CARD_BACKED_PROVIDERS: "true",
      // Missing MONTHLY_SPEND_CAP_USD keeps card-backed providers quarantined
    };

    expect(tracker.isAvailable("brave")).toBe(true);

    const result = filterEligibleProviders(CANDIDATE_PROVIDERS, env, "brave");
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: {
        error: {
          message:
            "Requested search provider is quarantined under free-only billing policy",
          type: "policy_error",
          param: null,
          code: "provider_quarantined_for_billing_safety",
        },
      },
    });
  });
});
