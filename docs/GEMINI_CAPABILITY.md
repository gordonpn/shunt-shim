# Google Gemini Free-Tier Capability Verification Report

Date: 2026-10-12
Status: Verified
Provider: Google AI Studio
Endpoint: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`

This report provides account-specific evidence for Google Gemini free-tier models and OpenAI compatibility, establishing observed capabilities and constraints for `shunt-shim`.

## 1. Account Model Catalog

Probing `GET https://generativelanguage.googleapis.com/v1beta/openai/models` against the active free-tier account returned 62 models.

| Model ID | Status | Capabilities | Context / Notes |
| :--- | :--- | :--- | :--- |
| `gemini-2.5-flash-lite` | Verified Available | Chat, Tools, SSE | 1M context, low latency, active free tier |
| `gemini-3.8-flash` | Verified Available (catalog) | Not account-probed | High-throughput frontier model |
| `gemini-2.5-flash` | Unavailable to new users on tested account (404) | None | Returns HTTP 404: "no longer available to new users" |

`gemini-2.5-flash-lite` is verified as the primary fallback model for `shunt-shim`.

## 2. Text JSON Completions

Probing non-streaming chat completions with standard JSON payloads:

- **Request**:
  ```json
  {
    "model": "gemini-2.5-flash-lite",
    "messages": [{"role": "user", "content": "Respond with the word 'pong'."}],
    "max_tokens": 16
  }
  ```
- **Observed Response**: HTTP 200 OK.
  - `id`: `RUPNar__DPuc1MkPt5KskAk`
  - `object`: `chat.completion`
  - `model`: `gemini-2.5-flash-lite`
  - `choices[0].finish_reason`: `stop`
  - `choices[0].message.content`: `pong`
  - `usage`: Valid object with `prompt_tokens`, `completion_tokens`, and `total_tokens`.

## 3. Incremental SSE Streaming

Probing streaming chat completions:

- **Request**:
  ```json
  {
    "model": "gemini-2.5-flash-lite",
    "messages": [{"role": "user", "content": "Count from 1 to 5."}],
    "stream": true,
    "stream_options": {"include_usage": true},
    "max_tokens": 64
  }
  ```
- **Observed Behavior**:
  - Response header: `Content-Type: text/event-stream`.
  - Initial chunk: Emits role delta `{"role": "assistant", "content": "..."}`.
  - Incremental chunks: Stream content updates.
  - Terminal chunk: When `stream_options.include_usage: true` is requested, Gemini delivers a combined chunk containing both `choices` (with `finish_reason: "stop"`) and the `usage` object.
  - Stream termination: Emits `data: [DONE]`.
- **Streaming Normalization Requirement**:
  - Standard OpenAI SSE clients expect a dedicated usage event with `choices: []` immediately preceding `data: [DONE]`.
  - The gateway streaming normalizer will split Gemini's combined terminal chunk: emit the content chunk with `choices` (omitting `usage`), immediately followed by an event with `choices: []` carrying `usage`, preserving the OpenAI-compatible stream contract.

## 4. Tool Calling and Tool Results Round Trip

Probing tool calling with a function declaration (`get_file_diff`):

- **Step 1 (Tool Invocation)**:
  - Request with `tools` array and `tool_choice: "auto"`.
  - Observed response: HTTP 200 OK.
  - `choices[0].finish_reason`: `tool_calls`.
  - `choices[0].message.tool_calls`: Valid array containing item with unique `id` (e.g. `function-call-16129457148116551221`), `type: "function"`, and valid JSON string in `function.arguments`.
- **Step 2 (Tool Result Feedback)**:
  - Follow-up request containing user message, assistant message with `tool_calls`, and tool response message (`role: "tool"`, `tool_call_id: "<id>"`, `content: "..."`).
  - Observed response: HTTP 200 OK.
  - `choices[0].finish_reason`: `stop`.
  - Assistant synthesizes final answer referencing the tool output.

## 5. Parameter Handling and Output Limits

- **`max_tokens` vs `max_completion_tokens`**:
  - `max_tokens: 10`: Accepted, produces HTTP 200 with `finish_reason: "length"`.
  - `max_completion_tokens: 10`: Accepted, produces HTTP 200 with `finish_reason: "length"`.
  - **Important Constraint**: If both `max_tokens` and `max_completion_tokens` are supplied simultaneously, Gemini returns HTTP 400 `INVALID_ARGUMENT: "max_tokens and max_completion_tokens cannot both be set"`.
  - **Gateway Rule**: The gateway MUST normalize incoming client output limit fields into a single parameter before dispatching to Gemini.
- **`tool_choice` Variants**:
  - `auto`: HTTP 200, tool called when relevant.
  - `required`: HTTP 200, forces tool invocation (`finish_reason: "tool_calls"`).
  - Named function (`{"type": "function", "function": {"name": "..."}}`): HTTP 200, forces specific tool invocation.
  - `none`: HTTP 200, honors `none` and emits text without calling tool (`finish_reason: "length"` or `"stop"`).
