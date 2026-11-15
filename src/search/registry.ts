import type {
  SearchProvider,
  SearchProviderEnv,
  SearchProviderRegistration,
} from "./provider.js";

export const DEFAULT_PROVIDER_SECRET_KEYS = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  parallel: "PARALLEL_API_KEY",
  linkup: "LINKUP_API_KEY",
} as const satisfies Record<string, keyof SearchProviderEnv>;

export type DefaultSearchProviderId = keyof typeof DEFAULT_PROVIDER_SECRET_KEYS;

function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase();
}

function getConfiguredSecret(
  env: SearchProviderEnv,
  secretKey: keyof SearchProviderEnv,
): string | undefined {
  const value = env[secretKey];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function hasConfiguredSecret(
  env: SearchProviderEnv,
  secretKey: keyof SearchProviderEnv,
): boolean {
  return getConfiguredSecret(env, secretKey) !== undefined;
}

export class SearchProviderRegistry {
  private readonly registrations = new Map<
    string,
    SearchProviderRegistration
  >();

  constructor(registrations: readonly SearchProviderRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: SearchProviderRegistration): void {
    const normalizedId = normalizeProviderId(registration.id);
    if (normalizedId.length === 0) {
      throw new Error("Search provider registration id must not be empty.");
    }
    this.registrations.set(normalizedId, {
      ...registration,
      id: normalizedId,
    });
  }

  hasConfiguredSecret(
    env: SearchProviderEnv,
    secretKey: keyof SearchProviderEnv,
  ): boolean {
    return hasConfiguredSecret(env, secretKey);
  }

  getRegisteredIds(): string[] {
    return Array.from(this.registrations.keys());
  }

  getProvider(id: string, env: SearchProviderEnv): SearchProvider | undefined {
    const normalizedId = normalizeProviderId(id);
    if (normalizedId.length === 0) {
      return undefined;
    }
    const registration = this.registrations.get(normalizedId);
    if (!registration) {
      return undefined;
    }
    const apiKey = getConfiguredSecret(env, registration.secretKey);
    if (apiKey === undefined) {
      return undefined;
    }
    return registration.factory(apiKey, env);
  }

  getAvailableProviders(env: SearchProviderEnv): SearchProvider[] {
    const available: SearchProvider[] = [];
    for (const registration of this.registrations.values()) {
      const apiKey = getConfiguredSecret(env, registration.secretKey);
      if (apiKey !== undefined) {
        available.push(registration.factory(apiKey, env));
      }
    }

    const primaryRaw = env.PRIMARY_SEARCH_PROVIDER;
    if (typeof primaryRaw === "string") {
      const primaryId = normalizeProviderId(primaryRaw);
      if (primaryId.length > 0) {
        const primaryIndex = available.findIndex(
          (provider) => normalizeProviderId(provider.id) === primaryId,
        );
        if (primaryIndex > 0) {
          const [primaryProvider] = available.splice(primaryIndex, 1);
          if (primaryProvider !== undefined) {
            available.unshift(primaryProvider);
          }
        }
      }
    }

    return available;
  }
}
