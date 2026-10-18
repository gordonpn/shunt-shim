import { describe, expect, it } from "vitest";
import { type ApiError, type GatewayEnv, app } from "../src/index.js";

type MessageRole = "system" | "user" | "assistant" | "tool";

interface ToolCallFunction {
  name: string;
  arguments: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

interface ChatMessage {
  role: MessageRole | string;
  content?: string | null | unknown;
  tool_calls?: ToolCall[] | unknown;
  tool_call_id?: string | unknown;
}

interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface ToolDeclaration {
  type: "function" | string;
  function: FunctionDeclaration | unknown;
}

type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } }
  | string;

interface StreamOptions {
  include_usage?: boolean | unknown;
}

interface ChatCompletionRequest {
  model?: string | unknown;
  messages?: ChatMessage[] | unknown;
  tools?: ToolDeclaration[] | unknown;
  tool_choice?: ToolChoice | unknown;
  temperature?: number | unknown;
  max_tokens?: number | unknown;
  max_completion_tokens?: number | unknown;
  stream?: boolean | unknown;
  stream_options?: StreamOptions | unknown;
  [key: string]: unknown;
}

function createValidMessage(overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    role: "user",
    content: "Hello world",
    ...overrides,
  };
}

function createValidChatRequest(
  overrides?: Partial<ChatCompletionRequest>,
): ChatCompletionRequest {
  return {
    model: "fast",
    messages: [createValidMessage()],
    ...overrides,
  };
}

const mockEnv: GatewayEnv = {
  GATEWAY_TOKENS: "test-gateway-token",
  GROQ_API_KEY: "mock-groq-key",
  GEMINI_API_KEY: "mock-gemini-key",
};

async function postChat(
  payload: unknown,
  endpoint = "/v1/chat/completions",
  headers: Record<string, string> = {
    Authorization: "Bearer test-gateway-token",
    "Content-Type": "application/json",
  },
  env: GatewayEnv = mockEnv,
): Promise<Response> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return await app.request(
    endpoint,
    {
      method: "POST",
      headers,
      body,
    },
    env,
  );
}

