import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constantTimeTokenEqual,
  matchesAnyGatewayToken,
  parseGatewayTokens,
} from "../src/auth.js";
import { app } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("Constant-time token equality", () => {
  it.each([
    { left: "test-secret", right: "test-secret", equal: true },
    { left: "test-secret", right: "xxxx-xxxxxx", equal: false },
    { left: "test-secret", right: "test-secreX", equal: false },
    { left: "test-secret", right: "test", equal: false },
    { left: "test", right: "test-secret", equal: false },
    { left: "", right: "test-secret", equal: false },
    { left: "", right: "", equal: true },
    { left: "clé", right: "clé", equal: true },
    { left: "clé", right: "cle", equal: false },
  ])(
    "compares $left and $right using fixed-size native buffers",
    async ({ left, right, equal }) => {
      const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
      expect(await constantTimeTokenEqual(left, right)).toBe(equal);
      expect(compare).toHaveBeenCalledOnce();
      const args = compare.mock.calls[0];
      expect(args?.[0].byteLength).toBe(32);
      expect(args?.[1].byteLength).toBe(32);
    },
  );
});

describe("Authentication comparison integration", () => {
  const env = {
    GATEWAY_TOKENS: "test-secret",
    GROQ_API_KEY: "test-groq",
    GEMINI_API_KEY: "test-gemini",
  };

  it.each(["wrong-token", "test-secreX", "test", "test-secret-longer"])(
    "rejects invalid Bearer and API key values: %s",
    async (token) => {
      for (const headers of [
        { Authorization: `Bearer ${token}` },
        { "x-api-key": token },
      ]) {
        const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
        const res = await app.request("/v1/models", { headers }, env);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({
          error: { code: "invalid_api_key" },
        });
        expect(compare).toHaveBeenCalled();
        compare.mockRestore();
      }
    },
  );

  it("compares matching dual headers and the configured token natively", async () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    const res = await app.request(
      "/v1/models",
      {
        headers: {
          Authorization: "Bearer test-secret",
          "x-api-key": "test-secret",
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting dual headers using the native comparator", async () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    const res = await app.request(
      "/v1/models",
      {
        headers: { Authorization: "Bearer test-secret", "x-api-key": "test" },
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: {
        code: "invalid_api_key",
        message: expect.stringContaining("Conflicting"),
      },
    });
    expect(compare).toHaveBeenCalledOnce();
  });
});

describe("Multi-token parsing and matching", () => {
  it.each([
    { raw: undefined, expected: [] },
    { raw: "", expected: [] },
    { raw: "   ", expected: [] },
    { raw: " , , ", expected: [] },
    { raw: "token-a", expected: ["token-a"] },
    {
      raw: " token-a , token-b , , token-a ",
      expected: ["token-a", "token-b"],
    },
  ])("parses GATEWAY_TOKENS=$raw cleanly", ({ raw, expected }) => {
    expect(parseGatewayTokens(raw)).toEqual(expected);
  });

  it("returns false immediately when configured token list is empty", async () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    expect(await matchesAnyGatewayToken("any-token", [])).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });

  it("checks every configured candidate in constant time before matching", async () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    expect(
      await matchesAnyGatewayToken("review-secret", [
        "prod-secret",
        "review-secret",
      ]),
    ).toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it("accepts either independent token and rejects combined literal or mismatched pairs", async () => {
    const multiEnv = {
      GATEWAY_TOKENS: "prod-secret, review-secret",
      GROQ_API_KEY: "test-groq",
      GEMINI_API_KEY: "test-gemini",
    };

    for (const headers of [
      { Authorization: "Bearer prod-secret" },
      { "x-api-key": "prod-secret" },
      { Authorization: "Bearer review-secret" },
      { "x-api-key": "review-secret" },
    ]) {
      const res = await app.request("/v1/models", { headers }, multiEnv);
      expect(res.status).toBe(200);
    }

    const literalCombined = await app.request(
      "/v1/models",
      { headers: { Authorization: "Bearer prod-secret, review-secret" } },
      multiEnv,
    );
    expect(literalCombined.status).toBe(401);

    const mismatchedDual = await app.request(
      "/v1/models",
      {
        headers: {
          Authorization: "Bearer prod-secret",
          "x-api-key": "review-secret",
        },
      },
      multiEnv,
    );
    expect(mismatchedDual.status).toBe(401);
    expect(await mismatchedDual.json()).toMatchObject({
      error: { message: expect.stringContaining("Conflicting") },
    });

    const commaOnlyEnv = {
      GATEWAY_TOKENS: " , ",
      GROQ_API_KEY: "test-groq",
      GEMINI_API_KEY: "test-gemini",
    };
    const rejected = await app.request(
      "/v1/models",
      { headers: { Authorization: "Bearer prod-secret" } },
      commaOnlyEnv,
    );
    expect(rejected.status).toBe(401);
  });
});
