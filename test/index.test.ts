import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("Gateway HTTP Entrypoint", () => {
  it("responds with 200 and status ok on root path", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toEqual({ status: "ok", service: "shunt-shim" });
  });

  it("responds with 200 and status ok on health path", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toEqual({ status: "ok", service: "shunt-shim" });
  });

  it("responds with 200 and model list on /v1/models", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe("fast");
  });

  it("responds with 200 on /v1/chat/completions", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "fast",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe(
      "shunt-shim gateway bootstrap",
    );
  });

  it("responds with 200 on /chat/completions alias", async () => {
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "fast",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe(
      "shunt-shim gateway bootstrap",
    );
  });

  it("responds with 404 on unknown route", async () => {
    const res = await app.request("/unknown-route");
    expect(res.status).toBe(404);
  });
});