describe("Request Validation Specification (Subtask #17 / Story #15)", () => {
  describe("Endpoint Path Parity", () => {
    it("executes identical validation across /v1/chat/completions and /chat/completions", async () => {
      const invalidPayload = { model: "unknown-alias" };
      const res1 = await postChat(invalidPayload, "/v1/chat/completions");
      const res2 = await postChat(invalidPayload, "/chat/completions");

      expect(res1.status).toBe(404);
      expect(res2.status).toBe(404);
      const json1 = (await res1.json()) as ApiError;
      const json2 = (await res2.json()) as ApiError;
      expect(json1).toEqual(json2);
    });
  });

  describe("Inbound Body Size Limit (HTTP 413 payload_too_large)", () => {
    const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10,485,760 bytes

    it("accepts request bodies within the 10 MB limit", async () => {
      const paddingLength = 1000;
      const validPayload = createValidChatRequest({
        messages: [{ role: "user", content: "a".repeat(paddingLength) }],
      });
      const res = await postChat(validPayload);
      expect(res.status).toBe(200);
    });

    it("rejects request bodies exceeding 10 MB with HTTP 413 prior to JSON parsing", async () => {
      const oversizedString = "x".repeat(MAX_BODY_BYTES + 10);
      const res = await postChat(oversizedString, "/v1/chat/completions", {
        Authorization: "Bearer test-gateway-token",
        "Content-Type": "application/json",
        "Content-Length": String(oversizedString.length),
      });

      expect(res.status).toBe(413);
      const json = (await res.json()) as ApiError;
      expect(json.error.type).toBe("invalid_request_error");
      expect(json.error.code).toBe("payload_too_large");
      expect(json.error.param).toBeNull();
    });

    it("enforces the 10 MB limit during streaming read even when Content-Length is absent", async () => {
      const oversizedString = "x".repeat(MAX_BODY_BYTES + 10);
      const res = await postChat(oversizedString, "/v1/chat/completions", {
        Authorization: "Bearer test-gateway-token",
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(413);
      const json = (await res.json()) as ApiError;
      expect(json.error.code).toBe("payload_too_large");
    });
  });

  describe("Malformed JSON & Non-Object Payloads (HTTP 400 invalid_json)", () => {
    it("rejects empty body string with HTTP 400 invalid_json", async () => {
      const res = await postChat("");
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.code).toBe("invalid_json");
    });

    it("rejects broken JSON syntax with HTTP 400 invalid_json", async () => {
      const res = await postChat("{ model: 'fast', messages: ");
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.code).toBe("invalid_json");
    });

    it("rejects primitive JSON values with HTTP 400 invalid_json", async () => {
      const primitives = ["hello", 12345, true, false, null];
      for (const val of primitives) {
        const res = await postChat(val);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.code).toBe("invalid_json");
      }
    });

    it("rejects JSON arrays with HTTP 400 invalid_json", async () => {
      const arrays = [[], [createValidChatRequest()]];
      for (const arr of arrays) {
        const res = await postChat(arr);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.code).toBe("invalid_json");
      }
    });
  });

  describe("Model Alias Validation (HTTP 404 model_not_found)", () => {
    it("rejects missing, non-string, or empty model alias", async () => {
      const invalidModels = [undefined, null, 123, true, {}, [], "", "   "];
      for (const model of invalidModels) {
        const req = { ...createValidChatRequest(), model };
        const res = await postChat(req);
        expect(res.status).toBe(404);
        const json = (await res.json()) as ApiError;
        expect(json.error.code).toBe("model_not_found");
        expect(json.error.param).toBe("model");
      }
    });

    it("rejects direct provider model names and deferred aliases", async () => {
      const disallowedModels = [
        "qwen/qwen3.8-27b",
        "gemini-2.5-flash-lite",
        "openai/gpt-oss-120b",
        "deep",
        "reasoning",
        "gpt-4o",
      ];
      for (const model of disallowedModels) {
        const req = createValidChatRequest({ model });
        const res = await postChat(req);
        expect(res.status).toBe(404);
        const json = (await res.json()) as ApiError;
        expect(json.error.code).toBe("model_not_found");
        expect(json.error.param).toBe("model");
      }
    });

    it("accepts strictly the pinned model alias 'fast'", async () => {
      const req = createValidChatRequest({ model: "fast" });
      const res = await postChat(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Messages Array Structure Validation (HTTP 400 invalid_request_error)", () => {
    it("rejects missing, null, or non-array messages", async () => {
      const invalidMessages = [undefined, null, {}, "hello", 123, true];
      for (const messages of invalidMessages) {
        const req = { ...createValidChatRequest(), messages };
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.type).toBe("invalid_request_error");
        expect(json.error.param).toBe("messages");
      }
    });

    it("rejects empty messages array", async () => {
      const req = createValidChatRequest({ messages: [] });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.param).toBe("messages");
    });

    it("rejects non-object items in messages array", async () => {
      const invalidItems = [null, undefined, "user message", 123, true, []];
      for (const item of invalidItems) {
        const req = createValidChatRequest({
          messages: [item] as unknown[],
        });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.type).toBe("invalid_request_error");
      }
    });
  });

  describe("Message Roles Validation (HTTP 400 invalid_request_error)", () => {
    it("rejects missing, non-string, or invalid roles", async () => {
      const invalidRoles = [
        undefined,
        null,
        123,
        "",
        "   ",
        "developer",
        "system_prompt",
        "human",
        "bot",
        "function",
      ];
      for (const role of invalidRoles) {
        const req = createValidChatRequest({
          messages: [{ role, content: "test" } as ChatMessage],
        });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.param).toBe("role");
      }
    });

    it("accepts all four supported roles: system, user, assistant, tool", async () => {
      const validConversation: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Check weather in Tokyo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_tokyo_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city: "Tokyo" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_tokyo_1",
          content: JSON.stringify({ temp: 22 }),
        },
      ];

      const req = createValidChatRequest({ messages: validConversation });
      const res = await postChat(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Message Content & Multimodal Rejection (HTTP 400 invalid_request_error)", () => {
    it("rejects non-string content for system and user messages", async () => {
      const invalidContents = [null, undefined, 123, true, {}, []];
      for (const content of invalidContents) {
        const sysReq = createValidChatRequest({
          messages: [{ role: "system", content }],
        });
        const resSys = await postChat(sysReq);
        expect(resSys.status).toBe(400);

        const userReq = createValidChatRequest({
          messages: [{ role: "user", content }],
        });
        const resUser = await postChat(userReq);
        expect(resUser.status).toBe(400);
      }
    });

    it("rejects multimodal content arrays on user messages with HTTP 400", async () => {
      const multimodalContent = [
        { type: "text", text: "What is this image?" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/image.png" },
        },
      ];
      const req = createValidChatRequest({
        messages: [{ role: "user", content: multimodalContent }],
      });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("rejects assistant messages without tool_calls that lack string content", async () => {
      const invalidContents = [null, undefined, 123, true, {}, []];
      for (const content of invalidContents) {
        const req = createValidChatRequest({
          messages: [{ role: "assistant", content }],
        });
        const res = await postChat(req);
        expect(res.status).toBe(400);
      }
    });

    it("accepts assistant messages with tool_calls having string, null, or omitted content", async () => {
      const toolCall: ToolCall = {
        id: "call_1",
        type: "function",
        function: { name: "test_fn", arguments: "{}" },
      };

      const validVariants = [
        { role: "assistant", content: "Invoking tool", tool_calls: [toolCall] },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "assistant", tool_calls: [toolCall] },
      ];

      for (const assistantMsg of validVariants) {
        const req = createValidChatRequest({
          messages: [
            createValidMessage(),
            assistantMsg,
            { role: "tool", tool_call_id: "call_1", content: "result" },
          ],
        });
        const res = await postChat(req);
        expect(res.status).toBe(200);
      }
    });

    it("rejects tool role messages with missing or non-string content", async () => {
      const invalidContents = [null, undefined, 123, true, {}, []];
      for (const content of invalidContents) {
        const req = createValidChatRequest({
          messages: [
            createValidMessage(),
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fn", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_1", content },
          ],
        });
        const res = await postChat(req);
        expect(res.status).toBe(400);
      }
    });
  });

  describe("Tool Calls & Tool Result Correlation (HTTP 400 invalid_request_error)", () => {
    it("rejects malformed tool_calls in assistant messages", async () => {
      const invalidToolCalls = [
        "not-an-array",
        [],
        [{}],
        [
          {
            id: "",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
        [
          {
            id: "1",
            type: "invalid",
            function: { name: "f", arguments: "{}" },
          },
        ],
        [{ id: "1", type: "function", function: null }],
        [
          {
            id: "1",
            type: "function",
            function: { name: "", arguments: "{}" },
          },
        ],
        [
          {
            id: "1",
            type: "function",
            function: { name: "f", arguments: 123 },
          },
        ],
      ];

      for (const tool_calls of invalidToolCalls) {
        const req = createValidChatRequest({
          messages: [createValidMessage(), { role: "assistant", tool_calls }],
        });
        const res = await postChat(req);
        expect(res.status).toBe(400);
      }
    });

    it("rejects orphan tool results with HTTP 400", async () => {
      const req = createValidChatRequest({
        messages: [
          createValidMessage(),
          { role: "tool", tool_call_id: "orphan_call_id", content: "result" },
        ],
      });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.param).toBe("tool_call_id");
    });

    it("rejects duplicate tool results resolving the same tool_call_id with HTTP 400", async () => {
      const req = createValidChatRequest({
        messages: [
          createValidMessage(),
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_dup",
                type: "function",
                function: { name: "test", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_dup", content: "result 1" },
          { role: "tool", tool_call_id: "call_dup", content: "result 2" },
        ],
      });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.param).toBe("tool_call_id");
    });

    it("accepts multiple parallel tool calls resolved by matching tool messages", async () => {
      const req = createValidChatRequest({
        messages: [
          createValidMessage(),
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_a",
                type: "function",
                function: { name: "fn_a", arguments: "{}" },
              },
              {
                id: "call_b",
                type: "function",
                function: { name: "fn_b", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_a", content: "res_a" },
          { role: "tool", tool_call_id: "call_b", content: "res_b" },
        ],
      });
      const res = await postChat(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Tools & Tool Choice Validation (HTTP 400 invalid_request_error)", () => {
    it("rejects non-array tools declaration", async () => {
      const invalidTools = ["string", 123, true, {}];
      for (const tools of invalidTools) {
        const req = createValidChatRequest({ tools });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.param).toBe("tools");
      }
    });

    it("rejects malformed items inside tools array", async () => {
      const invalidToolItems = [
        null,
        {},
        { type: "custom" },
        { type: "function" },
        { type: "function", function: null },
        { type: "function", function: { name: "" } },
        { type: "function", function: { name: 123 } },
      ];

      for (const item of invalidToolItems) {
        const req = createValidChatRequest({
          tools: [item as ToolDeclaration],
        });
        const res = await postChat(req);
        expect(res.status).toBe(400);
      }
    });

    it("rejects active tool_choice ('auto', 'required', named) when tools are absent or empty", async () => {
      const activeChoices: ToolChoice[] = [
        "auto",
        "required",
        { type: "function", function: { name: "test_fn" } },
      ];

      for (const tool_choice of activeChoices) {
        const reqNoTools = createValidChatRequest({ tool_choice });
        const resNoTools = await postChat(reqNoTools);
        expect(resNoTools.status).toBe(400);

        const reqEmptyTools = createValidChatRequest({
          tools: [],
          tool_choice,
        });
        const resEmptyTools = await postChat(reqEmptyTools);
        expect(resEmptyTools.status).toBe(400);
      }
    });

    it("accepts absent tools with tool_choice 'none' or omitted", async () => {
      const reqOmitted = createValidChatRequest();
      const resOmitted = await postChat(reqOmitted);
      expect(resOmitted.status).toBe(200);

      const reqNone = createValidChatRequest({ tool_choice: "none" });
      const resNone = await postChat(reqNone);
      expect(resNone.status).toBe(200);
    });

    it("rejects named tool_choice specifying a function not declared in tools", async () => {
      const req = createValidChatRequest({
        tools: [
          {
            type: "function",
            function: { name: "declared_fn" },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "undeclared_fn" },
        },
      });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.param).toBe("tool_choice");
    });

    it("accepts all four tool_choice forms when tools are declared", async () => {
      const tools: ToolDeclaration[] = [
        {
          type: "function",
          function: { name: "weather_tool", description: "Get weather" },
        },
      ];

      const validChoices: ToolChoice[] = [
        "auto",
        "required",
        "none",
        { type: "function", function: { name: "weather_tool" } },
      ];

      for (const tool_choice of validChoices) {
        const req = createValidChatRequest({ tools, tool_choice });
        const res = await postChat(req);
        expect(res.status).toBe(200);
      }
    });
  });

  describe("Token Limits & Precedence Validation (HTTP 400 invalid_request_error)", () => {
    it("rejects invalid max_tokens (non-integer, <= 0, > 8192)", async () => {
      const invalidValues = [0, -1, 10.5, "100", true, {}, 8193, 100000];
      for (const max_tokens of invalidValues) {
        const req = createValidChatRequest({ max_tokens });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.param).toBe("max_tokens");
      }
    });

    it("rejects invalid max_completion_tokens (non-integer, <= 0, > 8192)", async () => {
      const invalidValues = [0, -1, 10.5, "100", true, {}, 8193, 100000];
      for (const max_completion_tokens of invalidValues) {
        const req = createValidChatRequest({ max_completion_tokens });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.param).toBe("max_completion_tokens");
      }
    });

    it("accepts valid positive integer token limits up to 8192", async () => {
      const validValues = [1, 100, 4096, 8192];
      for (const val of validValues) {
        const req1 = createValidChatRequest({ max_tokens: val });
        const res1 = await postChat(req1);
        expect(res1.status).toBe(200);

        const req2 = createValidChatRequest({ max_completion_tokens: val });
        const res2 = await postChat(req2);
        expect(res2.status).toBe(200);
      }
    });

    it("validates both limit fields when both are provided", async () => {
      const invalidBothReq = createValidChatRequest({
        max_tokens: 100,
        max_completion_tokens: -5,
      });
      const res = await postChat(invalidBothReq);
      expect(res.status).toBe(400);

      const validBothReq = createValidChatRequest({
        max_tokens: 100,
        max_completion_tokens: 200,
      });
      const resValid = await postChat(validBothReq);
      expect(resValid.status).toBe(200);
    });

    it("rejects requests exceeding combined context ceiling of 128,000 tokens", async () => {
      // 128,000 token limit: prompt tokens + max_completion_tokens
      // With ~4 chars per token, ~520,000 chars is > 128,000 prompt tokens
      const hugePrompt = "token ".repeat(130000);
      const req = createValidChatRequest({
        messages: [{ role: "user", content: hugePrompt }],
        max_completion_tokens: 4000,
      });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.code).toBe("context_length_exceeded");
    });
  });

  describe("Temperature Validation (HTTP 400 invalid_request_error)", () => {
    it("rejects invalid temperature (out of range [0.0, 2.0], NaN, string)", async () => {
      const invalidTemperatures = [
        -0.1,
        2.1,
        100,
        "0.7",
        true,
        {},
        NaN,
        Infinity,
      ];
      for (const temperature of invalidTemperatures) {
        const req = createValidChatRequest({ temperature });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.param).toBe("temperature");
      }
    });

    it("accepts valid temperatures between 0.0 and 2.0", async () => {
      const validTemperatures = [0, 0.0, 0.7, 1, 1.5, 2, 2.0];
      for (const temperature of validTemperatures) {
        const req = createValidChatRequest({ temperature });
        const res = await postChat(req);
        expect(res.status).toBe(200);
      }
    });
  });

  describe("Stream & Stream Options Validation (HTTP 400 invalid_request_error)", () => {
    it("rejects non-boolean stream option", async () => {
      const invalidStreams = ["true", "false", 1, 0, {}, []];
      for (const stream of invalidStreams) {
        const req = createValidChatRequest({ stream });
        const res = await postChat(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as ApiError;
        expect(json.error.param).toBe("stream");
      }
    });

    it("rejects non-null stream_options when stream is false or omitted", async () => {
      const reqOmittedStream = createValidChatRequest({
        stream_options: { include_usage: true },
      });
      const res1 = await postChat(reqOmittedStream);
      expect(res1.status).toBe(400);
      const json1 = (await res1.json()) as ApiError;
      expect(json1.error.param).toBe("stream_options");

      const reqFalseStream = createValidChatRequest({
        stream: false,
        stream_options: { include_usage: true },
      });
      const res2 = await postChat(reqFalseStream);
      expect(res2.status).toBe(400);
    });

    it("accepts valid stream and stream_options when stream: true", async () => {
      const validStreamRequests = [
        createValidChatRequest({ stream: true }),
        createValidChatRequest({ stream: true, stream_options: null }),
        createValidChatRequest({
          stream: true,
          stream_options: { include_usage: true },
        }),
        createValidChatRequest({
          stream: true,
          stream_options: { include_usage: false },
        }),
      ];

      for (const req of validStreamRequests) {
        const res = await postChat(req);
        expect(res.status).toBe(200);
      }
    });

    it("rejects non-boolean stream_options.include_usage when stream: true", async () => {
      const req = createValidChatRequest({
        stream: true,
        stream_options: { include_usage: "yes" },
      });
      const res = await postChat(req);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiError;
      expect(json.error.param).toBe("stream_options.include_usage");
    });
  });

  describe("Tolerated Client Extensions", () => {
    it("accepts requests containing thinking, reasoning_effort, and unknown client metadata", async () => {
      const reqWithExtensions = createValidChatRequest({
        thinking: { type: "disabled" },
        reasoning_effort: "low",
        custom_client_metadata: {
          client_id: "opencode-review",
          session_trace: "xyz-123",
        },
      });

      const res = await postChat(reqWithExtensions);
      expect(res.status).toBe(200);
    });

    it("does not allow client extensions to override validated core parameters", async () => {
      // Overriding model or messages with invalid structures through malformed core fields fails validation
      const reqMalicious = {
        ...createValidChatRequest(),
        messages: "invalid-string-instead-of-array",
        thinking: { type: "enabled" },
      };

      const res = await postChat(reqMalicious);
      expect(res.status).toBe(400);
    });
  });

  describe("Credential Safety", () => {
    it("never reflects caller credentials in error bodies or headers during validation errors", async () => {
      const callerToken = "secret-caller-token-xyz-12345";
      const invalidReq = { model: "fast" }; // Missing messages array -> HTTP 400

      const res = await postChat(
        invalidReq,
        "/v1/chat/completions",
        {
          Authorization: `Bearer ${callerToken}`,
          "Content-Type": "application/json",
        },
        {
          ...mockEnv,
          GATEWAY_TOKENS: callerToken,
        },
      );

      expect(res.status).toBe(400);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(callerToken);
      for (const [headerName, headerValue] of res.headers.entries()) {
        expect(headerName.toLowerCase()).not.toContain(callerToken);
        expect(headerValue).not.toContain(callerToken);
      }
    });
  });
});
