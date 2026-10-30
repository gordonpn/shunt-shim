import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type DiagnosticRecord, emitDiagnostic } from "./diagnostics.js";
import { createErrorResponse } from "./errors.js";
import {
  forwardChatCompletion,
  type UpstreamDiagnosticMetadata,
} from "./upstream.js";
import {
  readRequestBodyWithLimit,
  validateChatCompletionRequest,
} from "./validation.js";

export {
  DIAGNOSTIC_ALLOWLIST,
  type DiagnosticRecord,
  type DiagnosticSink,
  emitDiagnostic,
  formatDiagnosticLog,
  getCapturedDiagnostics,
  MAX_CAPTURED_RECORDS,
  resetDiagnosticSink,
  setDiagnosticCapture,
  setDiagnosticSink,
} from "./diagnostics.js";

export {
  type ApiError,
  createErrorResponse,
} from "./errors.js";

export {
  type ForwardChatCompletionOptions,
  forwardChatCompletion,
  type NormalizedChatCompletion,
  type NormalizedChoice,
  type UpstreamCompletionResult,
  type UpstreamDiagnosticMetadata,
} from "./upstream.js";

export {
  MAX_BODY_BYTES,
  type RequestValidationResult,
  readRequestBodyWithLimit,
  type ValidatedChatCompletionRequest,
  type ValidatedFunctionCall,
  type ValidatedFunctionDeclaration,
  type ValidatedMessage,
  type ValidatedTool,
  type ValidatedToolCall,
  type ValidatedToolChoice,
  validateChatCompletionRequest,
} from "./validation.js";

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
      throw new Error(
        `Disallowed PRIMARY_MODEL configuration: ${env.PRIMARY_MODEL}`,
      );
    }
  }

  if (env.FALLBACK_MODEL !== undefined) {
    const isAllowedFallback = (
      ALLOWED_FALLBACK_MODELS as readonly string[]
    ).includes(env.FALLBACK_MODEL);
    if (!isAllowedFallback) {
      throw new Error(
        `Disallowed FALLBACK_MODEL configuration: ${env.FALLBACK_MODEL}`,
      );
    }
  }

  if (env.PRIMARY_PROVIDER !== undefined) {
    const isAllowedProvider = (
      ALLOWED_PRIMARY_PROVIDERS as readonly string[]
    ).includes(env.PRIMARY_PROVIDER);
    if (!isAllowedProvider) {
      throw new Error(
        `Disallowed PRIMARY_PROVIDER configuration: ${env.PRIMARY_PROVIDER}`,
      );
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
        throw new Error(`Invalid ${name} configuration: ${value}`);
      }
      if (parsed.protocol !== "https:") {
        throw new Error(`Disallowed ${name} protocol: must use https`);
      }
    }
  }
}

export interface GatewayVariables {
  requestId: string;
  diagnostic?: UpstreamDiagnosticMetadata;
}

export type GatewayContext = Context<{
  Bindings: GatewayEnv;
  Variables: GatewayVariables;
}>;

export type GatewayMiddleware = MiddlewareHandler<{
  Bindings: GatewayEnv;
  Variables: GatewayVariables;
}>;

export const authMiddleware: GatewayMiddleware = async (c, next) => {
  const configuredToken = c.env?.GATEWAY_TOKENS?.trim();
  const authHeader = c.req.header("Authorization");
  const apiKeyHeader = c.req.header("x-api-key");

  let bearerToken: string | undefined;
  if (authHeader !== undefined) {
    if (authHeader.startsWith("Bearer ")) {
      bearerToken = authHeader.slice(7).trim();
    } else {
      return c.json(
        createErrorResponse(
          "Invalid Authorization header format. Expected Bearer <token>",
          "invalid_request_error",
          "invalid_api_key",
        ),
        401,
      );
    }
  }

  let trimmedApiKey: string | undefined;
  if (apiKeyHeader !== undefined) {
    trimmedApiKey = apiKeyHeader.trim();
    if (!trimmedApiKey) {
      return c.json(
        createErrorResponse(
          "Incorrect or missing API key provided",
          "invalid_request_error",
          "invalid_api_key",
        ),
        401,
      );
    }
  }

  if (bearerToken && trimmedApiKey && bearerToken !== trimmedApiKey) {
    return c.json(
      createErrorResponse(
        "Conflicting Authorization and x-api-key headers provided",
        "invalid_request_error",
        "invalid_api_key",
      ),
      401,
    );
  }

  const token = bearerToken ?? trimmedApiKey;
  if (!token || !configuredToken || token !== configuredToken) {
    return c.json(
      createErrorResponse(
        "Incorrect or missing API key provided",
        "invalid_request_error",
        "invalid_api_key",
      ),
      401,
    );
  }

  return await next();
};

