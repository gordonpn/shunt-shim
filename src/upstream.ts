import { type ApiError, createErrorResponse } from "./errors.js";
import type { GatewayEnv } from "./index.js";
import type {
  ValidatedChatCompletionRequest,
  ValidatedTool,
  ValidatedToolCall,
  ValidatedToolChoice,
} from "./validation.js";

/**
 * Normalized choice item in a chat completion response.
 */
export interface NormalizedChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ValidatedToolCall[];
    reasoning_content?: string;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
}

/**
 * Normalized OpenAI-compatible chat completion response object.
 */
export interface NormalizedChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: "fast";
  choices: NormalizedChoice[];
  usage?: Record<string, unknown>;
}

/**
 * Result of an upstream completion dispatch attempt.
 */
export type UpstreamCompletionResult =
  | { ok: true; data: NormalizedChatCompletion }
  | { ok: false; status: 502; error: ApiError };

interface ProviderConfig {
  targetUrl: string;
  model: string;
  apiKey: string;
}

function trimTrailingSlashes(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function resolveProviderConfig(env: GatewayEnv): ProviderConfig {
  const provider = env.PRIMARY_PROVIDER === "gemini" ? "gemini" : "groq";

  if (provider === "gemini") {
    const baseUrl = env.GEMINI_BASE_URL
      ? trimTrailingSlashes(env.GEMINI_BASE_URL)
      : "https://generativelanguage.googleapis.com/v1beta/openai";
    const targetUrl = `${baseUrl}/chat/completions`;
    const model = env.FALLBACK_MODEL ?? "gemini-2.5-flash-lite";
    const apiKey = env.GEMINI_API_KEY ?? "";
    return { targetUrl, model, apiKey };
  }

  const baseUrl = env.GROQ_BASE_URL
    ? trimTrailingSlashes(env.GROQ_BASE_URL)
    : "https://api.groq.com/openai/v1";
  const targetUrl = `${baseUrl}/chat/completions`;
  const model = env.PRIMARY_MODEL ?? "qwen/qwen3.8-27b";
  const apiKey = env.GROQ_API_KEY ?? "";
  return { targetUrl, model, apiKey };
}

interface UpstreamRequestBody {
  model: string;
  messages: ValidatedChatCompletionRequest["messages"];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  tools?: ValidatedTool[];
  tool_choice?: ValidatedToolChoice;
  stream: boolean;
}

function buildUpstreamRequestBody(
  req: ValidatedChatCompletionRequest,
  model: string,
): UpstreamRequestBody {
  const body: UpstreamRequestBody = {
    model,
    messages: req.messages,
    stream: false,
  };

  if (req.max_completion_tokens !== undefined) {
    body.max_completion_tokens = req.max_completion_tokens;
  } else if (req.max_tokens !== undefined) {
    body.max_tokens = req.max_tokens;
  }

  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools;
  }

  if (req.tool_choice !== undefined) {
    body.tool_choice = req.tool_choice;
  }

  return body;
}

const VALID_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
]);

function validateUpstreamToolCalls(
  rawToolCalls: unknown,
): ValidatedToolCall[] | null {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    return null;
  }

  const validated: ValidatedToolCall[] = [];
  for (const tc of rawToolCalls) {
    if (typeof tc !== "object" || tc === null || Array.isArray(tc)) {
      return null;
    }
    const record = tc as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      return null;
    }
    if (record.type !== "function") {
      return null;
    }
    if (
      typeof record.function !== "object" ||
      record.function === null ||
      Array.isArray(record.function)
    ) {
      return null;
    }
    const fn = record.function as Record<string, unknown>;
    if (
      typeof fn.name !== "string" ||
      fn.name.length === 0 ||
      typeof fn.arguments !== "string"
    ) {
      return null;
    }
    validated.push({
      id: record.id,
      type: "function",
      function: {
        name: fn.name,
        arguments: fn.arguments,
      },
    });
  }

  return validated;
}

