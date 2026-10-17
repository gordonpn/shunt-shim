import { type Context, Hono, type MiddlewareHandler } from "hono";

export interface GatewayEnv {
  GATEWAY_TOKENS?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  PRIMARY_MODEL?: string;
  FALLBACK_MODEL?: string;
}

export const ALLOWED_PRIMARY_MODELS = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
] as const;

export const ALLOWED_FALLBACK_MODELS = ["gemini-2.5-flash-lite"] as const;

export function validateEnvironment(_env: GatewayEnv): void {
  // Stub for red-phase verification
}

export interface ApiError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

export function createErrorResponse(
  message: string,
  type: string,
  code: string,
  param?: string | null,
): ApiError {
  const errorParam = param ?? null;
  return {
    error: {
      message,
      type,
      param: errorParam,
      code,
    },
  };
}

export const authMiddleware: MiddlewareHandler<{
  Bindings: GatewayEnv;
}> = async (c, next) => {
  const configuredToken = c.env?.GATEWAY_TOKENS;
  const authHeader = c.req.header("Authorization");
  const apiKeyHeader = c.req.header("x-api-key");

  let bearerToken: string | undefined;
  if (authHeader) {
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

  if (bearerToken && apiKeyHeader && bearerToken !== apiKeyHeader) {
    return c.json(
      createErrorResponse(
        "Conflicting Authorization and x-api-key headers provided",
        "invalid_request_error",
        "invalid_api_key",
      ),
      400,
    );
  }

  const token = bearerToken ?? apiKeyHeader;
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

export const app = new Hono<{ Bindings: GatewayEnv }>();

app.get("/", (c) => {
  return c.json({ status: "ok", service: "shunt-shim" });
});

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "shunt-shim" });
});

app.get("/v1/models", authMiddleware, (c) => {
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

interface ChatCompletionRequestBody {
  model?: string;
  stream?: boolean;
}

const handleChatCompletions = async (c: Context<{ Bindings: GatewayEnv }>) => {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json(
      createErrorResponse(
        "Invalid JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
      400,
    );
  }

  const body = parsed as ChatCompletionRequestBody;

  if (!body.model || body.model !== "fast") {
    const requestedModel = body.model ?? "";
    return c.json(
      createErrorResponse(
        `The model '${requestedModel}' does not exist or is not available.`,
        "invalid_request_error",
        "model_not_found",
        "model",
      ),
      404,
    );
  }

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream === true) {
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

  return c.json({
    id: completionId,
    object: "chat.completion",
    created,
    model: "fast",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "shunt-shim gateway bootstrap",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
};

app.post("/v1/chat/completions", authMiddleware, handleChatCompletions);
app.post("/chat/completions", authMiddleware, handleChatCompletions);

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
