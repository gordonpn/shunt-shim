import { describe, expect, it } from "vitest";
import {
  filterEligibleProviders,
  hasValidMonthlySpendCap,
  isCardBackedProviderAllowed,
  isFreeOnlyPolicyEnabled,
  isProviderEligible,
  type QuotaCandidateProvider,
  type SearchQuotaPolicyEnv,
} from "../../src/search/quota/policy.js";

const FREE_PROVIDER: QuotaCandidateProvider = {
  id: "tavily",
  name: "Tavily",
  requiresCreditCard: false,
  hasCredentials: true,
};

const SECOND_FREE_PROVIDER: QuotaCandidateProvider = {
  id: "serper",
  name: "Serper",
  requiresCreditCard: false,
  hasCredentials: true,
};

const CARD_BACKED_PROVIDER: QuotaCandidateProvider = {
  id: "brave",
  name: "Brave Search",
  requiresCreditCard: true,
  hasCredentials: true,
};

describe("isFreeOnlyPolicyEnabled", () => {
  it("defaults to true when FREE_ONLY_POLICY is unset or empty", () => {
    expect(isFreeOnlyPolicyEnabled({})).toBe(true);
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "" })).toBe(true);
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "   " })).toBe(true);
  });

  it("returns true for truthy or unrecognized strings (fail-closed)", () => {
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "true" })).toBe(true);
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "TRUE" })).toBe(true);
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "1" })).toBe(true);
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "invalid" })).toBe(true);
  });

  it("returns false only when FREE_ONLY_POLICY is explicitly 'false' (case-insensitive)", () => {
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: "false" })).toBe(false);
    expect(isFreeOnlyPolicyEnabled({ FREE_ONLY_POLICY: " FALSE " })).toBe(
      false,
    );
  });
});

describe("hasValidMonthlySpendCap", () => {
  it("returns true for finite positive numeric values", () => {
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "10" })).toBe(true);
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "0.01" })).toBe(
      true,
    );
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: " 25.5 " })).toBe(
      true,
    );
  });

  it("returns false for missing, zero, negative, or non-numeric values", () => {
    expect(hasValidMonthlySpendCap({})).toBe(false);
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "" })).toBe(false);
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "0" })).toBe(false);
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "-5" })).toBe(
      false,
    );
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "NaN" })).toBe(
      false,
    );
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "Infinity" })).toBe(
      false,
    );
    expect(hasValidMonthlySpendCap({ MONTHLY_SPEND_CAP_USD: "abc" })).toBe(
      false,
    );
  });
});

describe("isProviderEligible", () => {
  it("allows free-tier providers with credentials under default free-only policy", () => {
    expect(isProviderEligible(FREE_PROVIDER, {})).toBe(true);
    expect(
      isProviderEligible(
        { id: "exa", requiresCreditCard: false },
        { FREE_ONLY_POLICY: "true" },
      ),
    ).toBe(true);
  });

  it("rejects providers explicitly missing credentials", () => {
    expect(
      isProviderEligible({ ...FREE_PROVIDER, hasCredentials: false }, {}),
    ).toBe(false);
  });

  it("quarantines card-backed providers unless all three billing safeguards are satisfied", () => {
    expect(isProviderEligible(CARD_BACKED_PROVIDER, {})).toBe(false);
    expect(
      isProviderEligible(CARD_BACKED_PROVIDER, {
        FREE_ONLY_POLICY: "false",
      }),
    ).toBe(false);
    expect(
      isProviderEligible(CARD_BACKED_PROVIDER, {
        FREE_ONLY_POLICY: "false",
        ALLOW_CARD_BACKED_PROVIDERS: "true",
      }),
    ).toBe(false);
    expect(
      isProviderEligible(CARD_BACKED_PROVIDER, {
        FREE_ONLY_POLICY: "false",
        ALLOW_CARD_BACKED_PROVIDERS: "true",
        MONTHLY_SPEND_CAP_USD: "0",
      }),
    ).toBe(false);
    expect(
      isProviderEligible(CARD_BACKED_PROVIDER, {
        FREE_ONLY_POLICY: "true",
        ALLOW_CARD_BACKED_PROVIDERS: "true",
        MONTHLY_SPEND_CAP_USD: "20",
      }),
    ).toBe(false);
  });

  it("allows card-backed providers only when FREE_ONLY_POLICY=false, ALLOW_CARD_BACKED_PROVIDERS=true, and MONTHLY_SPEND_CAP_USD > 0", () => {
    const unlockedEnv: SearchQuotaPolicyEnv = {
      FREE_ONLY_POLICY: "false",
      ALLOW_CARD_BACKED_PROVIDERS: "true",
      MONTHLY_SPEND_CAP_USD: "15",
    };
    expect(isCardBackedProviderAllowed(unlockedEnv)).toBe(true);
    expect(isProviderEligible(CARD_BACKED_PROVIDER, unlockedEnv)).toBe(true);
  });
});

describe("filterEligibleProviders", () => {
  it("filters out card-backed providers in auto mode while keeping eligible free providers", () => {
    const result = filterEligibleProviders(
      [FREE_PROVIDER, CARD_BACKED_PROVIDER, SECOND_FREE_PROVIDER],
      {},
      "auto",
    );

    expect(result).toEqual({
      ok: true,
      providers: [FREE_PROVIDER, SECOND_FREE_PROVIDER],
    });
  });

  it("returns 403 provider_quarantined_for_billing_safety when a quarantined card-backed provider is explicitly requested", () => {
    const result = filterEligibleProviders(
      [FREE_PROVIDER, CARD_BACKED_PROVIDER],
      {},
      "brave",
    );

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

  it("returns 503 no_eligible_free_providers when zero eligible providers remain", () => {
    const result = filterEligibleProviders([CARD_BACKED_PROVIDER], {});

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: {
        error: {
          message: "No eligible free-tier search providers are available",
          type: "service_unavailable",
          param: null,
          code: "no_eligible_free_providers",
        },
      },
    });
  });

  it("returns 503 no_eligible_free_providers when an explicitly requested free provider lacks credentials", () => {
    const result = filterEligibleProviders(
      [{ ...FREE_PROVIDER, hasCredentials: false }],
      {},
      "tavily",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error.error.code).toBe("no_eligible_free_providers");
    }
  });

  it("returns the requested card-backed provider when all billing safeguards are explicitly unlocked", () => {
    const unlockedEnv: SearchQuotaPolicyEnv = {
      FREE_ONLY_POLICY: "false",
      ALLOW_CARD_BACKED_PROVIDERS: "true",
      MONTHLY_SPEND_CAP_USD: "50",
    };

    const result = filterEligibleProviders(
      [FREE_PROVIDER, CARD_BACKED_PROVIDER],
      unlockedEnv,
      "brave",
    );

    expect(result).toEqual({
      ok: true,
      providers: [CARD_BACKED_PROVIDER],
    });
  });
});
