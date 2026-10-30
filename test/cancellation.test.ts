import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../src/errors.js";
import { app, forwardChatCompletion, type GatewayEnv } from "../src/index.js";
import { geminiFixtures, groqFixtures } from "./fixtures/factories.js";

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
  signal: AbortSignal | undefined;
}

function getCall(capturedCalls: CapturedCall[], index: number): CapturedCall {
  const call = capturedCalls[index];
  if (!call) {
    throw new Error(`Expected call at index ${index} to be defined`);
  }
  return call;
}

function isGroqRequest(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === "api.groq.com" ||
      parsed.hostname === "custom-groq.internal"
    );
  } catch {
    return false;
  }
}

function createValidRequest(content = "hello") {
  return {
    model: "fast" as const,
    messages: [{ role: "user" as const, content }],
    stream: false as const,
    extensions: {},
  };
}

describe("Cancellation, Deadlines, and Commitment Specification (Subtask #34 / Story #32)", () => {
  let calls: CapturedCall[];

  beforeEach(() => {
    vi.restoreAllMocks();
    calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
          signal: init?.signal as AbortSignal | undefined,
        });
        return impl(url, init);
      },
    );
  };

  const postChatWithSignal = async (
    payload: unknown = {
      model: "fast",
      messages: [{ role: "user", content: "hello" }],
    },
    signal?: AbortSignal,
    env: GatewayEnv = mockEnv,
    authHeader = "Bearer test-gateway-token-12345",
  ) => {
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    };
    if (signal) {
      init.signal = signal;
    }
    const req = new Request("http://localhost/v1/chat/completions", init);
    return await app.request(req, undefined, env);
  };

  describe("Downstream Client Disconnect Propagation", () => {
    it("returns HTTP 504 gateway_timeout immediately when client signal is already aborted prior to dispatch", async () => {
      const clientController = new AbortController();
      clientController.abort();

      captureFetch(() => {
        throw new Error(
          "Upstream fetch must not be called when client is already aborted",
        );
      });

      const res = await postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        clientController.signal,
      );

      expect([499, 504]).toContain(res.status);
      expect(calls.length).toBe(0);
    });

    it("aborts active primary upstream fetch and does not initiate fallback when client disconnects", async () => {
      const clientController = new AbortController();

      captureFetch(async (url, init) => {
        if (isGroqRequest(url)) {
          expect(init?.signal).toBeDefined();
          clientController.abort();
          if (init?.signal?.aborted) {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            throw error;
          }
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const responsePromise = postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        clientController.signal,
      );

      const res = await responsePromise;
      expect(calls.length).toBe(1);
      const firstCall = getCall(calls, 0);
      expect(isGroqRequest(firstCall.url)).toBe(true);
      expect(firstCall.signal?.aborted).toBe(true);

      const geminiCalls = calls.filter((c) => !isGroqRequest(c.url));
      expect(geminiCalls.length).toBe(0);

      expect([499, 504]).toContain(res.status);
    });

    it("does not start fallback if client aborts during primary failure resolution", async () => {
      const clientController = new AbortController();

      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          clientController.abort();
          return new Response("Groq unavailable", { status: 503 });
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        clientController.signal,
      );

      expect(calls.length).toBe(1);
      const firstCall = getCall(calls, 0);
      expect(isGroqRequest(firstCall.url)).toBe(true);

      const geminiCalls = calls.filter((c) => !isGroqRequest(c.url));
      expect(geminiCalls.length).toBe(0);

      expect([499, 503, 504]).toContain(res.status);
    });

    it("aborts active fallback fetch and makes no third attempt when client disconnects during fallback", async () => {
      const clientController = new AbortController();

      captureFetch(async (url, init) => {
        if (isGroqRequest(url)) {
          return new Response("Groq rate limit exceeded", { status: 429 });
        }
        expect(init?.signal).toBeDefined();
        clientController.abort();
        if (init?.signal?.aborted) {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        }
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      });

      const res = await postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        clientController.signal,
      );

      expect(calls.length).toBe(2);
      const firstCall = getCall(calls, 0);
      const secondCall = getCall(calls, 1);
      expect(isGroqRequest(firstCall.url)).toBe(true);
      expect(isGroqRequest(secondCall.url)).toBe(false);
      expect(secondCall.signal?.aborted).toBe(true);

      expect([499, 504]).toContain(res.status);
    });
  });

  describe("Upstream Connect Timeout (5,000 ms)", () => {
    it("aborts primary attempt and triggers fallback to Gemini when primary hangs beyond connect timeout", async () => {
      const timeoutMs = 50;
      let primarySignalLiveAtStart = false;
      captureFetch(async (url, init) => {
        if (isGroqRequest(url)) {
          expect(init?.signal).toBeDefined();
          primarySignalLiveAtStart = !init?.signal?.aborted;
          const start = Date.now();
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const elapsed = Date.now() - start;
              if (elapsed < timeoutMs - 15) {
                reject(
                  new Error(`Primary aborted prematurely after ${elapsed}ms`),
                );
                return;
              }
              const error = new Error("Connection timeout");
              error.name = "TimeoutError";
              reject(error);
            });
          });
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await forwardChatCompletion(createValidRequest(), mockEnv, {
        connectTimeoutMs: timeoutMs,
        totalDeadlineMs: 1000,
      });

      expect(primarySignalLiveAtStart).toBe(true);
      expect(res.ok).toBe(true);
      expect(calls.length).toBe(2);
      const firstCall = getCall(calls, 0);
      const secondCall = getCall(calls, 1);
      expect(isGroqRequest(firstCall.url)).toBe(true);
      expect(firstCall.signal?.aborted).toBe(true);
      expect(isGroqRequest(secondCall.url)).toBe(false);
    });

    it("aborts fallback attempt and returns HTTP 504 gateway_timeout when both upstreams hang beyond connect timeout", async () => {
      const timeoutMs = 50;
      let primarySignalLiveAtStart = false;
      let fallbackSignalLiveAtStart = false;
      captureFetch(async (url, init) => {
        expect(init?.signal).toBeDefined();
        if (isGroqRequest(url)) {
          primarySignalLiveAtStart = !init?.signal?.aborted;
        } else {
          fallbackSignalLiveAtStart = !init?.signal?.aborted;
        }
        const start = Date.now();
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const elapsed = Date.now() - start;
            if (elapsed < timeoutMs - 15) {
              reject(new Error(`Aborted prematurely after ${elapsed}ms`));
              return;
            }
            const error = new Error("Connection timeout");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      });

      const res = await forwardChatCompletion(createValidRequest(), mockEnv, {
        connectTimeoutMs: timeoutMs,
        totalDeadlineMs: 1000,
      });

      expect(primarySignalLiveAtStart).toBe(true);
      expect(fallbackSignalLiveAtStart).toBe(true);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(504);
        expect(res.error.error.code).toBe("gateway_timeout");
      }
      expect(calls.length).toBe(2);
      const firstCall = getCall(calls, 0);
      const secondCall = getCall(calls, 1);
      expect(firstCall.signal?.aborted).toBe(true);
      expect(secondCall.signal?.aborted).toBe(true);
    });
  });

  describe("Total Request Deadline (60,000 ms)", () => {
    it("aborts active dispatch and returns HTTP 504 gateway_timeout when total deadline expires during primary", async () => {
      const deadlineMs = 50;
      let signalLiveAtStart = false;
      captureFetch(async (_url, init) => {
        expect(init?.signal).toBeDefined();
        signalLiveAtStart = !init?.signal?.aborted;
        const start = Date.now();
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const elapsed = Date.now() - start;
            if (elapsed < deadlineMs - 15) {
              reject(
                new Error(`Deadline aborted prematurely after ${elapsed}ms`),
              );
              return;
            }
            const error = new Error("Total deadline exceeded");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      });

      const res = await forwardChatCompletion(createValidRequest(), mockEnv, {
        connectTimeoutMs: 1000,
        totalDeadlineMs: deadlineMs,
      });

      expect(signalLiveAtStart).toBe(true);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(504);
        expect(res.error.error.code).toBe("gateway_timeout");
      }
      expect(calls.length).toBe(1);
      const firstCall = getCall(calls, 0);
      expect(firstCall.signal?.aborted).toBe(true);
    });

    it("does not start fallback when total request deadline has expired after primary failure", async () => {
      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          await new Promise((r) => setTimeout(r, 60));
          return new Response("Groq overloaded", { status: 503 });
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const res = await forwardChatCompletion(createValidRequest(), mockEnv, {
        connectTimeoutMs: 1000,
        totalDeadlineMs: 50,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(504);
        expect(res.error.error.code).toBe("gateway_timeout");
      }
      expect(calls.length).toBe(1);
      const firstCall = getCall(calls, 0);
      expect(isGroqRequest(firstCall.url)).toBe(true);
    });

    it("aborts active fallback fetch and returns HTTP 504 gateway_timeout when total deadline expires during fallback", async () => {
      captureFetch(async (url, init) => {
        if (isGroqRequest(url)) {
          return new Response("Groq rate limited", { status: 429 });
        }
        expect(init?.signal).toBeDefined();
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

      const res = await forwardChatCompletion(createValidRequest(), mockEnv, {
        connectTimeoutMs: 1000,
        totalDeadlineMs: 50,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(504);
        expect(res.error.error.code).toBe("gateway_timeout");
        expect(res.error.error.message).toBe("Total request deadline exceeded");
      }
      expect(calls.length).toBe(2);
      const firstCall = getCall(calls, 0);
      const secondCall = getCall(calls, 1);
      expect(isGroqRequest(firstCall.url)).toBe(true);
      expect(isGroqRequest(secondCall.url)).toBe(false);
      expect(secondCall.signal?.aborted).toBe(true);
    });
  });

  describe("Concurrent Request Isolation", () => {
    it("keeps concurrent requests isolated so cancellation of one does not abort another", async () => {
      const controllerA = new AbortController();
      const controllerB = new AbortController();

      captureFetch(async (url, init) => {
        if (isGroqRequest(url)) {
          if (init?.signal === controllerA.signal || calls.length === 1) {
            controllerA.abort();
            const sig = init?.signal;
            if (!sig) {
              const error = new Error("Aborted: signal not forwarded");
              error.name = "AbortError";
              throw error;
            }
            if (sig.aborted) {
              const error = new Error("Aborted");
              error.name = "AbortError";
              throw error;
            }
            return new Promise<Response>((_, reject) => {
              sig.addEventListener("abort", () => {
                const error = new Error("Aborted");
                error.name = "AbortError";
                reject(error);
              });
            });
          }
          const sig = init?.signal;
          if (sig?.aborted) {
            const error = new Error(
              "Aborted: request B was unexpectedly aborted",
            );
            error.name = "AbortError";
            throw error;
          }
          return Response.json(groqFixtures.textCompletion);
        }
        return Response.json(geminiFixtures.textCompletion);
      });

      const promiseA = postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "request A" }],
        },
        controllerA.signal,
      );

      const promiseB = postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "request B" }],
        },
        controllerB.signal,
      );

      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      expect([499, 504]).toContain(resA.status);
      expect(resB.status).toBe(200);
      const bodyB = (await resB.json()) as { object: string };
      expect(bodyB.object).toBe("chat.completion");
      const callB = getCall(calls, 1);
      expect(callB.signal?.aborted).toBe(false);
    });
  });

  describe("Streaming Rejection Invariant", () => {
    it("rejects stream: true with HTTP 400 unsupported_parameter before upstream dispatch", async () => {
      captureFetch(() => {
        throw new Error("Upstream fetch must not be called for stream: true");
      });

      const res = await postChatWithSignal({
        model: "fast",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiError;
      expect(body.error.code).toBe("unsupported_parameter");
      expect(body.error.param).toBe("stream");
      expect(calls.length).toBe(0);
    });

    it("rejects stream_options with HTTP 400 unsupported_parameter before upstream dispatch", async () => {
      captureFetch(() => {
        throw new Error("Upstream fetch must not be called for stream_options");
      });

      const res = await postChatWithSignal({
        model: "fast",
        messages: [{ role: "user", content: "hello" }],
        stream_options: { include_usage: true },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiError;
      expect(body.error.code).toBe("unsupported_parameter");
      expect(body.error.param).toBe("stream_options");
      expect(calls.length).toBe(0);
    });
  });
});
