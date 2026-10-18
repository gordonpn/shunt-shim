import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../src/errors.js";
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

const mockEnv: GatewayEnv = {
  GATEWAY_TOKENS: "test-gateway-token-12345",
  GROQ_API_KEY: "test-groq-key-67890",
  GEMINI_API_KEY: "test-gemini-key-54321",
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

describe("Bounded Fallback Specification (Subtask #30 / Story #28)", () => {
  let calls: CapturedCall[];

  beforeEach(() => {
    vi.restoreAllMocks();
    calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const postChat = async (
    payload: unknown = {
      model: "fast",
      messages: [{ role: "user", content: "hello" }],
    },
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
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = new Headers(init.headers);
          h.forEach((val, key) => {
            headers[key] = val;
          });
        }
        let parsedBody: Record<string, unknown> | undefined;
        if (typeof init?.body === "string") {
          try {
            parsedBody = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            parsedBody = undefined;
          }
        }
        calls.push({
          url,
          method: init?.method ?? "GET",
          headers,
          body: parsedBody,
        });
        return impl(url, init);
      },
    );
  };

  describe("Primary Success (No Fallback)", () => {
    it("returns primary Groq response immediately and never calls Gemini when Groq succeeds", async () => {
      captureFetch(async () => {
        return new Response(JSON.stringify(groqFixtures.textCompletion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const res = await postChat();
      const body = (await res.json()) as { id: string; model: string };

      expect(res.status).toBe(200);
      expect(body.model).toBe("fast");
      expect(calls.length).toBe(1);
      const call0 = requireDefined(calls[0]);
      expect(call0.url).toContain("api.groq.com");
      expect(call0.headers.authorization).toBe(
        `Bearer ${mockEnv.GROQ_API_KEY}`,
      );
    });
  });

  describe("Eligible Primary Failures Triggering Gemini Fallback", () => {
    const eligibleCases = [
      {
        description: "HTTP 429 Too Many Requests (Rate limit / quota)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Rate limit reached",
                type: "tokens",
                code: "rate_limit_exceeded",
              },
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "5",
              },
            },
          ),
      },
      {
        description: "HTTP 503 Service Unavailable",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Service Unavailable",
                type: "api_error",
                code: "service_unavailable",
              },
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description: "Network error / connect timeout",
        mockResponse: () => {
          throw new TypeError("fetch failed: connect timeout");
        },
      },
    ];

    for (const testCase of eligibleCases) {
      it(`falls back to Gemini and succeeds when Groq fails with ${testCase.description}`, async () => {
        captureFetch(async (url) => {
          if (url.includes("api.groq.com")) {
            return testCase.mockResponse();
          }
          return new Response(JSON.stringify(geminiFixtures.textCompletion), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });

        const res = await postChat();
        const body = (await res.json()) as { id: string; model: string };

        expect(res.status).toBe(200);
        expect(body.model).toBe("fast");
        expect(calls.length).toBe(2);
        const call0 = requireDefined(calls[0]);
        const call1 = requireDefined(calls[1]);
        expect(call0.url).toContain("api.groq.com");
        expect(call0.headers.authorization).toBe(
          `Bearer ${mockEnv.GROQ_API_KEY}`,
        );
        expect(call1.url).toContain("generativelanguage.googleapis.com");
        expect(call1.headers.authorization).toBe(
          `Bearer ${mockEnv.GEMINI_API_KEY}`,
        );
        expect(call1.body?.model).toBe("gemini-2.5-flash-lite");
      });
    }

    it("falls back to Gemini and preserves tool call structures returned by Gemini", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Rate limited", { status: 429 });
        }
        return new Response(JSON.stringify(geminiFixtures.toolCall), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const res = await postChat();
      const body = (await res.json()) as {
        id: string;
        choices: Array<{
          finish_reason: string;
          message: {
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };

      expect(res.status).toBe(200);
      expect(calls.length).toBe(2);
      const choice0 = requireDefined(body.choices[0]);
      expect(choice0.finish_reason).toBe("tool_calls");
      const toolCalls = requireDefined(choice0.message.tool_calls);
      const toolCall0 = requireDefined(toolCalls[0]);
      expect(toolCall0.function.name).toBe("get_file_diff");
    });
  });

  describe("Ineligible Primary Failures (Fallback Prohibited)", () => {
    const ineligibleCases = [
      {
        description: "HTTP 400 Bad Request (upstream rejection)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Bad request parameters",
                type: "invalid_request_error",
              },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description: "HTTP 401 Unauthorized (invalid upstream credential)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Invalid API key",
                type: "authentication_error",
              },
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description: "HTTP 403 Forbidden (upstream permission error)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Forbidden access",
                type: "permission_error",
              },
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description: "HTTP 404 Not Found (invalid model endpoint)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Model not found",
                type: "invalid_request_error",
              },
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description:
          "HTTP 500 Internal Server Error (transient server failure)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Internal server error",
                type: "api_error",
              },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description: "HTTP 502 Bad Gateway (upstream proxy error)",
        mockResponse: () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Bad gateway upstream",
                type: "api_error",
              },
            }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      {
        description: "Malformed JSON response body",
        mockResponse: () =>
          new Response("{ unclosed json string ", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        description: "Invalid completion structure (missing choices)",
        mockResponse: () =>
          new Response(JSON.stringify({ id: "invalid-shape" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ];

    for (const testCase of ineligibleCases) {
      it(`does not call Gemini fallback when Groq returns ${testCase.description}`, async () => {
        captureFetch(async (url) => {
          if (url.includes("api.groq.com")) {
            return testCase.mockResponse();
          }
          return new Response(JSON.stringify(geminiFixtures.textCompletion), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });

        const res = await postChat();

        expect(res.status).toBe(502);
        expect(calls.length).toBe(1);
        const call0 = requireDefined(calls[0]);
        expect(call0.url).toContain("api.groq.com");
      });
    }
  });

  describe("Exhausted Providers (Both Primary and Fallback Fail)", () => {
    it("returns HTTP 429 when both Groq and Gemini return HTTP 429", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Groq rate limit exceeded",
                type: "tokens",
                code: "rate_limit_exceeded",
              },
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "2",
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            error: {
              message: "Gemini quota exhausted",
              type: "tokens",
              code: "rate_limit_exceeded",
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "8",
            },
          },
        );
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect(res.status).toBe(429);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(res.headers.get("Retry-After")).toBe("8");
      expect(calls.length).toBe(2);
    });

    it("returns HTTP 503 when both Groq and Gemini return HTTP 503", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq unavailable", { status: 503 });
        }
        return new Response("Gemini unavailable", { status: 503 });
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect(res.status).toBe(503);
      expect(body.error.code).toBe("service_unavailable");
      expect(calls.length).toBe(2);
    });

    it("returns HTTP 429 when Groq returns 503 but fallback Gemini returns 429", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq unavailable", { status: 503 });
        }
        return new Response("Gemini quota exhausted", {
          status: 429,
          headers: { "Retry-After": "10" },
        });
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect(res.status).toBe(429);
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(res.headers.get("Retry-After")).toBe("10");
      expect(calls.length).toBe(2);
    });

    it("returns HTTP 503 when Groq returns 429 but fallback Gemini returns 503", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq quota exhausted", { status: 429 });
        }
        return new Response("Gemini unavailable", { status: 503 });
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect(res.status).toBe(503);
      expect(body.error.code).toBe("service_unavailable");
      expect(calls.length).toBe(2);
    });

    it("returns HTTP 504 / 502 when Groq returns 429 but fallback Gemini times out", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq quota exhausted", { status: 429 });
        }
        throw new TypeError("fetch failed: connection timeout");
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect([502, 504]).toContain(res.status);
      expect(body.error).toBeDefined();
      expect(calls.length).toBe(2);
    });

    it("returns HTTP 502 when Groq returns 429 and fallback Gemini returns a non-retryable 500 error", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq quota exhausted", { status: 429 });
        }
        return new Response("Gemini internal server error", { status: 500 });
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect(res.status).toBe(502);
      expect(body.error.code).toBe("bad_gateway");
      expect(calls.length).toBe(2);
    });

    it("returns HTTP 502 when Groq returns 429 and fallback Gemini returns malformed JSON", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq quota exhausted", { status: 429 });
        }
        return new Response("malformed { not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const res = await postChat();
      const body = (await res.json()) as ApiError;

      expect(res.status).toBe(502);
      expect(body.error.code).toBe("bad_gateway");
      expect(calls.length).toBe(2);
    });
  });

  describe("Single Fallback Constraint (At Most One Fallback)", () => {
    it("never makes a third attempt even if fallback fails", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq 429", { status: 429 });
        }
        return new Response("Gemini 503", { status: 503 });
      });

      const res = await postChat();

      expect(res.status).toBe(503);
      expect(calls.length).toBe(2);
      const call0 = requireDefined(calls[0]);
      const call1 = requireDefined(calls[1]);
      expect(call0.url).toContain("api.groq.com");
      expect(call1.url).toContain("generativelanguage.googleapis.com");
    });
  });

  describe("Credential Safety on Fallback", () => {
    it("never reflects gateway tokens or upstream keys in error responses during fallback failure", async () => {
      const secretGatewayToken = "gateway-secret-token-xyz-987";
      const secretGroqKey = "groq-super-secret-key-123";
      const secretGeminiKey = "gemini-super-secret-key-456";

      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq 429", { status: 429 });
        }
        return new Response("Gemini 503", { status: 503 });
      });

      const res = await postChat(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        {
          GATEWAY_TOKENS: secretGatewayToken,
          GROQ_API_KEY: secretGroqKey,
          GEMINI_API_KEY: secretGeminiKey,
        },
        `Bearer ${secretGatewayToken}`,
      );

      const bodyText = await res.text();
      expect(bodyText).not.toContain(secretGatewayToken);
      expect(bodyText).not.toContain(secretGroqKey);
      expect(bodyText).not.toContain(secretGeminiKey);

      for (const [headerName, headerValue] of res.headers.entries()) {
        expect(headerName.toLowerCase()).not.toContain(secretGatewayToken);
        expect(headerValue).not.toContain(secretGatewayToken);
        expect(headerValue).not.toContain(secretGroqKey);
        expect(headerValue).not.toContain(secretGeminiKey);
      }
    });

    it("returns HTTP 502 when primary fails with 429 but GEMINI_API_KEY is not configured", async () => {
      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Groq 429", { status: 429 });
        }
        return new Response(JSON.stringify(geminiFixtures.textCompletion), {
          status: 200,
        });
      });

      const req = {
        model: "fast" as const,
        messages: [{ role: "user" as const, content: "hello" }],
        stream: false as const,
        extensions: {},
      };

      const result = await forwardChatCompletion(req, {
        GATEWAY_TOKENS: "test-gateway-token-12345",
        GROQ_API_KEY: "test-groq-key-67890",
        GEMINI_API_KEY: "",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(502);
      }
      expect(calls.length).toBe(1);
    });
  });

  describe("Custom Model and Base URL Configuration on Fallback", () => {
    it("respects custom GROQ_BASE_URL and GEMINI_BASE_URL during fallback", async () => {
      const customEnv: GatewayEnv = {
        ...mockEnv,
        GROQ_BASE_URL: "https://custom-groq.internal/v1",
        GEMINI_BASE_URL: "https://custom-gemini.internal/v1beta/openai",
      };

      captureFetch(async (url) => {
        if (url.includes("custom-groq.internal")) {
          return new Response("Primary 429", { status: 429 });
        }
        return new Response(JSON.stringify(geminiFixtures.textCompletion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const res = await postChat(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        customEnv,
      );

      expect(res.status).toBe(200);
      expect(calls.length).toBe(2);
      const call0 = requireDefined(calls[0]);
      const call1 = requireDefined(calls[1]);
      expect(call0.url).toBe(
        "https://custom-groq.internal/v1/chat/completions",
      );
      expect(call1.url).toBe(
        "https://custom-gemini.internal/v1beta/openai/chat/completions",
      );
    });

    it("respects custom FALLBACK_MODEL override on Gemini when falling back", async () => {
      const customEnv: GatewayEnv = {
        ...mockEnv,
        FALLBACK_MODEL: "gemini-2.5-flash-lite",
      };

      captureFetch(async (url) => {
        if (url.includes("api.groq.com")) {
          return new Response("Primary 503", { status: 503 });
        }
        return new Response(JSON.stringify(geminiFixtures.textCompletion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const res = await postChat(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        customEnv,
      );

      expect(res.status).toBe(200);
      expect(calls.length).toBe(2);
      const call1 = requireDefined(calls[1]);
      expect(call1.body?.model).toBe("gemini-2.5-flash-lite");
    });
  });
});
