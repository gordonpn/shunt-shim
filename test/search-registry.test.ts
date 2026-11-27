import { describe, expect, it, vi } from "vitest";
import type {
  RawSearchExecutionResult,
  SearchProvider,
  SearchProviderCapabilities,
  SearchProviderEnv,
  SearchProviderRegistration,
  SearchRequest,
} from "../src/search/provider.js";
import {
  DEFAULT_PROVIDER_SECRET_KEYS,
  hasConfiguredSecret,
  SearchProviderRegistry,
} from "../src/search/registry.js";

interface StubProviderOptions {
  readonly id: string;
  readonly name?: string;
  readonly requiresCreditCard?: boolean;
  readonly capabilities?: SearchProviderCapabilities;
  readonly apiKey?: string;
}

function createStubProvider(options: StubProviderOptions): SearchProvider {
  const capabilities: SearchProviderCapabilities = options.capabilities ?? {
    supportsDomainFilter: true,
    supportsSearchDepth: true,
    supportsFreshness: false,
  };

  return {
    id: options.id,
    name: options.name ?? `Provider ${options.id}`,
    requiresCreditCard: options.requiresCreditCard ?? false,
    capabilities,
    estimateCost(req: SearchRequest): number {
      return req.search_depth === "advanced" ? 2 : 1;
    },
    async search(
      req: SearchRequest,
      _env: SearchProviderEnv,
      signal: AbortSignal,
    ): Promise<RawSearchExecutionResult> {
      if (signal.aborted) {
        throw new Error("Aborted");
      }
      return {
        provider: options.id,
        creditsUsed: req.search_depth === "advanced" ? 2 : 1,
        upstreamStatus: 200,
        results: [
          {
            title: `Result for ${req.query}`,
            url: `https://${options.id}.example.com/search`,
            snippet: `Key=${options.apiKey ?? "none"}`,
            published_date: null,
            score: 0.95,
            provider: options.id,
          },
        ],
      };
    },
  };
}

function createStandardRegistrations(): SearchProviderRegistration[] {
  return [
    {
      id: "tavily",
      secretKey: DEFAULT_PROVIDER_SECRET_KEYS.tavily,
      factory: (apiKey) =>
        createStubProvider({
          id: "tavily",
          name: "Tavily",
          requiresCreditCard: false,
          capabilities: {
            supportsDomainFilter: true,
            supportsSearchDepth: true,
            supportsFreshness: true,
          },
          apiKey,
        }),
    },
    {
      id: "exa",
      secretKey: DEFAULT_PROVIDER_SECRET_KEYS.exa,
      factory: (apiKey) =>
        createStubProvider({
          id: "exa",
          name: "Exa",
          requiresCreditCard: false,
          capabilities: {
            supportsDomainFilter: true,
            supportsSearchDepth: false,
            supportsFreshness: true,
          },
          apiKey,
        }),
    },
    {
      id: "brave",
      secretKey: DEFAULT_PROVIDER_SECRET_KEYS.brave,
      factory: (apiKey) =>
        createStubProvider({
          id: "brave",
          name: "Brave Search",
          requiresCreditCard: true,
          capabilities: {
            supportsDomainFilter: false,
            supportsSearchDepth: false,
            supportsFreshness: true,
          },
          apiKey,
        }),
    },
    {
      id: "parallel",
      secretKey: DEFAULT_PROVIDER_SECRET_KEYS.parallel,
      factory: (apiKey) =>
        createStubProvider({
          id: "parallel",
          name: "Parallel",
          requiresCreditCard: false,
          apiKey,
        }),
    },
    {
      id: "linkup",
      secretKey: DEFAULT_PROVIDER_SECRET_KEYS.linkup,
      factory: (apiKey) =>
        createStubProvider({
          id: "linkup",
          name: "Linkup",
          requiresCreditCard: false,
          apiKey,
        }),
    },
  ];
}

