import { describe, expect, it } from "vitest";
import { app } from "../src/index";

const mockEnv = {
  GATEWAY_TOKENS: "test-token-12345",
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
    it("returns 401 when no token is provided", async () => {
      const res = await app.request("/v1/models", {}, mockEnv);
      expect(res.status).toBe(401);
      const body = (await res.json()) as {
        error: { code: string; type: string };
      };
      expect(body.error.code).toBe("invalid_api_key");
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 401 on malformed Authorization header", async () => {
      const res = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: "Basic dXNlcjpwYXNz",
          },
        },
        mockEnv,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_api_key");
    });

    it("returns 400 when Authorization and x-api-key conflict", async () => {
      const res = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: "Bearer token-a",
            "x-api-key": "token-b",
          },
        },
        mockEnv,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { message: string; code: string };
      };
      expect(body.error.code).toBe("invalid_api_key");
      expect(body.error.message).toContain("Conflicting");
    });

    it("authenticates via valid Bearer token", async () => {
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
        data: Array<{ id: string }>;
      };
      expect(body.object).toBe("list");
      expect(body.data[0]?.id).toBe("fast");
    });

    it("authenticates via valid x-api-key header", async () => {
      const res = await app.request(
        "/v1/models",
        {
          headers: {
            "x-api-key": "test-token-12345",
          },
        },
        mockEnv,
      );
      expect(res.status).toBe(200);
    });

    it("returns 401 when environment tokens are not configured", async () => {
      const res = await app.request(
        "/v1/models",
        {
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        {},
      );
      expect(res.status).toBe(401);
    });
  });

  describe("Models Endpoint", () => {
    it("returns 405 Method Not Allowed for unsupported methods", async () => {
      const res = await app.request(
        "/v1/models",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        mockEnv,
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("method_not_allowed");
    });
  });

  describe("Chat Completions Endpoints", () => {
    it("returns 405 Method Not Allowed on GET requests", async () => {
      const res1 = await app.request(
        "/v1/chat/completions",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        mockEnv,
      );
      expect(res1.status).toBe(405);
      expect(res1.headers.get("Allow")).toBe("POST, OPTIONS");

      const res2 = await app.request(
        "/chat/completions",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer test-token-12345",
          },
        },
        mockEnv,
      );
      expect(res2.status).toBe(405);
      expect(res2.headers.get("Allow")).toBe("POST, OPTIONS");
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
      const resUnknown = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-12345",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "unknown-model",
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
