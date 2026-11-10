import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardChatCompletion } from "../src/upstream.js";
import type { ValidatedChatCompletionRequest } from "../src/validation.js";
import { groqFixtures } from "./fixtures/factories.js";

const request: ValidatedChatCompletionRequest = {
  model: "fast" as const,
  messages: [{ role: "user" as const, content: "hello" }],
  stream: false,
  extensions: {},
};
const env = { GROQ_API_KEY: "test-groq", GEMINI_API_KEY: "test-gemini" };

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function failure(status: number, cancel: () => void | Promise<void>) {
  return new Response(new ReadableStream({ cancel }), {
    status,
    headers: { "Retry-After": "17" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Failed upstream response cleanup", () => {
  it.each([429, 503])(
    "awaits primary %i cleanup before fallback",
    async (status) => {
      const started = barrier();
      const finished = barrier();
      const cancel = vi.fn(() => {
        started.resolve();
        return finished.promise;
      });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(failure(status, cancel))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(groqFixtures.textCompletion)),
        );
      const operation = forwardChatCompletion(request, env);
      await started.promise;
      expect(fetch).toHaveBeenCalledTimes(1);
      finished.resolve();
      expect((await operation).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 401, 403, 500])(
    "cancels terminal primary %i without fallback",
    async (status) => {
      const cancel = vi.fn();
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(failure(status, cancel));
      const result = await forwardChatCompletion(request, env);
      expect(result).toMatchObject({ ok: false, status: 502 });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([429, 503, 400, 500])(
    "awaits fallback %i cleanup before returning",
    async (status) => {
      const started = barrier();
      const finished = barrier();
      const cancel = vi.fn(() => {
        started.resolve();
        return finished.promise;
      });
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(failure(429, () => {}))
        .mockResolvedValueOnce(failure(status, cancel));
      let settled = false;
      const operation = forwardChatCompletion(request, env).then((result) => {
        settled = true;
        return result;
      });
      await started.promise;
      expect(settled).toBe(false);
      finished.resolve();
      const result = await operation;
      expect(result).toMatchObject({
        ok: false,
        status: status === 429 || status === 503 ? status : 502,
      });
      if (!result.ok && status === 429) {
        expect(result.headers?.["Retry-After"]).toBe("17");
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("preserves the upstream error when both cancellation hooks reject", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(failure(429, cancel))
      .mockResolvedValueOnce(failure(503, cancel));
    expect(await forwardChatCompletion(request, env)).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("accepts an error response without a body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 400 }),
    );
    expect(await forwardChatCompletion(request, env)).toMatchObject({
      ok: false,
      status: 502,
    });
  });

  it.each(["primary", "fallback"])(
    "bounds hung %s cleanup by the total deadline",
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const fetch = vi.spyOn(globalThis, "fetch");
      if (stage === "fallback")
        fetch.mockResolvedValueOnce(failure(429, () => {}));
      fetch.mockResolvedValueOnce(failure(503, cancel));
      const operation = forwardChatCompletion(request, env, {
        totalDeadlineMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(await operation).toMatchObject({ ok: false, status: 504 });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(stage === "primary" ? 1 : 2);
    },
  );

  it.each(["primary", "fallback"])(
    "stops waiting on %s cleanup after client disconnect",
    async (stage) => {
      const started = barrier();
      const controller = new AbortController();
      const cancel = vi.fn(() => {
        started.resolve();
        return new Promise<void>(() => {});
      });
      const fetch = vi.spyOn(globalThis, "fetch");
      if (stage === "fallback")
        fetch.mockResolvedValueOnce(failure(429, () => {}));
      fetch.mockResolvedValueOnce(failure(503, cancel));
      const operation = forwardChatCompletion(request, env, {
        signal: controller.signal,
      });
      await started.promise;
      controller.abort();
      expect(await operation).toMatchObject({ ok: false, status: 504 });
      expect(fetch).toHaveBeenCalledTimes(stage === "primary" ? 1 : 2);
    },
  );
});
