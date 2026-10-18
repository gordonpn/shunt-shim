import { type Context, Hono, type MiddlewareHandler } from "hono";

export interface GatewayEnv {
  GATEWAY_TOKENS?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  PRIMARY_MODEL?: string;
  FALLBACK_MODEL?: string;
}

export const ALLOWED_PRIMARY_MODELS = ["qwen/qwen3.8-27b"] as const;

export const ALLOWED_FALLBACK_MODELS = ["gemini-2.5-flash-lite"] as const;

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

export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10,485,760 bytes

export async function readRequestBodyWithLimit(
  req: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<
  { ok: true; text: string } | { ok: false; status: 413 | 400; error: ApiError }
> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(parsedLength) && parsedLength > limit) {
      return {
        ok: false,
        status: 413,
        error: createErrorResponse(
          `Request body exceeds the maximum permitted size of ${limit} bytes.`,
          "invalid_request_error",
          "payload_too_large",
        ),
      };
    }
  }

  const bodyStream = req.body;
  if (!bodyStream) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Invalid JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
    };
  }

  const reader = bodyStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        return {
          ok: false,
          status: 413,
          error: createErrorResponse(
            `Request body exceeds the maximum permitted size of ${limit} bytes.`,
            "invalid_request_error",
            "payload_too_large",
          ),
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Invalid JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
    };
  }

  if (totalBytes === 0) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Invalid JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
    };
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(merged);
  return { ok: true, text };
}

export interface ValidatedFunctionCall {
  name: string;
  arguments: string;
}

export interface ValidatedToolCall {
  id: string;
  type: "function";
  function: ValidatedFunctionCall;
}

export interface ValidatedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ValidatedToolCall[] | undefined;
  tool_call_id?: string | undefined;
}

export interface ValidatedFunctionDeclaration {
  name: string;
  description?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
}

export interface ValidatedTool {
  type: "function";
  function: ValidatedFunctionDeclaration;
}

export type ValidatedToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

export interface ValidatedStreamOptions {
  include_usage?: boolean | undefined;
}

export interface ValidatedChatCompletionRequest {
  model: "fast";
  messages: ValidatedMessage[];
  tools?: ValidatedTool[] | undefined;
  tool_choice?: ValidatedToolChoice | undefined;
  temperature?: number | undefined;
  max_tokens?: number | undefined;
  stream: boolean;
  stream_options?: ValidatedStreamOptions | undefined;
  extensions: Record<string, unknown>;
}

export type RequestValidationResult =
  | { ok: true; data: ValidatedChatCompletionRequest }
  | { ok: false; status: 404 | 400; error: ApiError };

const ALLOWED_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

const KNOWN_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
]);

function isValidTokenLimit(val: unknown): val is number {
  return (
    typeof val === "number" && Number.isInteger(val) && val > 0 && val <= 8192
  );
}

function isValidTemperature(val: unknown): val is number {
  return (
    typeof val === "number" &&
    !Number.isNaN(val) &&
    Number.isFinite(val) &&
    val >= 0.0 &&
    val <= 2.0
  );
}

