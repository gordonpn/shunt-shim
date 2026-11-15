import { describe, expect, it } from "vitest";
import {
  CANONICAL_RESULT_SNIPPET_CHARS,
  DEFAULT_MAX_SNIPPET_CHARS,
  sanitizeSnippet,
} from "../src/search/normalizer.js";

describe("sanitizeSnippet", () => {
  it("strips HTML highlight and formatting tags including attributes", () => {
    const raw =
      'Search <b>results</b> for <em class="hl">Cloudflare</em> <mark data-id="1">Workers</mark> with <strong>fast</strong> <i>edge</i> <span style="color:red">routing</span>.';
    expect(sanitizeSnippet(raw)).toBe(
      "Search results for Cloudflare Workers with fast edge routing.",
    );
  });

  it("removes null bytes and ASCII control characters (0x00-0x1F, 0x7F) while preserving Unicode text", () => {
    const raw =
      "Café\u0000 résumé\u0007 naïve\u0008 日本語テスト\u000B\u000C Привет\u001B\u001F мир\u007F €100";
    expect(sanitizeSnippet(raw)).toBe(
      "Café résumé naïve 日本語テスト Привет мир €100",
    );
  });

  it("normalizes CRLF, collapses 3+ blank lines to double newlines, and collapses horizontal whitespace while preserving code tokens", () => {
    const raw =
      "First paragraph with   multiple\t\tspaces.\r\n\r\n\r\n\r\nconst fn = (a: number, b: number) => a + b;\r\n   \r\n   \r\nFinal line.";
    expect(sanitizeSnippet(raw)).toBe(
      "First paragraph with multiple spaces.\n\nconst fn = (a: number, b: number) => a + b;\n\nFinal line.",
    );
  });

  it("clamps snippets to 500 characters and 1,000 characters with ellipsis when truncated", () => {
    const longInput = "a".repeat(1250);

    const clamped500 = sanitizeSnippet(
      longInput,
      CANONICAL_RESULT_SNIPPET_CHARS,
    );
    expect(clamped500.length).toBe(500);
    expect(clamped500.endsWith("...")).toBe(true);
    expect(clamped500).toBe(`${"a".repeat(497)}...`);

    const clamped1000 = sanitizeSnippet(longInput, DEFAULT_MAX_SNIPPET_CHARS);
    expect(clamped1000.length).toBe(1000);
    expect(clamped1000.endsWith("...")).toBe(true);
    expect(clamped1000).toBe(`${"a".repeat(997)}...`);
  });

  it("handles null, undefined, empty strings, and non-positive maxChars gracefully", () => {
    expect(sanitizeSnippet(null)).toBe("");
    expect(sanitizeSnippet(undefined)).toBe("");
    expect(sanitizeSnippet("")).toBe("");
    expect(sanitizeSnippet("hello world", 0)).toBe("");
    expect(sanitizeSnippet("hello world", 2)).toBe("..");
  });
});
