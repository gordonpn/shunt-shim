import { type Context, Hono, type MiddlewareHandler } from "hono";
import { createErrorResponse } from "./errors.js";
import { forwardChatCompletion } from "./upstream.js";
import {
  readRequestBodyWithLimit,
  validateChatCompletionRequest,
} from "./validation.js";

export {
  type ApiError,
  createErrorResponse,
} from "./errors.js";

export {
  type NormalizedChatCompletion,
  type NormalizedChoice,
  type UpstreamCompletionResult,
  forwardChatCompletion,
} from "./upstream.js";

export {
  MAX_BODY_BYTES,
  type RequestValidationResult,
  readRequestBodyWithLimit,
  type ValidatedChatCompletionRequest,
  type ValidatedFunctionCall,
  type ValidatedFunctionDeclaration,
  type ValidatedMessage,
  type ValidatedStreamOptions,
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
}

export const authMiddleware: MiddlewareHandler<{
  Bindings: GatewayEnv;
}> = async (c, next) => {
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

export const envValidationMiddleware: MiddlewareHandler<{
  Bindings: GatewayEnv;
}> = async (c, next) => {
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

export const app = new Hono<{ Bindings: GatewayEnv }>();

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

const handleChatCompletions = async (c: Context<{ Bindings: GatewayEnv }>) => {
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

  const body = validation.data;
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    const chunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: "fast",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "shunt-shim gateway bootstrap",
          },
          finish_reason: null,
        },
      ],
    };
    const terminalChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: "fast",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };
    const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(terminalChunk)}\n\ndata: [DONE]\n\n`;

    return new Response(sseData, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const upstreamResult = await forwardChatCompletion(body, c.env);
  if (!upstreamResult.ok) {
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
