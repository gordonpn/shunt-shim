import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, forwardChatCompletion, type GatewayEnv } from "../src/index.js";
import {
  createMultiTestToolDeclarations,
  createTestToolDeclaration,
  geminiFixtures,
  groqFixtures,
} from "./fixtures/factories.js";

function requireDefined<T>(
  val: T | undefined | null,
  message = "Expected value to be defined",
): T {
  if (val === undefined || val === null) {
    throw new Error(message);
  }
  return val;
}

const mockEnv: GatewayEnv = {
  GATEWAY_TOKENS: "test-gateway-token-12345",
  GROQ_API_KEY: "test-groq-key-67890",
  GEMINI_API_KEY: "test-gemini-key-54321",
};

describe("JSON Tool Cycle Specification (Subtask #22 / Story #20)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const postChat = async (
    payload: unknown,
    env: GatewayEnv = mockEnv,
    authHeader = "Bearer test-gateway-token-12345",
  ) => {
    return await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
      env,
    );
  };

  describe("Groq Provider JSON Tool Cycle", () => {
    it("handles initial tool call response from Groq with tool_calls finish reason", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(groqFixtures.toolCall), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const requestPayload = {
        model: "fast",
        messages: [
          { role: "user", content: "Show me the diff in src/index.ts" },
        ],
        tools: [createTestToolDeclaration()],
        tool_choice: "auto",
      };

      const res = await postChat(requestPayload);
      expect(res.status).toBe(200);

      const json = (await res.json()) as typeof groqFixtures.toolCall;
      expect(json.object).toBe("chat.completion");
      expect(json.model).toBe("fast");
      const choice = requireDefined(json.choices[0]);
      expect(choice.finish_reason).toBe("tool_calls");
      expect(choice.message.role).toBe("assistant");
      expect(choice.message.content).toBeNull();
      const toolCalls = requireDefined(choice.message.tool_calls);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({
        id: "call_groq_single_001",
        type: "function",
        function: {
          name: "get_file_diff",
          arguments: '{"file":"src/index.ts"}',
        },
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = requireDefined(fetchSpy.mock.calls[0]);
      const [calledUrl, calledInit] = call;
      expect(calledUrl.toString()).toContain("api.groq.com");
      const headers = new Headers(calledInit?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-groq-key-67890");
    });

    it("handles multi-tool simultaneous calls in a single Groq completion turn", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(groqFixtures.multiToolCall), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const requestPayload = {
        model: "fast",
        messages: [
          { role: "user", content: "Read README and check repository status." },
        ],
        tools: createMultiTestToolDeclarations(),
        tool_choice: "required",
      };

      const res = await postChat(requestPayload);
      expect(res.status).toBe(200);

      const json = (await res.json()) as typeof groqFixtures.multiToolCall;
      const choice = requireDefined(json.choices[0]);
      expect(choice.finish_reason).toBe("tool_calls");
      const toolCalls = requireDefined(choice.message.tool_calls);
      expect(toolCalls).toHaveLength(2);
      expect(requireDefined(toolCalls[0]).id).toBe("call_groq_multi_001");
      expect(requireDefined(toolCalls[1]).id).toBe("call_groq_multi_002");

      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("completes full tool round trip with tool results and final answer on Groq", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(groqFixtures.finalAnswer), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const toolCyclePayload = {
        model: "fast",
        messages: [
          { role: "user", content: "Show me the diff in src/index.ts" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_groq_single_001",
                type: "function",
                function: {
                  name: "get_file_diff",
                  arguments: '{"file":"src/index.ts"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_groq_single_001",
            content: "diff --git a/src/index.ts b/src/index.ts...",
          },
        ],
        tools: [createTestToolDeclaration()],
      };

      const res = await postChat(toolCyclePayload);
      expect(res.status).toBe(200);

      const json = (await res.json()) as typeof groqFixtures.finalAnswer;
      const choice = requireDefined(json.choices[0]);
      expect(choice.finish_reason).toBe("stop");
      expect(choice.message.content).toBe(
        "The file diff has been inspected successfully.",
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = requireDefined(fetchSpy.mock.calls[0]);
      const calledBody = JSON.parse(call[1]?.body as string) as {
        model: string;
        messages: unknown[];
      };
      expect(calledBody.model).toBe("qwen/qwen3.8-27b");
      expect(calledBody.messages).toHaveLength(3);
    });
  });

  describe("Gemini Provider JSON Tool Cycle", () => {
    const geminiEnv: GatewayEnv = {
      ...mockEnv,
      PRIMARY_PROVIDER: "gemini",
    };

    it("handles initial tool call response from Gemini with tool_calls finish reason", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(geminiFixtures.toolCall), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const requestPayload = {
        model: "fast",
        messages: [
          { role: "user", content: "Show me the diff in src/index.ts" },
        ],
        tools: [createTestToolDeclaration()],
        tool_choice: "auto",
      };

      const res = await postChat(requestPayload, geminiEnv);
      expect(res.status).toBe(200);

      const json = (await res.json()) as typeof geminiFixtures.toolCall;
      expect(json.object).toBe("chat.completion");
      expect(json.model).toBe("fast");
      const choice = requireDefined(json.choices[0]);
      expect(choice.finish_reason).toBe("tool_calls");
      expect(choice.message.role).toBe("assistant");
      expect(choice.message.content).toBeNull();
      const toolCalls = requireDefined(choice.message.tool_calls);
      expect(toolCalls[0]).toEqual({
        id: "function-call-gemini-001",
        type: "function",
        function: {
          name: "get_file_diff",
          arguments: '{"file":"src/index.ts"}',
        },
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = requireDefined(fetchSpy.mock.calls[0]);
      const [calledUrl, calledInit] = call;
      expect(calledUrl.toString()).toContain(
        "generativelanguage.googleapis.com",
      );
      const headers = new Headers(calledInit?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-gemini-key-54321");
    });

    it("completes full tool round trip with tool results and final answer on Gemini", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(geminiFixtures.finalAnswer), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const toolCyclePayload = {
        model: "fast",
        messages: [
          { role: "user", content: "Show me the diff in src/index.ts" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "function-call-gemini-001",
                type: "function",
                function: {
                  name: "get_file_diff",
                  arguments: '{"file":"src/index.ts"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "function-call-gemini-001",
            content: "diff --git a/src/index.ts b/src/index.ts...",
          },
        ],
        tools: [createTestToolDeclaration()],
      };

      const res = await postChat(toolCyclePayload, geminiEnv);
      expect(res.status).toBe(200);

      const json = (await res.json()) as typeof geminiFixtures.finalAnswer;
      const choice = requireDefined(json.choices[0]);
      expect(choice.finish_reason).toBe("stop");
      expect(choice.message.content).toBe(
        "The file diff has been inspected successfully.",
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = requireDefined(fetchSpy.mock.calls[0]);
      const calledBody = JSON.parse(call[1]?.body as string) as {
        model: string;
      };
      expect(calledBody.model).toBe("gemini-2.5-flash-lite");
    });
  });

  describe("Finish Reason Preservation & Protocol Truthfulness", () => {
    const validFinishReasons = [
      "stop",
      "length",
      "tool_calls",
      "content_filter",
    ];

    for (const finishReason of validFinishReasons) {
      it(`preserves truthful upstream finish_reason: '${finishReason}'`, async () => {
        const upstreamResponse = {
          ...groqFixtures.textCompletion,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Text response" },
              finish_reason: finishReason,
            },
          ],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify(upstreamResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const res = await postChat({
          model: "fast",
          messages: [{ role: "user", content: "Hi" }],
        });

        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          choices: Array<{ finish_reason: string }>;
        };
        const choice = requireDefined(json.choices[0]);
        expect(choice.finish_reason).toBe(finishReason);
      });
    }

    it("returns HTTP 502 when upstream finish_reason is empty or unrecognized", async () => {
      const invalidUpstreamResponse = {
        ...groqFixtures.textCompletion,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Text response" },
            finish_reason: "unexpected_reason_variant",
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(invalidUpstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as {
        error: { code: string; type: string };
      };
      expect(json.error.code).toBe("bad_gateway");
    });
  });

  describe("Text Block Normalization", () => {
    it("concatenates valid upstream text block arrays in order", async () => {
      const textBlockResponse = {
        ...groqFixtures.textCompletion,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Hello " },
                { type: "text", text: "world!" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(textBlockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const choice = requireDefined(json.choices[0]);
      expect(choice.message.content).toBe("Hello world!");
    });

    it("returns HTTP 502 if upstream response contains non-text or malformed content blocks", async () => {
      const malformedBlockResponse = {
        ...groqFixtures.textCompletion,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "image", image_url: "https://example.com/img.png" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(malformedBlockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("bad_gateway");
    });
  });

  describe("Credential Safety on Upstream Dispatch", () => {
    it("never reflects gateway bearer tokens or upstream secrets in outgoing requests or headers", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(groqFixtures.textCompletion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const callerToken = "secret-caller-token-abc-999";
      const res = await postChat(
        {
          model: "fast",
          messages: [{ role: "user", content: "Hello" }],
        },
        {
          ...mockEnv,
          GATEWAY_TOKENS: callerToken,
        },
        `Bearer ${callerToken}`,
      );

      expect(res.status).toBe(200);
      const call = requireDefined(fetchSpy.mock.calls[0]);
      const [, calledInit] = call;
      const headers = new Headers(calledInit?.headers);

      // Provider secret sent, caller gateway token omitted
      expect(headers.get("Authorization")).toBe("Bearer test-groq-key-67890");
      expect(headers.get("Authorization")).not.toContain(callerToken);

      // Caller token not reflected downstream
      const bodyText = await res.text();
      expect(bodyText).not.toContain(callerToken);
      expect(bodyText).not.toContain("test-groq-key-67890");
    });
  });

  describe("Output Limit Normalization", () => {
    it("dispatches single winning limit to upstream when both max_tokens and max_completion_tokens are provided", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(groqFixtures.textCompletion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 50,
        max_completion_tokens: 120,
      });

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = requireDefined(fetchSpy.mock.calls[0]);
      const calledBody = JSON.parse(call[1]?.body as string) as Record<
        string,
        unknown
      >;

      // max_completion_tokens takes precedence
      expect(calledBody.max_completion_tokens).toBe(120);
      expect(calledBody.max_tokens).toBeUndefined();
    });
  });

  describe("Upstream Error and Malformed Response Handling", () => {
    it("maps upstream HTTP 500 error to HTTP 502 bad_gateway", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Upstream Internal Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as {
        error: { code: string; type: string };
      };
      expect(json.error.code).toBe("bad_gateway");
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("maps malformed upstream JSON to HTTP 502 bad_gateway", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("{ malformed json syntax", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("bad_gateway");
    });

    it("maps upstream response missing choices array to HTTP 502 bad_gateway", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "123", model: "fast" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("bad_gateway");
    });

    it("maps upstream fetch network failure to HTTP 502 bad_gateway", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network connection reset"),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("bad_gateway");
    });

    it("maps upstream primitive JSON response to HTTP 502 bad_gateway", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("bad_gateway");
    });

    it("maps upstream choices with non-object choice items or messages to HTTP 502 bad_gateway", async () => {
      const malformedChoicesCases = [
        { choices: [null] },
        { choices: [{ finish_reason: "stop", message: null }] },
        { choices: [{ finish_reason: "stop", message: { content: 123 } }] },
      ];

      for (const upstreamResponse of malformedChoicesCases) {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify(upstreamResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const res = await postChat({
          model: "fast",
          messages: [{ role: "user", content: "Hello" }],
        });

        expect(res.status).toBe(502);
        const json = (await res.json()) as { error: { code: string } };
        expect(json.error.code).toBe("bad_gateway");
      }
    });

    it("maps upstream choices with null or missing content and absent tool_calls to HTTP 502 bad_gateway", async () => {
      const invalidContentCases = [
        { choices: [{ finish_reason: "stop", message: { content: null } }] },
        { choices: [{ finish_reason: "stop", message: {} }] },
        { choices: [{ finish_reason: "length", message: { content: null } }] },
      ];

      for (const upstreamResponse of invalidContentCases) {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify(upstreamResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const res = await postChat({
          model: "fast",
          messages: [{ role: "user", content: "Hello" }],
        });

        expect(res.status).toBe(502);
        const json = (await res.json()) as { error: { code: string } };
        expect(json.error.code).toBe("bad_gateway");
      }
    });

    it("maps upstream choices with malformed or empty tool_calls to HTTP 502 bad_gateway", async () => {
      const malformedToolCallsCases = [
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: null, tool_calls: [] },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: null, tool_calls: "not-an-array" },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: null, tool_calls: [null] },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "",
                    type: "function",
                    function: { name: "test", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "not_a_function",
                    function: { name: "test", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: null,
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "test", arguments: 123 },
                  },
                ],
              },
            },
          ],
        },
      ];

      for (const upstreamResponse of malformedToolCallsCases) {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify(upstreamResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const res = await postChat({
          model: "fast",
          messages: [{ role: "user", content: "Hello" }],
        });

        expect(res.status).toBe(502);
        const json = (await res.json()) as { error: { code: string } };
        expect(json.error.code).toBe("bad_gateway");
      }
    });

    it("accepts upstream choice with null tool_calls when valid string content is present", async () => {
      const responseWithNullToolCalls = {
        ...groqFixtures.textCompletion,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Valid text response",
              tool_calls: null,
            },
            finish_reason: "stop",
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(responseWithNullToolCalls), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string; tool_calls?: unknown } }>;
      };
      const choice = requireDefined(json.choices[0]);
      expect(choice.message.content).toBe("Valid text response");
      expect(choice.message.tool_calls).toBeUndefined();
    });

    it("preserves optional reasoning_content when returned by upstream", async () => {
      const reasoningResponse = {
        ...groqFixtures.textCompletion,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Final text",
              reasoning_content: "Step-by-step thinking...",
            },
            finish_reason: "stop",
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(reasoningResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        choices: Array<{
          message: { content: string; reasoning_content?: string };
        }>;
      };
      const choice = requireDefined(json.choices[0]);
      expect(choice.message.reasoning_content).toBe("Step-by-step thinking...");
    });

    it("respects custom GROQ_BASE_URL and GEMINI_BASE_URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(groqFixtures.textCompletion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const groqCustomEnv: GatewayEnv = {
        ...mockEnv,
        PRIMARY_MODEL: "qwen/qwen3.8-27b",
        GROQ_BASE_URL: "https://custom.groq.example.com/v1/",
      };

      await postChat(
        { model: "fast", messages: [{ role: "user", content: "Hi" }] },
        groqCustomEnv,
      );

      const firstCall = requireDefined(fetchSpy.mock.calls[0]);
      expect(firstCall[0].toString()).toBe(
        "https://custom.groq.example.com/v1/chat/completions",
      );

      const geminiCustomEnv: GatewayEnv = {
        ...mockEnv,
        PRIMARY_PROVIDER: "gemini",
        FALLBACK_MODEL: "gemini-2.5-flash-lite",
        GEMINI_BASE_URL: "https://custom.gemini.example.com/v1/",
      };

      await postChat(
        { model: "fast", messages: [{ role: "user", content: "Hi" }] },
        geminiCustomEnv,
      );

      const secondCall = requireDefined(fetchSpy.mock.calls[1]);
      expect(secondCall[0].toString()).toBe(
        "https://custom.gemini.example.com/v1/chat/completions",
      );
    });

    it("synthesizes completion id, created timestamp, and choice index when omitted by upstream", async () => {
      const minimalResponse = {
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(minimalResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        id: string;
        created: number;
        choices: Array<{ index: number }>;
      };
      expect(json.id).toMatch(/^chatcmpl-/);
      expect(typeof json.created).toBe("number");
      expect(json.choices[0]?.index).toBe(0);
    });

    it("returns 502 bad_gateway when upstream API key is missing", async () => {
      const groqMissingKeyResult = await forwardChatCompletion(
        {
          model: "fast",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
          extensions: {},
        },
        {},
      );
      expect(groqMissingKeyResult.ok).toBe(false);
      if (!groqMissingKeyResult.ok) {
        expect(groqMissingKeyResult.status).toBe(502);
        expect(groqMissingKeyResult.error.error.code).toBe("bad_gateway");
      }

      const geminiMissingKeyResult = await forwardChatCompletion(
        {
          model: "fast",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
          extensions: {},
        },
        { PRIMARY_PROVIDER: "gemini" },
      );
      expect(geminiMissingKeyResult.ok).toBe(false);
      if (!geminiMissingKeyResult.ok) {
        expect(geminiMissingKeyResult.status).toBe(502);
        expect(geminiMissingKeyResult.error.error.code).toBe("bad_gateway");
      }
    });
  });
});
