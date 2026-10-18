import groqFinalAnswer from "./groq/final-answer.json";
import groqMultiToolCall from "./groq/multi-tool-call.json";
import groqTextCompletion from "./groq/text-completion.json";
import groqToolCall from "./groq/tool-call.json";

import geminiFinalAnswer from "./gemini/final-answer.json";
import geminiMultiToolCall from "./gemini/multi-tool-call.json";
import geminiTextCompletion from "./gemini/text-completion.json";
import geminiToolCall from "./gemini/tool-call.json";

export interface FixtureToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface FixtureChoiceMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: FixtureToolCall[];
}

export interface FixtureCompletionChoice {
  index: number;
  message: FixtureChoiceMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | string;
}

export interface FixtureCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: FixtureCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export const groqFixtures = {
  toolCall: groqToolCall as FixtureCompletionResponse,
  multiToolCall: groqMultiToolCall as FixtureCompletionResponse,
  finalAnswer: groqFinalAnswer as FixtureCompletionResponse,
  textCompletion: groqTextCompletion as FixtureCompletionResponse,
};

export const geminiFixtures = {
  toolCall: geminiToolCall as FixtureCompletionResponse,
  multiToolCall: geminiMultiToolCall as FixtureCompletionResponse,
  finalAnswer: geminiFinalAnswer as FixtureCompletionResponse,
  textCompletion: geminiTextCompletion as FixtureCompletionResponse,
};

export function createTestToolDeclaration() {
  return {
    type: "function" as const,
    function: {
      name: "get_file_diff",
      description: "Inspect changes in git repository",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
        },
        required: ["file"],
      },
    },
  };
}

export function createMultiTestToolDeclarations() {
  return [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "Read file contents",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "check_status",
        description: "Check status",
        parameters: {
          type: "object",
          properties: { verbose: { type: "boolean" } },
        },
      },
    },
  ];
}
