export interface GatewayEnv {
  GATEWAY_TOKENS?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  PRIMARY_MODEL?: string;
  FALLBACK_MODEL?: string;
  PRIMARY_PROVIDER?: "groq" | "gemini";
  GROQ_BASE_URL?: string;
  GEMINI_BASE_URL?: string;
}

export const ALLOWED_PRIMARY_PROVIDERS = ["groq", "gemini"] as const;

export const ALLOWED_PRIMARY_MODELS = ["qwen/qwen3.8-27b"] as const;

export const ALLOWED_FALLBACK_MODELS = ["gemini-2.5-flash-lite"] as const;

/**
 * Validates the required and optional gateway environment variables.
 *
 * @param env - Environment bindings containing secrets and model configuration.
 * @throws Error if any required secret is missing or if configured models are not allowed.
 */
export function validateEnvironment(env: GatewayEnv): void {
  const gatewayTokens = env.GATEWAY_TOKENS?.trim();
  if (!gatewayTokens) {
    throw new Error("Missing required environment secret: GATEWAY_TOKENS");
  }

  const groqApiKey = env.GROQ_API_KEY?.trim();
  if (!groqApiKey) {
    throw new Error("Missing required environment secret: GROQ_API_KEY");
  }

  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    throw new Error("Missing required environment secret: GEMINI_API_KEY");
  }

  if (env.PRIMARY_MODEL !== undefined) {
    const isAllowedPrimary = (
      ALLOWED_PRIMARY_MODELS as readonly string[]
    ).includes(env.PRIMARY_MODEL);
    if (!isAllowedPrimary) {
      throw new Error("Disallowed PRIMARY_MODEL configuration");
    }
  }

  if (env.FALLBACK_MODEL !== undefined) {
    const isAllowedFallback = (
      ALLOWED_FALLBACK_MODELS as readonly string[]
    ).includes(env.FALLBACK_MODEL);
    if (!isAllowedFallback) {
      throw new Error("Disallowed FALLBACK_MODEL configuration");
    }
  }

  if (env.PRIMARY_PROVIDER !== undefined) {
    const isAllowedProvider = (
      ALLOWED_PRIMARY_PROVIDERS as readonly string[]
    ).includes(env.PRIMARY_PROVIDER);
    if (!isAllowedProvider) {
      throw new Error("Disallowed PRIMARY_PROVIDER configuration");
    }
  }

  for (const [name, value] of [
    ["GROQ_BASE_URL", env.GROQ_BASE_URL],
    ["GEMINI_BASE_URL", env.GEMINI_BASE_URL],
  ] as const) {
    if (value !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`Invalid ${name} configuration: must be a valid URL`);
      }
      if (parsed.protocol !== "https:") {
        throw new Error(`Disallowed ${name} protocol: must use https`);
      }
    }
  }
}
