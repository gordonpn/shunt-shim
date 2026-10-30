import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiagnosticRecord,
  emitDiagnostic,
  getCapturedDiagnostics,
  MAX_CAPTURED_RECORDS,
  resetDiagnosticSink,
  setDiagnosticCapture,
  setDiagnosticSink,
} from "../src/diagnostics.js";
import { app, forwardChatCompletion, type GatewayEnv } from "../src/index.js";
import { geminiFixtures, groqFixtures } from "./fixtures/factories.js";

function requireDefined<T>(
  val: T | undefined | null,
  message = "Expected value to be defined",
): T {
  if (val === undefined || val === null) {
    throw new Error(message);
  }
  return val;
}

const SECRET_GATEWAY_TOKEN = "gw-token-secret-marker-99999";
const SECRET_GROQ_KEY = "groq-key-secret-marker-88888";
const SECRET_GEMINI_KEY = "gemini-key-secret-marker-77777";
const SECRET_PROMPT_CONTENT = "CONFIDENTIAL_USER_PROMPT_PAYLOAD_12345";
const SECRET_COMPLETION_OUTPUT = "PROPRIETARY_MODEL_OUTPUT_ABC_67890";
const SECRET_TOOL_ARGUMENT = "CONFIDENTIAL_TOOL_ARGUMENT_XYZ_54321";
const SECRET_TOOL_RESULT = "CLASSIFIED_TOOL_RESULT_METRIC_09876";
const SECRET_ERROR_LEAK = "INTERNAL_UPSTREAM_STACK_TRACE_LEAK_44444";

const mockEnv: GatewayEnv = {
  GATEWAY_TOKENS: SECRET_GATEWAY_TOKEN,
  GROQ_API_KEY: SECRET_GROQ_KEY,
  GEMINI_API_KEY: SECRET_GEMINI_KEY,
};

function isGroqRequest(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === "api.groq.com";
  } catch {
    return false;
  }
}

