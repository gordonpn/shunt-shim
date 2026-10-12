import { Hono } from "hono";

export interface GatewayEnv {
  GATEWAY_TOKENS?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
}

export const app = new Hono<{ Bindings: GatewayEnv }>();

app.get("/", (c) => {
  return c.json({ status: "ok", service: "shunt-shim" });
});

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "shunt-shim" });
});

app.get("/v1/models", (c) => {
  return c.json({
    object: "list",
    data: [
      {
        id: "fast",
        object: "model",
        created: 1712000000,
        owned_by: "shunt-shim",
      },
    ],
  });
});

const handleChatCompletions = (c: { json: (data: unknown) => Response }) => {
  return c.json({
    id: "chatcmpl-bootstrap",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fast",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "shunt-shim gateway bootstrap",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
};

app.post("/v1/chat/completions", handleChatCompletions);
app.post("/chat/completions", handleChatCompletions);

export default app;
