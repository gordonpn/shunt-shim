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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

    it("does not trigger fallback when primary 200 body parsing rejects after client disconnect", async () => {
      const clientController = new AbortController();
      let bodyReadStarted = false;

      captureFetch(async () => {
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bodyReadStarted = true;
              clientController.abort();
              controller.error(new DOMException("Aborted", "AbortError"));
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, { status: 200 });
      });

      const res = await postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        clientController.signal,
      );

      expect(bodyReadStarted).toBe(true);
      expect(calls.length).toBe(1);
      expect([499, 502]).toContain(res.status);
    });

    it("makes no third attempt when fallback 200 body parsing rejects after client disconnect", async () => {
      const clientController = new AbortController();
      let bodyReadStarted = false;

      captureFetch(async (url) => {
        if (isGroqRequest(url)) {
          return new Response("Groq rate limited", { status: 429 });
        }
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bodyReadStarted = true;
              clientController.abort();
              controller.error(new DOMException("Aborted", "AbortError"));
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, { status: 200 });
      });

      const res = await postChatWithSignal(
        {
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        },
        clientController.signal,
      );

      expect(bodyReadStarted).toBe(true);
      expect(calls.length).toBe(2);
      expect([499, 502]).toContain(res.status);
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
    it.each(["request A", "request B"])(
      "keeps cancellation isolated when %s reaches upstream first",
      async (firstRequest) => {
        const controllerA = new AbortController();
        const controllerB = new AbortController();
        const startedA = deferred<void>();
        const startedB = deferred<void>();
        const releaseA = deferred<Response>();
        const releaseB = deferred<Response>();

        captureFetch(async (url, init) => {
          if (!isGroqRequest(url)) {
            throw new Error("Cancellation must not trigger fallback");
          }
          const payload = JSON.parse(String(init?.body)) as {
            messages: { content: string }[];
          };
          const content = payload.messages[0]?.content;
          if (content === "request A") {
            const signal = init?.signal;
            if (!signal) throw new Error("Request A signal was not forwarded");
            const abort = () => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              releaseA.reject(error);
            };
            signal.addEventListener("abort", abort, { once: true });
            startedA.resolve();
            try {
              if (signal.aborted) abort();
              return await releaseA.promise;
            } finally {
              signal.removeEventListener("abort", abort);
            }
          }
          if (content === "request B") {
            startedB.resolve();
            return releaseB.promise;
          }
          throw new Error(`Unexpected request content: ${content}`);
        });

        const start = (content: string, signal: AbortSignal) =>
          postChatWithSignal(
            { model: "fast", messages: [{ role: "user", content }] },
            signal,
          );
        const pending: Promise<Response>[] = [];
        try {
          // Exercise both arrival orders without relying on asynchronous auth.
          const aFirst = firstRequest === "request A";
          const first = start(
            firstRequest,
            aFirst ? controllerA.signal : controllerB.signal,
          );
          pending.push(first);
          await (aFirst ? startedA.promise : startedB.promise);
          const second = start(
            aFirst ? "request B" : "request A",
            aFirst ? controllerB.signal : controllerA.signal,
          );
          pending.push(second);
          await Promise.all([startedA.promise, startedB.promise]);

          controllerA.abort();
          const resA = await (aFirst ? first : second);
          expect([499, 504]).toContain(resA.status);
          const callB = calls.find((call) => {
            const messages = call.body?.messages as
              | { content: string }[]
              | undefined;
            return messages?.[0]?.content === "request B";
          });
          expect(callB?.signal).toBeDefined();
          expect(callB?.signal?.aborted).toBe(false);

          releaseB.resolve(Response.json(groqFixtures.textCompletion));
          const resB = await (aFirst ? second : first);
          expect(resB.status).toBe(200);
          const bodyB = (await resB.json()) as { object: string };
          expect(bodyB.object).toBe("chat.completion");
          expect(callB?.signal?.aborted).toBe(false);
          expect(calls).toHaveLength(2);
          expect(calls.every((call) => isGroqRequest(call.url))).toBe(true);
        } finally {
          controllerA.abort();
          controllerB.abort();
          releaseA.resolve(Response.json(groqFixtures.textCompletion));
          releaseB.resolve(Response.json(groqFixtures.textCompletion));
          await Promise.allSettled(pending);
        }
      },
    );
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