describe("SearchProvider contract and capabilities", () => {
  it("exposes capabilities, requiresCreditCard, estimateCost, and search execution", async () => {
    const registry = new SearchProviderRegistry(createStandardRegistrations());
    const env: SearchProviderEnv = {
      TAVILY_API_KEY: "tvly-secret-123",
      BRAVE_API_KEY: "bsa-secret-456",
    };

    const tavily = registry.getProvider("tavily", env);
    const brave = registry.getProvider("brave", env);

    expect(tavily).toBeDefined();
    expect(brave).toBeDefined();

    expect(tavily?.requiresCreditCard).toBe(false);
    expect(tavily?.capabilities).toEqual({
      supportsDomainFilter: true,
      supportsSearchDepth: true,
      supportsFreshness: true,
    });

    expect(brave?.requiresCreditCard).toBe(true);
    expect(brave?.capabilities).toEqual({
      supportsDomainFilter: false,
      supportsSearchDepth: false,
      supportsFreshness: true,
    });

    const basicRequest: SearchRequest = {
      query: "cloudflare workers",
      max_results: 5,
      search_depth: "basic",
      provider: "auto",
    };
    const advancedRequest: SearchRequest = {
      query: "cloudflare workers",
      max_results: 5,
      search_depth: "advanced",
      include_domains: ["developers.cloudflare.com"],
      exclude_domains: ["example.com"],
      provider: "tavily",
    };

    expect(tavily?.estimateCost(basicRequest)).toBe(1);
    expect(tavily?.estimateCost(advancedRequest)).toBe(2);

    const controller = new AbortController();
    const executionResult = await tavily?.search(
      advancedRequest,
      env,
      controller.signal,
    );
    expect(executionResult).toEqual({
      provider: "tavily",
      creditsUsed: 2,
      upstreamStatus: 200,
      results: [
        {
          title: "Result for cloudflare workers",
          url: "https://tavily.example.com/search",
          snippet: "Key=tvly-secret-123",
          published_date: null,
          score: 0.95,
          provider: "tavily",
        },
      ],
    });
  });
});