export const envValidationMiddleware: GatewayMiddleware = async (c, next) => {
  try {
    validateEnvironment(c.env);
  } catch {
    return c.json(
      createErrorResponse(
        "Internal server configuration error",
        "internal_error",
        "internal_error",
      ),
      500,
    );
  }

  return await next();
};

export const diagnosticsMiddleware: GatewayMiddleware = async (c, next) => {
  const startTime = Date.now();
  const incomingRequestId = c.req.header("x-request-id")?.trim();
  const requestId =
    incomingRequestId && /^[a-zA-Z0-9_-]{1,128}$/.test(incomingRequestId)
      ? incomingRequestId
      : crypto.randomUUID();

  c.set("requestId", requestId);

  try {
    await next();
  } finally {
    const latencyMs = Math.max(0, Date.now() - startTime);
    const status = c.res.status;
    c.res.headers.set("x-request-id", requestId);

    const upstreamDiagnostic = c.get("diagnostic");
    const record: DiagnosticRecord = {
      timestamp: new Date().toISOString(),
      requestId,
      status,
      latencyMs,
      ...(upstreamDiagnostic?.provider !== undefined
        ? { provider: upstreamDiagnostic.provider }
        : {}),
      ...(upstreamDiagnostic?.model !== undefined
        ? { model: upstreamDiagnostic.model }
        : {}),
      ...(upstreamDiagnostic?.fallbackReason !== undefined
        ? { fallbackReason: upstreamDiagnostic.fallbackReason }
        : {}),
      ...(upstreamDiagnostic?.attempts !== undefined
        ? { attempts: upstreamDiagnostic.attempts }
        : {}),
    };

    emitDiagnostic(record);
  }
};

export const app = new Hono<{
  Bindings: GatewayEnv;
  Variables: GatewayVariables;
}>();

app.use("*", diagnosticsMiddleware);

app.get("/", (c) => {
  return c.json({ status: "ok", service: "shunt-shim" });
});

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "shunt-shim" });
});

app.get("/v1/models", authMiddleware, envValidationMiddleware, (c) => {
  return c.json({
    object: "list",
    data: [
      {
        id: "fast",
        object: "model",
        created: 1712000000,
        owned_by: "shunt-shim",
      },
    ],
  });
});

app.on(["POST", "PUT", "DELETE", "PATCH"], "/v1/models", (c) => {
  c.header("Allow", "GET, OPTIONS");
  return c.json(
    createErrorResponse(
      "Method Not Allowed. Supported methods: GET",
      "invalid_request_error",
      "method_not_allowed",
    ),
    405,
  );
});

const handleChatCompletions = async (c: GatewayContext) => {
  if (c.req.raw.signal.aborted) {
    c.set("diagnostic", { attempts: 0 });
    return c.json(
      createErrorResponse(
        "Client closed request or operation timed out",
        "api_error",
        "gateway_timeout",
      ),
      504,
    );
  }

  const bodyReadResult = await readRequestBodyWithLimit(c.req.raw);
  if (!bodyReadResult.ok) {
    return c.json(bodyReadResult.error, bodyReadResult.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyReadResult.text);
  } catch {
    return c.json(
      createErrorResponse(
        "Invalid JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
      400,
    );
  }

  const validation = validateChatCompletionRequest(parsed);
  if (!validation.ok) {
    return c.json(validation.error, validation.status);
  }

  const upstreamResult = await forwardChatCompletion(validation.data, c.env, {
    signal: c.req.raw.signal,
  });
  c.set("diagnostic", upstreamResult.diagnostic);
  if (!upstreamResult.ok) {
    if (upstreamResult.headers) {
      for (const [key, value] of Object.entries(upstreamResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json(upstreamResult.error, upstreamResult.status);
  }

  return c.json(upstreamResult.data);
};

app.post(
  "/v1/chat/completions",
  authMiddleware,
  envValidationMiddleware,
  handleChatCompletions,
);
app.post(
  "/chat/completions",
  authMiddleware,
  envValidationMiddleware,
  handleChatCompletions,
);

app.on(
  ["GET", "PUT", "DELETE", "PATCH"],
  ["/v1/chat/completions", "/chat/completions"],
  (c) => {
    c.header("Allow", "POST, OPTIONS");
    return c.json(
      createErrorResponse(
        "Method Not Allowed. Supported methods: POST",
        "invalid_request_error",
        "method_not_allowed",
      ),
      405,
    );
  },
);

app.notFound((c) => {
  return c.json(
    createErrorResponse("Not Found", "invalid_request_error", "not_found"),
    404,
  );
});

export default app;
