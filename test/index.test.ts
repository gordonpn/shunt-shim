import { describe, expect, it } from "vitest";
import {
  ALLOWED_FALLBACK_MODELS,
  ALLOWED_PRIMARY_MODELS,
  app,
  validateEnvironment,
} from "../src/index";

const mockEnv = {
  GATEWAY_TOKENS: "test-token-12345",
  GROQ_API_KEY: "test-groq-key",
  GEMINI_API_KEY: "test-gemini-key",
};

describe("Gateway HTTP Entrypoint", () => {
  it("responds with 200 on unauthenticated health endpoints", async () => {
    const rootRes = await app.request("/");
    expect(rootRes.status).toBe(200);
    const rootBody = (await rootRes.json()) as {
      status: string;
      service: string;
    };
    expect(rootBody).toEqual({ status: "ok", service: "shunt-shim" });

    const healthRes = await app.request("/health");
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as {
      status: string;
      service: string;
    };
    expect(healthBody).toEqual({ status: "ok", service: "shunt-shim" });
  });

  describe("Authentication Middleware", () => {
    const protectedRoutes = [
      { path: "/v1/models", method: "GET" },
      {
        path: "/v1/chat/completions",
        method: "POST",
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      {
        path: "/chat/completions",
        method: "POST",
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    ];

    function buildProtectedRequest(
      route: { path: string; method: string; body?: string },
      headers: Record<string, string>,
    ): RequestInit {
      const reqHeaders: Record<string, string> = { ...headers };
      if (route.body) {
        reqHeaders["Content-Type"] = "application/json";
      }
      const init: RequestInit = {
        method: route.method,
        headers: reqHeaders,
      };
      if (route.body) {
        init.body = route.body;
      }
      return init;
    }

    it("returns 401 when no token is provided across all protected endpoints", async () => {
      for (const route of protectedRoutes) {
        const res = await app.request(
          route.path,
          buildProtectedRequest(route, {}),
          mockEnv,
        );
        expect(res.status).toBe(401);
        const body = (await res.json()) as {
          error: { code: string; type: string };
        };
        expect(body.error.code).toBe("invalid_api_key");
        expect(body.error.type).toBe("invalid_request_error");
      }
    });

    it("returns 401 on malformed Authorization header formats", async () => {
      const malformedHeaders = [
        "Basic dXNlcjpwYXNz",
        "Token test-token-12345",
        "Bearer",
        "Bearer ",
        "Bearer    ",
        "CustomToken xyz",
      ];

      for (const header of malformedHeaders) {
        const res = await app.request(
          "/v1/models",
          {
            headers: {
              Authorization: header,
            },
          },
          mockEnv,
        );
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("invalid_api_key");
      }
    });

    it("returns 401 on empty or whitespace-only x-api-key header", async () => {
      const emptyApiKeys = ["", "   ", "\t"];
      for (const key of emptyApiKeys) {
        const res = await app.request(
          "/v1/models",
          {
            headers: {
              "x-api-key": key,
            },
          },
          mockEnv,
        );
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("invalid_api_key");
      }
    });

    it("returns 401 when Authorization and x-api-key conflict", async () => {
      for (const route of protectedRoutes) {
        const res = await app.request(
          route.path,
          buildProtectedRequest(route, {
            Authorization: "Bearer token-a",
            "x-api-key": "token-b",
          }),
          mockEnv,
        );
        expect(res.status).toBe(401);
        const body = (await res.json()) as {
          error: { message: string; code: string; type: string };
        };
        expect(body.error.code).toBe("invalid_api_key");
        expect(body.error.type).toBe("invalid_request_error");
        expect(body.error.message).toContain("Conflicting");
      }
    });

    it("authenticates via valid Bearer token across all protected routes", async () => {
      for (const route of protectedRoutes) {
        const res = await app.request(
          route.path,
          buildProtectedRequest(route, {
            Authorization: "Bearer test-token-12345",
          }),
          mockEnv,
        );
        expect(res.status).toBe(200);
      }
    });

    it("authenticates via valid x-api-key header across all protected routes", async () => {
      for (const route of protectedRoutes) {
        const res = await app.request(
          route.path,
          buildProtectedRequest(route, {
            "x-api-key": "test-token-12345",
          }),
          mockEnv,
        );
        expect(res.status).toBe(200);
      }
    });

    it("authenticates via matching dual headers across all protected routes", async () => {
      for (const route of protectedRoutes) {
        const res = await app.request(
          route.path,
          buildProtectedRequest(route, {
            Authorization: "Bearer test-token-12345",
            "x-api-key": "test-token-12345",
          }),
          mockEnv,
        );
        expect(res.status).toBe(200);
      }
    });

    it("returns 401 when environment token is not configured or empty", async () => {
      const res1 = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        {},
      );
      expect(res1.status).toBe(401);

      const res2 = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        { GATEWAY_TOKENS: "" },
      );
      expect(res2.status).toBe(401);
    });

    it("never reflects caller credentials in response bodies or headers", async () => {
      const sensitiveToken = "super-secret-user-bearer-token-xyz";
      const res = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: `Bearer ${sensitiveToken}`,
          },
        },
        mockEnv,
      );

      const rawText = await res.text();
      expect(rawText).not.toContain(sensitiveToken);
      expect(res.headers.get("Authorization")).toBeNull();
      expect(res.headers.get("x-api-key")).toBeNull();
    });
  });

  describe("Models Endpoint", () => {
    it("returns exactly one model with id fast and asserted catalog fields", async () => {
      const res = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        mockEnv,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        object: string;
        data: Array<{
          id: string;
          object: string;
          created: number;
          owned_by: string;
        }>;
      };

      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(1);
      const model = body.data[0];
      expect(model).toBeDefined();
      expect(model?.id).toBe("fast");
      expect(model?.object).toBe("model");
      expect(typeof model?.created).toBe("number");
      expect(model?.created).toBeGreaterThan(0);
      expect(model?.owned_by).toBe("shunt-shim");

      const ids = body.data.map((m) => m.id);
      expect(ids).toEqual(["fast"]);
    });

    it("returns 405 Method Not Allowed for unsupported methods prior to authentication", async () => {
      const unsupportedMethods = ["POST", "PUT", "DELETE", "PATCH"];
      for (const method of unsupportedMethods) {
        const res = await app.request(
          "/v1/models",
          {
            method,
          },
          mockEnv,
        );
        expect(res.status).toBe(405);
        expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
        const body = (await res.json()) as {
          error: { code: string; type: string };
        };
        expect(body.error.code).toBe("method_not_allowed");
        expect(body.error.type).toBe("invalid_request_error");
      }
    });
  });

  describe("Chat Completions Endpoints", () => {
    it("returns 405 Method Not Allowed on unsupported methods prior to authentication", async () => {
      const unsupportedMethods = ["GET", "PUT", "DELETE", "PATCH"];
      for (const path of ["/v1/chat/completions", "/chat/completions"]) {
        for (const method of unsupportedMethods) {
          const res = await app.request(
            path,
            {
              method,
            },
            mockEnv,
          );
          expect(res.status).toBe(405);
          expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
          const body = (await res.json()) as {
            error: { code: string; type: string };
          };
          expect(body.error.code).toBe("method_not_allowed");
          expect(body.error.type).toBe("invalid_request_error");
        }
      }
    });

    it("executes identical handler behavior for /v1/chat/completions and /chat/completions", async () => {
      const payload = {
        model: "fast",
        messages: [{ role: "user", content: "hello" }],
      };

      const res1 = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        mockEnv,
      );
      const body1 = (await res1.json()) as {
        object: string;
        model: string;
        choices: Array<{ message: { content: string } }>;
      };

      const res2 = await app.request(
        "/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        mockEnv,
      );
      const body2 = (await res2.json()) as {
        object: string;
        model: string;
        choices: Array<{ message: { content: string } }>;
      };

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(body1.object).toBe("chat.completion");
      expect(body2.object).toBe("chat.completion");
      expect(body1.model).toBe("fast");
      expect(body2.model).toBe("fast");
      expect(body1.choices[0]?.message.content).toBe(
        body2.choices[0]?.message.content,
      );
    });

    it("returns 400 on invalid JSON body", async () => {
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: "invalid-json",
        },
        mockEnv,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_json");
    });

    it("returns 400 on non-object JSON body such as null or arrays", async () => {
      const resNull = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: "null",
        },
        mockEnv,
      );
      expect(resNull.status).toBe(400);
      const bodyNull = (await resNull.json()) as { error: { code: string } };
      expect(bodyNull.error.code).toBe("invalid_json");

      const resArray = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: "[]",
        },
        mockEnv,
      );
      expect(resArray.status).toBe(400);
      const bodyArray = (await resArray.json()) as { error: { code: string } };
      expect(bodyArray.error.code).toBe("invalid_json");
    });

    it("returns 404 when requested model is unknown or missing", async () => {
      const unknownModels = [
        "unknown-model",
        "deep",
        "reasoning",
        "gpt-4",
        "llama-3.3-70b-versatile",
        "qwen/qwen3.8-27b",
      ];

      for (const modelName of unknownModels) {
        const resUnknown = await app.request(
          "/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer test-token-12345",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: modelName,
              messages: [{ role: "user", content: "hi" }],
            }),
          },
          mockEnv,
        );
        expect(resUnknown.status).toBe(404);
        const bodyUnknown = (await resUnknown.json()) as {
          error: { code: string; param: string };
        };
        expect(bodyUnknown.error.code).toBe("model_not_found");
        expect(bodyUnknown.error.param).toBe("model");
      }

      const resMissing = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
          }),
        },
        mockEnv,
      );
      expect(resMissing.status).toBe(404);
    });

    it("returns distinct unique completion IDs across multiple requests", async () => {
      const res1 = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "fast",
            messages: [{ role: "user", content: "test 1" }],
          }),
        },
        mockEnv,
      );
      const body1 = (await res1.json()) as { id: string };

      const res2 = await app.request(
        "/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "fast",
            messages: [{ role: "user", content: "test 2" }],
          }),
        },
        mockEnv,
      );
      const body2 = (await res2.json()) as { id: string };

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(body1.id).toMatch(/^chatcmpl-/);
      expect(body2.id).toMatch(/^chatcmpl-/);
      expect(body1.id).not.toBe(body2.id);
    });

    it("streams incremental SSE chunks when stream: true", async () => {
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "fast",
            stream: true,
            messages: [{ role: "user", content: "stream please" }],
          }),
        },
        mockEnv,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("chat.completion.chunk");
      expect(text).toContain("shunt-shim gateway bootstrap");
      expect(text).toContain("data: [DONE]");
    });
  });

  describe("Environment and Configuration Validation", () => {
    it("validates valid environment configuration successfully", () => {
      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GROQ_API_KEY: "groq-key",
          GEMINI_API_KEY: "gemini-key",
        }),
      ).not.toThrow();
    });

    it("throws explicit error when GATEWAY_TOKENS is missing or empty", () => {
      expect(() =>
        validateEnvironment({
          GROQ_API_KEY: "groq-key",
          GEMINI_API_KEY: "gemini-key",
        }),
      ).toThrow("Missing required environment secret: GATEWAY_TOKENS");

      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "   ",
          GROQ_API_KEY: "groq-key",
          GEMINI_API_KEY: "gemini-key",
        }),
      ).toThrow("Missing required environment secret: GATEWAY_TOKENS");
    });

    it("throws explicit error when GROQ_API_KEY is missing or empty", () => {
      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GEMINI_API_KEY: "gemini-key",
        }),
      ).toThrow("Missing required environment secret: GROQ_API_KEY");

      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GROQ_API_KEY: "",
          GEMINI_API_KEY: "gemini-key",
        }),
      ).toThrow("Missing required environment secret: GROQ_API_KEY");
    });

    it("throws explicit error when GEMINI_API_KEY is missing or empty", () => {
      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GROQ_API_KEY: "groq-key",
        }),
      ).toThrow("Missing required environment secret: GEMINI_API_KEY");

      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GROQ_API_KEY: "groq-key",
          GEMINI_API_KEY: "   ",
        }),
      ).toThrow("Missing required environment secret: GEMINI_API_KEY");
    });

    it("accepts allowed custom models for PRIMARY_MODEL and FALLBACK_MODEL", () => {
      for (const primary of ALLOWED_PRIMARY_MODELS) {
        for (const fallback of ALLOWED_FALLBACK_MODELS) {
          expect(() =>
            validateEnvironment({
              GATEWAY_TOKENS: "token-secret",
              GROQ_API_KEY: "groq-key",
              GEMINI_API_KEY: "gemini-key",
              PRIMARY_MODEL: primary,
              FALLBACK_MODEL: fallback,
            }),
          ).not.toThrow();
        }
      }
    });

    it("throws explicit error when PRIMARY_MODEL is disallowed", () => {
      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GROQ_API_KEY: "groq-key",
          GEMINI_API_KEY: "gemini-key",
          PRIMARY_MODEL: "llama-3.3-70b-versatile",
        }),
      ).toThrow(
        "Disallowed PRIMARY_MODEL configuration: llama-3.3-70b-versatile",
      );
    });

    it("throws explicit error when FALLBACK_MODEL is disallowed", () => {
      expect(() =>
        validateEnvironment({
          GATEWAY_TOKENS: "token-secret",
          GROQ_API_KEY: "groq-key",
          GEMINI_API_KEY: "gemini-key",
          FALLBACK_MODEL: "gemini-1.5-pro",
        }),
      ).toThrow("Disallowed FALLBACK_MODEL configuration: gemini-1.5-pro");
    });

    it("ensures error messages never leak secret values", () => {
      const privateSecret = "super-secret-key-that-must-not-leak";
      try {
        validateEnvironment({
          GATEWAY_TOKENS: privateSecret,
          GROQ_API_KEY: "groq-key",
          PRIMARY_MODEL: "disallowed-primary",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(privateSecret);
        expect(message).toContain(
          "Missing required environment secret: GEMINI_API_KEY",
        );
      }
    });
  });

  describe("Fallback and Not Found Handler", () => {
    it("returns OpenAI-style JSON 404 envelope for unknown paths", async () => {
      const res = await app.request("/unknown-route");
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { message: string; type: string; code: string };
      };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("not_found");
    });
  });
});
