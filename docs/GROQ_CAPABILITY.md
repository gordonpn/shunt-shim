# Groq Free-Tier Capability Verification Report

Date: 2026-10-12
Status: Verified
Provider: Groq Cloud
Endpoint: `https://api.groq.com/openai/v1/chat/completions`

This report provides account-specific evidence for Groq free-tier models and OpenAI compatibility, establishing observed capabilities and constraints for `shunt-shim`.

## 1. Account Model Catalog

Probing `GET https://api.groq.com/openai/v1/models` against the active free-tier account returned 11 active models.

| Model ID | Status | Capabilities | Context / Notes |
| :--- | :--- | :--- | :--- |
| `openai/gpt-oss-120b` | Verified Available | Chat, Reasoning, Tools, SSE | 128k context, emits `reasoning_tokens` |
| `openai/gpt-oss-20b` | Verified Available (catalog) | Not account-probed | Lightweight reasoning model |
| `qwen/qwen3.8-27b` | Verified Available | Chat, Tools, SSE | Fast standard chat completions |
| `llama-3.3-70b-versatile` | Not Available (404) | None | Returns HTTP 404 `model_not_found` |

`llama-3.3-70b-versatile` is not accessible on this account tier. `qwen/qwen3.8-27b` is selected and pinned as the primary chat model for `fast` because it reliably passes all required completion, streaming, and tool tests without unexpected upstream validation failures.

## 2. Text JSON Completions

Probing non-streaming chat completions with standard JSON payloads:

- **Request**:
  ```json
  {
    "model": "qwen/qwen3.8-27b",
    "messages": [{"role": "user", "content": "Respond with the word 'pong'."}],
    "temperature": 0.0,
    "max_completion_tokens": 16
  }
  ```
- **Observed Response**: HTTP 200 OK.
  - `id`: `chatcmpl-b3221454-bfb8-4840-af8c-8cc1b5dc9eb1`
  - `object`: `chat.completion`
  - `model`: `qwen/qwen3.8-27b`
  - `choices[0].finish_reason`: `stop`
  - `choices[0].message.content`: `pong`
  - `usage`: Valid object with `prompt_tokens`, `completion_tokens`, `total_tokens`, and queue/exec timing metadata.
  - `openai/gpt-oss-120b` additionally includes `completion_tokens_details.reasoning_tokens`.

## 3. Incremental SSE Streaming

Probing streaming chat completions:

- **Request**:
  ```json
  {
    "model": "qwen/qwen3.8-27b",
    "messages": [{"role": "user", "content": "Count from 1 to 5."}],
    "stream": true,
    "stream_options": {"include_usage": true},
    "max_tokens": 64
  }
  ```
- **Observed Behavior**:
  - Response header: `Content-Type: text/event-stream`.
  - Initial chunk: Emits role delta `{"role": "assistant", "content": ""}`.
  - Subsequent chunks: Stream incremental content deltas.
  - Usage chunk: Emits an event with empty `choices: []` containing the `usage` object immediately prior to termination.
  - Stream termination: Emits `data: [DONE]`.

## 4. Tool Calling and Tool Results Round Trip

Probing tool calling with a function declaration (`get_file_diff`):

- **Step 1 (Tool Invocation)**:
  - Request with `tools` array and `tool_choice: "auto"`.
  - Observed response: HTTP 200 OK.
  - `choices[0].finish_reason`: `tool_calls`.
  - `choices[0].message.tool_calls`: Valid array containing item with unique `id`, `type: "function"`, and valid JSON string in `function.arguments`.
- **Step 2 (Tool Result Feedback)**:
  - Follow-up request containing user message, assistant message with `tool_calls`, and tool response message (`role: "tool"`, `tool_call_id: "<id>"`, `content: "..."`).
  - Observed response: HTTP 200 OK.
  - `choices[0].finish_reason`: `stop`.
  - Assistant synthesizes final answer referencing the tool output.

## 5. Parameter Handling and Output Limits

- **`max_tokens` vs `max_completion_tokens`**:
  - `max_tokens: 10`: Accepted, produces HTTP 200 with `finish_reason: "length"`.
  - `max_completion_tokens: 10`: Accepted, produces HTTP 200 with `finish_reason: "length"`.
  - Both supplied (`max_tokens: 5, max_completion_tokens: 15`): Accepted, `max_completion_tokens` takes precedence.
- **`tool_choice` Variants**:
  - `auto`: HTTP 200, model decides to invoke tool.
  - `required`: HTTP 200, forces tool invocation (`finish_reason: "tool_calls"`).
  - Named function (`{"type": "function", "function": {"name": "..."}}`): HTTP 200, forces specific tool invocation.
  - `none`: Supported on `qwen/qwen3.8-27b` (HTTP 200, `finish_reason: "stop"`, zero tool calls emitted). In contrast, `openai/gpt-oss-120b` failed when tested with `tool_choice: "none"` (the model attempted tool generation and returned HTTP 400 `tool_use_failed`), disqualifying it as the unmapped primary model.