describe("Private Diagnostics Specification (Task #37 / Story #36)", () => {
  let capturedLogs: string[];
  let capturedRecords: DiagnosticRecord[];

  beforeEach(() => {
    vi.restoreAllMocks();
    capturedLogs = [];
    capturedRecords = [];
    setDiagnosticSink((jsonString, record) => {
      capturedLogs.push(jsonString);
      capturedRecords.push(record);
    });
  });

  afterEach(() => {
    resetDiagnosticSink();
    vi.restoreAllMocks();
  });

  const postChat = async (
    payload: unknown = {
      model: "fast",
      messages: [{ role: "user", content: SECRET_PROMPT_CONTENT }],
    },
    env: GatewayEnv = mockEnv,
    authHeader = `Bearer ${SECRET_GATEWAY_TOKEN}`,
    extraHeaders?: Record<string, string>,
  ) => {
    return await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
      env,
    );
  };

  const captureFetch = (
    impl: (url: string, init?: RequestInit) => Promise<Response> | Response,
  ) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        return impl(url, init);
      },
    );
  };

  describe("Metadata Allowlist and Normal Diagnostic Emission", () => {
    it("emits structured metadata on primary success without fabricating fallback", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return Response.json({
            ...groqFixtures.textCompletion,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: SECRET_COMPLETION_OUTPUT,
                },
                finish_reason: "stop",
              },
            ],
          });
        }
        throw new Error("Fallback should not be called on primary success");
      });

      const res = await postChat();
      expect(res.status).toBe(200);

      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(typeof record.requestId).toBe("string");
      expect(record.requestId.length).toBeGreaterThan(0);
      expect(record.status).toBe(200);
      expect(record.provider).toBe("groq");
      expect(record.model).toBe("qwen/qwen3.8-27b");
      expect(record.attempts).toBe(1);
      expect(record.fallbackReason).toBeUndefined();
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);

      expect(res.headers.get("x-request-id")).toBe(record.requestId);
    });

    it("emits fallback reason on primary HTTP 429 and records Gemini on fallback success", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return new Response(
            JSON.stringify({
              error: {
                message: `Groq rate limit exceeded with ${SECRET_ERROR_LEAK}`,
                type: "invalid_request_error",
                code: "rate_limit_exceeded",
              },
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await postChat();
      expect(res.status).toBe(200);

      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(200);
      expect(record.provider).toBe("gemini");
      expect(record.model).toBe("gemini-2.5-flash-lite");
      expect(record.attempts).toBe(2);
      expect(record.fallbackReason).toBe("rate_limit_exceeded");
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("emits fallback reason on primary HTTP 503 and records Gemini on fallback success", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return new Response(
            JSON.stringify({
              error: {
                message: `Groq service unavailable: ${SECRET_ERROR_LEAK}`,
                type: "api_error",
                code: "service_unavailable",
              },
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await postChat();
      expect(res.status).toBe(200);

      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(200);
      expect(record.provider).toBe("gemini");
      expect(record.model).toBe("gemini-2.5-flash-lite");
      expect(record.attempts).toBe(2);
      expect(record.fallbackReason).toBe("service_unavailable");
    });

    it("emits fallback reason on primary connect timeout", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          const error = new Error("Connection timeout");
          error.name = "TimeoutError";
          throw error;
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await postChat();
      expect(res.status).toBe(200);

      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(200);
      expect(record.provider).toBe("gemini");
      expect(record.model).toBe("gemini-2.5-flash-lite");
      expect(record.attempts).toBe(2);
      expect(record.fallbackReason).toBe("connection_timeout");
    });

    it("emits fallback reason on primary network failure", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          throw new TypeError(
            `fetch failed: network socket reset ${SECRET_ERROR_LEAK}`,
          );
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await postChat();
      expect(res.status).toBe(200);

      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(200);
      expect(record.provider).toBe("gemini");
      expect(record.model).toBe("gemini-2.5-flash-lite");
      expect(record.attempts).toBe(2);
      expect(record.fallbackReason).toBe("network_error");
    });

    it("emits metadata when both providers fail with HTTP 429", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return new Response("Groq rate limited", { status: 429 });
        }
        return new Response("Gemini rate limited", { status: 429 });
      });

      const res = await postChat();
      expect(res.status).toBe(429);

      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(429);
      expect(record.provider).toBe("gemini");
      expect(record.model).toBe("gemini-2.5-flash-lite");
      expect(record.attempts).toBe(2);
      expect(record.fallbackReason).toBe("rate_limit_exceeded");
    });

    it("emits metadata when total deadline expires during primary", async () => {
      captureFetch(async (_url, init) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("Total request deadline exceeded");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      });

      const result = await forwardChatCompletion(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          extensions: {},
        },
        mockEnv,
        { totalDeadlineMs: 15 },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.diagnostic.provider).toBe("groq");
        expect(result.diagnostic.model).toBe("qwen/qwen3.8-27b");
        expect(result.diagnostic.attempts).toBe(1);
      }
    });

    it("emits metadata when total deadline expires during fallback", async () => {
      captureFetch(async (url, init) => {
        if (isGroqRequest(url)) {
          return new Response("Groq rate limited", { status: 429 });
        }
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            setTimeout(() => {
              const error = new Error("Total deadline exceeded");
              error.name = "TimeoutError";
              reject(error);
            }, 10);
          });
        });
      });

      const result = await forwardChatCompletion(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          extensions: {},
        },
        mockEnv,
        { connectTimeoutMs: 1000, totalDeadlineMs: 50 },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.diagnostic.provider).toBe("gemini");
        expect(result.diagnostic.model).toBe("gemini-2.5-flash-lite");
        expect(result.diagnostic.attempts).toBe(2);
        expect(result.diagnostic.fallbackReason).toBe("rate_limit_exceeded");
      }
    });

    it("emits metadata when client disconnects prior to dispatch", async () => {
      const controller = new AbortController();
      controller.abort();
      const init: RequestInit = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET_GATEWAY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        }),
        signal: controller.signal,
      };
      const req = new Request("http://localhost/v1/chat/completions", init);
      const res = await app.request(req, undefined, mockEnv);

      expect(res.status).toBe(504);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(504);
      expect(record.attempts).toBe(0);
    });
  });

  describe("Pre-dispatch Rejections (No Fabricated Provider/Model)", () => {
    it("does not fabricate provider or model on HTTP 401 unauthorized", async () => {
      const res = await postChat(
        { model: "fast", messages: [{ role: "user", content: "hello" }] },
        mockEnv,
        "Bearer wrong-token",
      );

      expect(res.status).toBe(401);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(401);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
      expect(record.fallbackReason).toBeUndefined();
      expect(record.attempts).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 400 invalid JSON", async () => {
      const res = await postChat("{ bad json", mockEnv);

      expect(res.status).toBe(400);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(400);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 400 unsupported stream: true", async () => {
      const res = await postChat({
        model: "fast",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });

      expect(res.status).toBe(400);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(400);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 400 empty messages", async () => {
      const res = await postChat({
        model: "fast",
        messages: [],
      });

      expect(res.status).toBe(400);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(400);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 404 unknown model", async () => {
      const res = await postChat({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(res.status).toBe(404);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(404);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 404 route not found", async () => {
      const res = await app.request(
        "/v1/unknown-route",
        { method: "GET" },
        mockEnv,
      );

      expect(res.status).toBe(404);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(404);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 405 method not allowed", async () => {
      const res = await app.request(
        "/v1/models",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${SECRET_GATEWAY_TOKEN}` },
        },
        mockEnv,
      );

      expect(res.status).toBe(405);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(405);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });

    it("does not fabricate provider or model on HTTP 500 environment validation failure", async () => {
      const invalidEnv: GatewayEnv = {
        GATEWAY_TOKENS: SECRET_GATEWAY_TOKEN,
        // missing GROQ_API_KEY and GEMINI_API_KEY
      };
      const res = await postChat(
        { model: "fast", messages: [{ role: "user", content: "hello" }] },
        invalidEnv,
      );

      expect(res.status).toBe(500);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.status).toBe(500);
      expect(record.provider).toBeUndefined();
      expect(record.model).toBeUndefined();
    });
  });

  describe("Absolute Privacy and Credential Exclusion", () => {
    it("strictly excludes prompts, completions, credentials, tool arguments, and raw errors from all logs", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return new Response(
            JSON.stringify({
              error: {
                message: `Groq internal failure with prompt: ${SECRET_PROMPT_CONTENT} and token ${SECRET_GROQ_KEY}`,
                type: "api_error",
                code: "service_unavailable",
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        return Response.json({
          ...geminiFixtures.toolCall,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: SECRET_COMPLETION_OUTPUT,
                tool_calls: [
                  {
                    id: "call_123",
                    type: "function",
                    function: {
                      name: "test_tool",
                      arguments: JSON.stringify({ arg: SECRET_TOOL_ARGUMENT }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      });

      const res = await postChat({
        model: "fast",
        messages: [
          { role: "system", content: "system instruction" },
          { role: "user", content: SECRET_PROMPT_CONTENT },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_prev",
                type: "function",
                function: {
                  name: "test_tool",
                  arguments: JSON.stringify({ arg: SECRET_TOOL_ARGUMENT }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_prev",
            content: SECRET_TOOL_RESULT,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
              parameters: { type: "object" },
            },
          },
        ],
      });

      expect(res.status).toBe(200);

      const allLogsCombined = capturedLogs.join("\n");

      // Verify that every single private marker is completely absent
      expect(allLogsCombined).not.toContain(SECRET_PROMPT_CONTENT);
      expect(allLogsCombined).not.toContain(SECRET_COMPLETION_OUTPUT);
      expect(allLogsCombined).not.toContain(SECRET_GATEWAY_TOKEN);
      expect(allLogsCombined).not.toContain(SECRET_GROQ_KEY);
      expect(allLogsCombined).not.toContain(SECRET_GEMINI_KEY);
      expect(allLogsCombined).not.toContain(SECRET_TOOL_ARGUMENT);
      expect(allLogsCombined).not.toContain(SECRET_TOOL_RESULT);
      expect(allLogsCombined).not.toContain("Authorization");
      expect(allLogsCombined).not.toContain("Bearer ");
      expect(allLogsCombined).not.toContain("x-api-key");
      expect(allLogsCombined).not.toContain("test_tool");
      expect(allLogsCombined).not.toContain("call_123");

      // Verify each captured log line is valid JSON with ONLY allowlisted keys
      const allowedKeys = new Set([
        "timestamp",
        "requestId",
        "status",
        "latencyMs",
        "provider",
        "model",
        "fallbackReason",
        "attempts",
      ]);

      for (const logLine of capturedLogs) {
        const parsed = JSON.parse(logLine) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) {
          expect(allowedKeys.has(key)).toBe(true);
        }
      }
    });

    it("uses console.log as default sink and does not retain records in memory unless opted in", async () => {
      resetDiagnosticSink();
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return Response.json(groqFixtures.textCompletion);
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await postChat();
      expect(res.status).toBe(200);

      expect(consoleSpy).toHaveBeenCalled();
      const lastCallArg = consoleSpy.mock.calls[0]?.[0];
      expect(typeof lastCallArg).toBe("string");
      const parsed = JSON.parse(lastCallArg as string) as Record<
        string,
        unknown
      >;
      expect(parsed.provider).toBe("groq");
      expect(parsed.status).toBe(200);

      // Verify records are NOT retained by default in memory
      expect(getCapturedDiagnostics().length).toBe(0);

      // Opt in to in-memory capture
      setDiagnosticCapture(true);
      await postChat();
      expect(getCapturedDiagnostics().length).toBe(1);

      // Disable in-memory capture and verify clearing
      setDiagnosticCapture(false);
      expect(getCapturedDiagnostics().length).toBe(0);
    });

    it("accepts valid client-provided x-request-id and echoes in response and diagnostics", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return Response.json(groqFixtures.textCompletion);
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const customRequestId = "custom-trace-id-abc-123";
      const res = await postChat(
        { model: "fast", messages: [{ role: "user", content: "hello" }] },
        mockEnv,
        `Bearer ${SECRET_GATEWAY_TOKEN}`,
        { "x-request-id": customRequestId },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBe(customRequestId);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.requestId).toBe(customRequestId);
    });

    it("generates UUID when client-provided x-request-id contains invalid characters", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return Response.json(groqFixtures.textCompletion);
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const invalidRequestId = "invalid request id with spaces and @@ symbols";
      const res = await postChat(
        { model: "fast", messages: [{ role: "user", content: "hello" }] },
        mockEnv,
        `Bearer ${SECRET_GATEWAY_TOKEN}`,
        { "x-request-id": invalidRequestId },
      );

      expect(res.status).toBe(200);
      const returnedId = res.headers.get("x-request-id");
      expect(returnedId).not.toBe(invalidRequestId);
      expect(returnedId?.length).toBe(36);
      expect(capturedRecords.length).toBe(1);
      const record = requireDefined(capturedRecords[0]);
      expect(record.requestId).toBe(returnedId);
    });

    it("returns 504 and zero attempts when forwardChatCompletion receives an already aborted signal", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const result = await forwardChatCompletion(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          extensions: {},
        },
        mockEnv,
        { signal: abortController.signal },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.diagnostic.attempts).toBe(0);
      }
    });

    it("bounds in-memory captured records to MAX_CAPTURED_RECORDS, discarding oldest", () => {
      resetDiagnosticSink();
      setDiagnosticCapture(true);

      for (let i = 0; i < MAX_CAPTURED_RECORDS + 5; i++) {
        emitDiagnostic({
          timestamp: new Date().toISOString(),
          requestId: `req-${i}`,
          status: 200,
          latencyMs: 1,
        });
      }

      const captured = getCapturedDiagnostics();
      expect(captured.length).toBe(MAX_CAPTURED_RECORDS);
      expect(captured[0]?.requestId).toBe("req-5");
      expect(captured[captured.length - 1]?.requestId).toBe(
        `req-${MAX_CAPTURED_RECORDS + 4}`,
      );
    });
  });
});