function normalizeChoice(
  rawChoice: unknown,
  fallbackIndex: number,
): NormalizedChoice | null {
  if (typeof rawChoice !== "object" || rawChoice === null) {
    return null;
  }

  const record = rawChoice as Record<string, unknown>;
  const finishReason = record.finish_reason;
  if (
    typeof finishReason !== "string" ||
    !VALID_FINISH_REASONS.has(finishReason)
  ) {
    return null;
  }

  if (typeof record.message !== "object" || record.message === null) {
    return null;
  }

  const messageRecord = record.message as Record<string, unknown>;
  let content: string | null = null;
  const rawContent = messageRecord.content;

  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (rawContent === null || rawContent === undefined) {
    content = null;
  } else if (Array.isArray(rawContent)) {
    let concatenated = "";
    for (const block of rawContent) {
      if (
        typeof block !== "object" ||
        block === null ||
        (block as Record<string, unknown>).type !== "text" ||
        typeof (block as Record<string, unknown>).text !== "string"
      ) {
        return null;
      }
      concatenated += (block as Record<string, unknown>).text as string;
    }
    content = concatenated;
  } else {
    return null;
  }

  let toolCalls: ValidatedToolCall[] | undefined;
  if (
    messageRecord.tool_calls !== undefined &&
    messageRecord.tool_calls !== null
  ) {
    const validated = validateUpstreamToolCalls(messageRecord.tool_calls);
    if (validated === null) {
      return null;
    }
    toolCalls = validated;
  }

  if (content === null && toolCalls === undefined) {
    return null;
  }

  const normalizedMessage: NormalizedChoice["message"] = {
    role: "assistant",
    content,
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
    ...(typeof messageRecord.reasoning_content === "string"
      ? { reasoning_content: messageRecord.reasoning_content }
      : {}),
  };

  const choiceIndex =
    typeof record.index === "number" ? record.index : fallbackIndex;

  return {
    index: choiceIndex,
    message: normalizedMessage,
    finish_reason: finishReason as NormalizedChoice["finish_reason"],
  };
}

function normalizeUpstreamResponse(
  rawJson: unknown,
): NormalizedChatCompletion | null {
  if (typeof rawJson !== "object" || rawJson === null) {
    return null;
  }

  const record = rawJson as Record<string, unknown>;
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    return null;
  }

  const normalizedChoices: NormalizedChoice[] = [];
  for (let i = 0; i < record.choices.length; i++) {
    const rawChoice = record.choices[i];
    const normalized = normalizeChoice(rawChoice, i);
    if (!normalized) {
      return null;
    }
    normalizedChoices.push(normalized);
  }

  const id =
    typeof record.id === "string" && record.id
      ? record.id
      : `chatcmpl-${crypto.randomUUID()}`;
  const created =
    typeof record.created === "number"
      ? record.created
      : Math.floor(Date.now() / 1000);

  const completion: NormalizedChatCompletion = {
    id,
    object: "chat.completion",
    created,
    model: "fast",
    choices: normalizedChoices,
  };

  if (typeof record.usage === "object" && record.usage !== null) {
    completion.usage = record.usage as Record<string, unknown>;
  }

  return completion;
}

/**
 * Forwards a validated non-streaming chat completion request to an upstream provider.
 *
 * @param req - Validated chat completion request payload.
 * @param env - Gateway environment bindings containing secrets and routing configuration.
 * @returns Result object containing the normalized completion or an API error.
 */
export async function forwardChatCompletion(
  req: ValidatedChatCompletionRequest,
  env: GatewayEnv,
): Promise<UpstreamCompletionResult> {
  const config = resolveProviderConfig(env);
  if (!config.apiKey) {
    return {
      ok: false,
      status: 502,
      error: createErrorResponse(
        "Missing upstream API key configuration",
        "invalid_request_error",
        "bad_gateway",
      ),
    };
  }

  const body = buildUpstreamRequestBody(req, config.model);

  let response: Response;
  try {
    response = await fetch(config.targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      error: createErrorResponse(
        "Failed to communicate with upstream provider",
        "invalid_request_error",
        "bad_gateway",
      ),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: createErrorResponse(
        "Upstream provider returned an error response",
        "invalid_request_error",
        "bad_gateway",
      ),
    };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    return {
      ok: false,
      status: 502,
      error: createErrorResponse(
        "Upstream provider returned malformed JSON",
        "invalid_request_error",
        "bad_gateway",
      ),
    };
  }

  const normalized = normalizeUpstreamResponse(rawJson);
  if (!normalized) {
    return {
      ok: false,
      status: 502,
      error: createErrorResponse(
        "Upstream provider returned an invalid completion payload",
        "invalid_request_error",
        "bad_gateway",
      ),
    };
  }

  return {
    ok: true,
    data: normalized,
  };
}