export function validateChatCompletionRequest(
  raw: unknown,
): RequestValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Invalid JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
    };
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.model !== "string" || record.model.trim() !== "fast") {
    const requestedModel = typeof record.model === "string" ? record.model : "";
    return {
      ok: false,
      status: 404,
      error: createErrorResponse(
        `The model '${requestedModel}' does not exist or is not available.`,
        "invalid_request_error",
        "model_not_found",
        "model",
      ),
    };
  }

  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Missing or empty messages array in request body.",
        "invalid_request_error",
        "invalid_request_error",
        "messages",
      ),
    };
  }

  for (const item of record.messages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "Each message must be a JSON object.",
          "invalid_request_error",
          "invalid_request_error",
          "messages",
        ),
      };
    }
  }

  const outstandingToolCallIds = new Set<string>();
  const validatedMessages: ValidatedMessage[] = [];

  for (const rawItem of record.messages) {
    const rawMsg = rawItem as Record<string, unknown>;
    const role = rawMsg.role;
    if (typeof role !== "string" || !ALLOWED_MESSAGE_ROLES.has(role)) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          `Unsupported or invalid message role: ${String(role)}`,
          "invalid_request_error",
          "invalid_request_error",
          "role",
        ),
      };
    }

    if (role === "system" || role === "user") {
      if (typeof rawMsg.content !== "string") {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            `Message with role '${role}' must have string content.`,
            "invalid_request_error",
            "invalid_request_error",
            "content",
          ),
        };
      }
      validatedMessages.push({
        role,
        content: rawMsg.content,
      });
    } else if (role === "assistant") {
      const hasToolCalls = rawMsg.tool_calls !== undefined;
      let validatedToolCalls: ValidatedToolCall[] | undefined;

      if (hasToolCalls) {
        if (
          !Array.isArray(rawMsg.tool_calls) ||
          rawMsg.tool_calls.length === 0
        ) {
          return {
            ok: false,
            status: 400,
            error: createErrorResponse(
              "Assistant tool_calls must be a non-empty array.",
              "invalid_request_error",
              "invalid_request_error",
              "tool_calls",
            ),
          };
        }
        validatedToolCalls = [];
        for (const tc of rawMsg.tool_calls) {
          if (typeof tc !== "object" || tc === null || Array.isArray(tc)) {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                "Each tool call must be an object.",
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          const tcObj = tc as Record<string, unknown>;
          if (typeof tcObj.id !== "string" || tcObj.id.length === 0) {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                "Tool call id must be a non-empty string.",
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          if (tcObj.type !== "function") {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                "Tool call type must be 'function'.",
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          if (
            typeof tcObj.function !== "object" ||
            tcObj.function === null ||
            Array.isArray(tcObj.function)
          ) {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                "Tool call function must be an object.",
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          const fnObj = tcObj.function as Record<string, unknown>;
          if (typeof fnObj.name !== "string" || fnObj.name.length === 0) {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                "Tool call function name must be a non-empty string.",
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          if (typeof fnObj.arguments !== "string") {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                "Tool call function arguments must be a string.",
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          outstandingToolCallIds.add(tcObj.id);
          validatedToolCalls.push({
            id: tcObj.id,
            type: "function",
            function: {
              name: fnObj.name,
              arguments: fnObj.arguments,
            },
          });
        }

        if (
          rawMsg.content !== undefined &&
          rawMsg.content !== null &&
          typeof rawMsg.content !== "string"
        ) {
          return {
            ok: false,
            status: 400,
            error: createErrorResponse(
              "Assistant message content must be string, null, or omitted when tool_calls are present.",
              "invalid_request_error",
              "invalid_request_error",
              "content",
            ),
          };
        }
      } else {
        if (typeof rawMsg.content !== "string") {
          return {
            ok: false,
            status: 400,
            error: createErrorResponse(
              "Assistant message must have string content when tool_calls are absent.",
              "invalid_request_error",
              "invalid_request_error",
              "content",
            ),
          };
        }
      }

      const content =
        typeof rawMsg.content === "string" ? rawMsg.content : null;
      validatedMessages.push({
        role: "assistant",
        content,
        tool_calls: validatedToolCalls,
      });
    } else {
      if (typeof rawMsg.content !== "string") {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool message content must be a string.",
            "invalid_request_error",
            "invalid_request_error",
            "content",
          ),
        };
      }
      if (
        typeof rawMsg.tool_call_id !== "string" ||
        rawMsg.tool_call_id.length === 0
      ) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool message must have a non-empty tool_call_id string.",
            "invalid_request_error",
            "invalid_request_error",
            "tool_call_id",
          ),
        };
      }
      if (!outstandingToolCallIds.has(rawMsg.tool_call_id)) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            `Tool message tool_call_id '${rawMsg.tool_call_id}' does not match any outstanding preceding assistant tool call.`,
            "invalid_request_error",
            "invalid_request_error",
            "tool_call_id",
          ),
        };
      }
      outstandingToolCallIds.delete(rawMsg.tool_call_id);
      validatedMessages.push({
        role: "tool",
        content: rawMsg.content,
        tool_call_id: rawMsg.tool_call_id,
      });
    }
  }

  const declaredToolNames = new Set<string>();
  let validatedTools: ValidatedTool[] | undefined;

  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools)) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "tools must be an array.",
          "invalid_request_error",
          "invalid_request_error",
          "tools",
        ),
      };
    }
    validatedTools = [];
    for (const t of record.tools) {
      if (typeof t !== "object" || t === null || Array.isArray(t)) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Each tool declaration must be an object.",
            "invalid_request_error",
            "invalid_request_error",
            "tools",
          ),
        };
      }
      const tObj = t as Record<string, unknown>;
      if (tObj.type !== "function") {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool type must be 'function'.",
            "invalid_request_error",
            "invalid_request_error",
            "tools",
          ),
        };
      }
      if (
        typeof tObj.function !== "object" ||
        tObj.function === null ||
        Array.isArray(tObj.function)
      ) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool function must be an object.",
            "invalid_request_error",
            "invalid_request_error",
            "tools",
          ),
        };
      }
      const fnObj = tObj.function as Record<string, unknown>;
      if (typeof fnObj.name !== "string" || fnObj.name.length === 0) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool function name must be a non-empty string.",
            "invalid_request_error",
            "invalid_request_error",
            "tools",
          ),
        };
      }
      if (
        fnObj.description !== undefined &&
        typeof fnObj.description !== "string"
      ) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool function description must be a string.",
            "invalid_request_error",
            "invalid_request_error",
            "tools",
          ),
        };
      }
      if (
        fnObj.parameters !== undefined &&
        (typeof fnObj.parameters !== "object" ||
          fnObj.parameters === null ||
          Array.isArray(fnObj.parameters))
      ) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Tool function parameters must be an object.",
            "invalid_request_error",
            "invalid_request_error",
            "tools",
          ),
        };
      }
      declaredToolNames.add(fnObj.name);
      validatedTools.push({
        type: "function",
        function: {
          name: fnObj.name,
          description: fnObj.description as string | undefined,
          parameters: fnObj.parameters as Record<string, unknown> | undefined,
        },
      });
    }
  }

  const hasTools = validatedTools !== undefined && validatedTools.length > 0;
  let validatedToolChoice: ValidatedToolChoice | undefined;

  if (record.tool_choice !== undefined) {
    const tc = record.tool_choice;
    if (tc === "none") {
      validatedToolChoice = "none";
    } else if (tc === "auto" || tc === "required") {
      if (!hasTools) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            `tool_choice '${tc}' requires non-empty tools to be provided.`,
            "invalid_request_error",
            "invalid_request_error",
            "tool_choice",
          ),
        };
      }
      validatedToolChoice = tc;
    } else if (typeof tc === "object" && tc !== null && !Array.isArray(tc)) {
      const tcObj = tc as Record<string, unknown>;
      if (
        tcObj.type !== "function" ||
        typeof tcObj.function !== "object" ||
        tcObj.function === null ||
        Array.isArray(tcObj.function)
      ) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            "Invalid tool_choice object format.",
            "invalid_request_error",
            "invalid_request_error",
            "tool_choice",
          ),
        };
      }
      const fnObj = tcObj.function as Record<string, unknown>;
      if (
        typeof fnObj.name !== "string" ||
        !declaredToolNames.has(fnObj.name)
      ) {
        return {
          ok: false,
          status: 400,
          error: createErrorResponse(
            `tool_choice function '${String(fnObj?.name)}' is not declared in tools.`,
            "invalid_request_error",
            "invalid_request_error",
            "tool_choice",
          ),
        };
      }
      validatedToolChoice = {
        type: "function",
        function: { name: fnObj.name },
      };
    } else {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "Invalid tool_choice value.",
          "invalid_request_error",
          "invalid_request_error",
          "tool_choice",
        ),
      };
    }
  }

  if (record.max_tokens !== undefined) {
    if (!isValidTokenLimit(record.max_tokens)) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "max_tokens must be a positive integer not exceeding 8192.",
          "invalid_request_error",
          "invalid_request_error",
          "max_tokens",
        ),
      };
    }
  }

  if (record.max_completion_tokens !== undefined) {
    if (!isValidTokenLimit(record.max_completion_tokens)) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "max_completion_tokens must be a positive integer not exceeding 8192.",
          "invalid_request_error",
          "invalid_request_error",
          "max_completion_tokens",
        ),
      };
    }
  }

  const winningMaxTokens =
    (record.max_completion_tokens as number | undefined) ??
    (record.max_tokens as number | undefined);

  let totalChars = 0;
  for (const msg of validatedMessages) {
    if (msg.content) {
      totalChars += msg.content.length;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalChars += tc.function.name.length;
        totalChars += tc.function.arguments.length;
      }
    }
  }
  const estimatedPromptTokens = Math.ceil(totalChars / 4);
  if (estimatedPromptTokens + (winningMaxTokens ?? 0) > 128000) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Combined context length exceeded maximum ceiling of 128,000 tokens.",
        "invalid_request_error",
        "context_length_exceeded",
      ),
    };
  }

  if (record.temperature !== undefined) {
    if (!isValidTemperature(record.temperature)) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "temperature must be a finite number between 0.0 and 2.0.",
          "invalid_request_error",
          "invalid_request_error",
          "temperature",
        ),
      };
    }
  }

  if (record.stream !== undefined && typeof record.stream !== "boolean") {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "stream must be a boolean.",
        "invalid_request_error",
        "invalid_request_error",
        "stream",
      ),
    };
  }

  const isStream = record.stream === true;
  let validatedStreamOptions: ValidatedStreamOptions | undefined;

  if (record.stream_options !== undefined && record.stream_options !== null) {
    if (!isStream) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "stream_options is only permitted when stream is true.",
          "invalid_request_error",
          "invalid_request_error",
          "stream_options",
        ),
      };
    }
    if (
      typeof record.stream_options !== "object" ||
      Array.isArray(record.stream_options)
    ) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "stream_options must be an object.",
          "invalid_request_error",
          "invalid_request_error",
          "stream_options",
        ),
      };
    }
    const soObj = record.stream_options as Record<string, unknown>;
    if (
      soObj.include_usage !== undefined &&
      typeof soObj.include_usage !== "boolean"
    ) {
      return {
        ok: false,
        status: 400,
        error: createErrorResponse(
          "stream_options.include_usage must be a boolean.",
          "invalid_request_error",
          "invalid_request_error",
          "stream_options.include_usage",
        ),
      };
    }
    validatedStreamOptions = {
      include_usage: soObj.include_usage as boolean | undefined,
    };
  }

  const extensions: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (!KNOWN_REQUEST_FIELDS.has(key)) {
      extensions[key] = val;
    }
  }

  return {
    ok: true,
    data: {
      model: "fast",
      messages: validatedMessages,
      tools: validatedTools,
      tool_choice: validatedToolChoice,
      temperature: record.temperature as number | undefined,
      max_tokens: winningMaxTokens,
      stream: isStream,
      stream_options: validatedStreamOptions,
      extensions,
    },
  };
}

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