describe("SearchProviderRegistry credential detection and lookup", () => {
  it("verifies secret configuration and rejects missing or whitespace-only values", () => {
    const registry = new SearchProviderRegistry();
    const env: SearchProviderEnv = {
      TAVILY_API_KEY: "  tvly-valid  ",
      EXA_API_KEY: "   ",
      BRAVE_API_KEY: "",
    };

    expect(hasConfiguredSecret(env, "TAVILY_API_KEY")).toBe(true);
    expect(registry.hasConfiguredSecret(env, "TAVILY_API_KEY")).toBe(true);
    expect(registry.hasConfiguredSecret(env, "EXA_API_KEY")).toBe(false);
    expect(registry.hasConfiguredSecret(env, "BRAVE_API_KEY")).toBe(false);
    expect(registry.hasConfiguredSecret(env, "PARALLEL_API_KEY")).toBe(false);
  });

  it("omits providers without configured API keys from the active pool", () => {
    const registry = new SearchProviderRegistry(createStandardRegistrations());

    expect(registry.getRegisteredIds()).toEqual([
      "tavily",
      "exa",
      "brave",
      "parallel",
      "linkup",
    ]);

    const partialEnv: SearchProviderEnv = {
      EXA_API_KEY: "exa-key-1",
      LINKUP_API_KEY: "  linkup-key-2  ",
      TAVILY_API_KEY: "   ",
    };

    const available = registry.getAvailableProviders(partialEnv);
    expect(available.map((p) => p.id)).toEqual(["exa", "linkup"]);
  });

  it("passes trimmed API keys and environment to provider factories", () => {
    const factorySpy = vi.fn((apiKey: string, _env: SearchProviderEnv) =>
      createStubProvider({ id: "tavily", apiKey }),
    );
    const registry = new SearchProviderRegistry([
      {
        id: "tavily",
        secretKey: "TAVILY_API_KEY",
        factory: factorySpy,
      },
    ]);

    const env: SearchProviderEnv = {
      TAVILY_API_KEY: "  tvly-trimmed-key  ",
    };

    const provider = registry.getProvider("tavily", env);
    expect(provider).toBeDefined();
    expect(factorySpy).toHaveBeenCalledOnce();
    expect(factorySpy).toHaveBeenCalledWith("tvly-trimmed-key", env);
  });

  it("looks up providers by ID case-insensitively and returns undefined when unconfigured or unknown", () => {
    const registry = new SearchProviderRegistry(createStandardRegistrations());
    const env: SearchProviderEnv = {
      TAVILY_API_KEY: "tvly-key",
    };

    expect(registry.getProvider("tavily", env)?.id).toBe("tavily");
    expect(registry.getProvider("  TAVILY ", env)?.id).toBe("tavily");
    expect(registry.getProvider("exa", env)).toBeUndefined();
    expect(registry.getProvider("unknown", env)).toBeUndefined();
    expect(registry.getProvider("   ", env)).toBeUndefined();
  });

  it("preserves registration order by default and promotes PRIMARY_SEARCH_PROVIDER when configured", () => {
    const registry = new SearchProviderRegistry(createStandardRegistrations());
    const baseEnv: SearchProviderEnv = {
      TAVILY_API_KEY: "tvly-1",
      EXA_API_KEY: "exa-2",
      BRAVE_API_KEY: "brave-3",
    };

    expect(
      registry.getAvailableProviders(baseEnv).map((provider) => provider.id),
    ).toEqual(["tavily", "exa", "brave"]);

    const promotedEnv: SearchProviderEnv = {
      ...baseEnv,
      PRIMARY_SEARCH_PROVIDER: "  BRAVE ",
    };
    expect(
      registry
        .getAvailableProviders(promotedEnv)
        .map((provider) => provider.id),
    ).toEqual(["brave", "tavily", "exa"]);

    // Unconfigured primary provider does not alter order or throw
    const unconfiguredPrimaryEnv: SearchProviderEnv = {
      ...baseEnv,
      PRIMARY_SEARCH_PROVIDER: "parallel",
    };
    expect(
      registry
        .getAvailableProviders(unconfiguredPrimaryEnv)
        .map((provider) => provider.id),
    ).toEqual(["tavily", "exa", "brave"]);

    const whitespacePrimaryEnv: SearchProviderEnv = {
      TAVILY_API_KEY: "tvly-secret-123",
      EXA_API_KEY: "exa-secret-456",
      PRIMARY_SEARCH_PROVIDER: "   ",
    };

    expect(
      registry
        .getAvailableProviders(whitespacePrimaryEnv)
        .map((provider) => provider.id),
    ).toEqual(["tavily", "exa"]);
  });

  it("rejects empty provider IDs during registration and allows overriding existing registrations", () => {
    const registry = new SearchProviderRegistry();
    expect(() =>
      registry.register({
        id: "   ",
        secretKey: "TAVILY_API_KEY",
        factory: (apiKey) => createStubProvider({ id: "empty", apiKey }),
      }),
    ).toThrow("Search provider registration id must not be empty.");

    registry.register({
      id: "Tavily",
      secretKey: "TAVILY_API_KEY",
      factory: (apiKey) =>
        createStubProvider({ id: "tavily", name: "Tavily v1", apiKey }),
    });
    registry.register({
      id: "tavily",
      secretKey: "TAVILY_API_KEY",
      factory: (apiKey) =>
        createStubProvider({ id: "tavily", name: "Tavily v2", apiKey }),
    });

    expect(registry.getRegisteredIds()).toEqual(["tavily"]);
    expect(
      registry.getProvider("tavily", { TAVILY_API_KEY: "key" })?.name,
    ).toBe("Tavily v2");
  });
});
