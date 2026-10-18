import { type ApiError, createErrorResponse } from "./errors.js";

export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10,485,760 bytes

/**
 * Reads the request body stream up to the specified byte limit.
 *
 * @param req - Incoming HTTP request to read.
 * @param limit - Maximum permitted body size in bytes. Defaults to 10 MB.
 * @returns Success object with decoded text, or failure object with status code and error details.
 */
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

export interface ValidatedChatCompletionRequest {
  model: "fast";
  messages: ValidatedMessage[];
  tools?: ValidatedTool[] | undefined;
  tool_choice?: ValidatedToolChoice | undefined;
  temperature?: number | undefined;
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  stream: false;
  stream_options?: never;
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

/**
 * Validates and normalizes an untrusted chat completion request payload.
 *
 * @param raw - Untrusted input object from parsed JSON.
 * @returns Validation result containing sanitized request data or error details with HTTP status.
 */
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

  if (typeof record.model !== "string" || record.model !== "fast") {
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

  const seenToolCallIds = new Set<string>();
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
          if (seenToolCallIds.has(tcObj.id)) {
            return {
              ok: false,
              status: 400,
              error: createErrorResponse(
                `Duplicate tool call id '${tcObj.id}' found in assistant message.`,
                "invalid_request_error",
                "invalid_request_error",
                "tool_calls",
              ),
            };
          }
          seenToolCallIds.add(tcObj.id);
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
  if (validatedTools) {
    for (const tool of validatedTools) {
      totalChars += tool.function.name.length;
      if (tool.function.description) {
        totalChars += tool.function.description.length;
      }
      if (tool.function.parameters) {
        totalChars += JSON.stringify(tool.function.parameters).length;
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

  if (record.stream === true) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "Streaming is not supported by this gateway. Please omit 'stream' or set 'stream': false.",
        "invalid_request_error",
        "unsupported_parameter",
        "stream",
      ),
    };
  }

  if (record.stream_options !== undefined) {
    return {
      ok: false,
      status: 400,
      error: createErrorResponse(
        "stream_options is not supported by this gateway.",
        "invalid_request_error",
        "unsupported_parameter",
        "stream_options",
      ),
    };
  }

  const extensions: Record<string, unknown> = Object.create(null);
  for (const [key, val] of Object.entries(record)) {
    if (!KNOWN_REQUEST_FIELDS.has(key) && key !== "__proto__") {
      extensions[key] = val;
    }
  }

  const rawMaxCompletionTokens = record.max_completion_tokens as
    | number
    | undefined;
  const rawMaxTokens = record.max_tokens as number | undefined;

  let resolvedMaxCompletionTokens: number | undefined;
  let resolvedMaxTokens: number | undefined;
  if (rawMaxCompletionTokens !== undefined) {
    resolvedMaxCompletionTokens = rawMaxCompletionTokens;
  } else if (rawMaxTokens !== undefined) {
    resolvedMaxTokens = rawMaxTokens;
  }

  return {
    ok: true,
    data: {
      model: "fast",
      messages: validatedMessages,
      tools: validatedTools,
      tool_choice: validatedToolChoice,
      temperature: record.temperature as number | undefined,
      max_tokens: resolvedMaxTokens,
      max_completion_tokens: resolvedMaxCompletionTokens,
      stream: false,
      extensions,
    },
  };
}
