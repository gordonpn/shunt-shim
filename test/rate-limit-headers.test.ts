import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index.js";

const env = {
  GATEWAY_TOKENS: "gateway",
  GROQ_API_KEY: "groq",
  GEMINI_API_KEY: "gemini",
};

afterEach(() => vi.restoreAllMocks());

describe("Final-attempt retry metadata (#77)", () => {
  it.each([429, 503])(
    "preserves only allowlisted headers on final HTTP %i",
    async (status) => {
      const headers = {
        "Retry-After": "60",
        "x-ratelimit-limit-requests": "30",
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-remaining-tokens": "2",
        "x-ratelimit-reset-requests": "1m",
        "x-ratelimit-reset-tokens": "10s",
      };
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: {
              "Retry-After": "999",
              "x-ratelimit-reset-requests": "wrong",
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status,
            headers: {
              ...headers,
              "x-ratelimit-private": "secret",
              Authorization: "secret",
              "set-cookie": "secret",
            },
          }),
        );
      const response = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer gateway",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "fast",
            messages: [{ role: "user", content: "hello" }],
          }),
        },
        env,
      );
      expect(response.status).toBe(status);
      for (const [name, value] of Object.entries(headers))
        expect(response.headers.get(name)).toBe(value);
      for (const name of ["x-ratelimit-private", "authorization", "set-cookie"])
        expect(response.headers.has(name)).toBe(false);
    },
  );
});
