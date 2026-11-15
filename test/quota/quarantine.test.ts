import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterEligibleProviders,
  isProviderEligible,
  type QuotaCandidateProvider,
  type SearchQuotaPolicyEnv,
} from "../../src/search/quota/policy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface SimulatedAdapter extends QuotaCandidateProvider {
  readonly endpoint: string;
  executeSearch: (query: string) => Promise<{ provider: string }>;
}

function createCandidateCatalog(
  env: SearchQuotaPolicyEnv,
  fetchFn: typeof fetch,
): SimulatedAdapter[] {
  return [
    {
      id: "brave",
      name: "Brave Search",
      requiresCreditCard: true,
      hasCredentials: Boolean(env.BRAVE_API_KEY),
      endpoint: "https://api.search.brave.com/res/v1/web/search",
      async executeSearch(query: string) {
        await fetchFn(`${this.endpoint}?q=${encodeURIComponent(query)}`, {
          headers: { "X-Subscription-Token": env.BRAVE_API_KEY ?? "" },
        });
        return { provider: this.id };
      },
    },
    {
      id: "parallel",
      name: "Parallel Search",
      requiresCreditCard: true,
      hasCredentials: Boolean(env.PARALLEL_API_KEY),
      endpoint: "https://api.parallel.ai/v1/search",
      async executeSearch(query: string) {
        await fetchFn(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.PARALLEL_API_KEY ?? ""}` },
          body: JSON.stringify({ query }),
        });
        return { provider: this.id };
      },
    },
    {
      id: "tavily",
      name: "Tavily",
      requiresCreditCard: false,
      hasCredentials: Boolean(env.TAVILY_API_KEY),
      endpoint: "https://api.tavily.com/search",
      async executeSearch(query: string) {
        await fetchFn(this.endpoint, {
          method: "POST",
          body: JSON.stringify({ query, api_key: env.TAVILY_API_KEY }),
        });
        return { provider: this.id };
      },
    },
  ];
}

describe("Card-backed provider quarantine negative verification (#132)", () => {
  it.each([
    { label: "default unset FREE_ONLY_POLICY", policyValue: undefined },
    { label: "empty FREE_ONLY_POLICY", policyValue: "" },
    { label: "explicit FREE_ONLY_POLICY=true", policyValue: "true" },
  ])(
    "excludes Brave and Parallel and emits zero requests to quarantined endpoints under $label even when API keys exist",
    async ({ policyValue }) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

      const env: SearchQuotaPolicyEnv = {
        BRAVE_API_KEY: "bsa-secret-brave-key",
        PARALLEL_API_KEY: "par-secret-parallel-key",
        TAVILY_API_KEY: "tvly-free-tier-key",
        ...(policyValue !== undefined ? { FREE_ONLY_POLICY: policyValue } : {}),
      };

      const catalog = createCandidateCatalog(env, fetchSpy);

      for (const candidate of catalog) {
        if (candidate.requiresCreditCard) {
          expect(isProviderEligible(candidate, env)).toBe(false);
        }
      }

      const filtered = filterEligibleProviders(catalog, env, "auto");
      expect(filtered.ok).toBe(true);
      if (filtered.ok) {
        expect(filtered.providers.map((p) => p.id)).toEqual(["tavily"]);
        for (const provider of filtered.providers) {
          await provider.executeSearch("cloudflare workers");
        }
      }

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrls = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(calledUrls).toEqual(["https://api.tavily.com/search"]);
      expect(
        calledUrls.some(
          (url) => url.includes("brave.com") || url.includes("api.parallel.ai"),
        ),
      ).toBe(false);
    },
  );

  it("blocks direct execution and emits zero network calls when only card-backed keys are configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const env: SearchQuotaPolicyEnv = {
      BRAVE_API_KEY: "bsa-secret-brave-key",
      PARALLEL_API_KEY: "par-secret-parallel-key",
    };

    const catalog = createCandidateCatalog(env, fetchSpy);

    const autoSelection = filterEligibleProviders(catalog, env, "auto");
    expect(autoSelection).toEqual({
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

    for (const explicitId of ["brave", "parallel"]) {
      const explicitSelection = filterEligibleProviders(
        catalog,
        env,
        explicitId,
      );
      expect(explicitSelection).toEqual({
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
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
