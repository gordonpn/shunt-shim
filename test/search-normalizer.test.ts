import { describe, expect, it } from "vitest";
import {
  normalizeSearchResults,
  type RawProviderResultInput,
} from "../src/search/normalizer.js";

describe("normalizeSearchResults", () => {
  it("normalizes Tavily response payloads into canonical SearchResultItem entries", () => {
    const tavilyRaw: RawProviderResultInput[] = [
      {
        title: "  Tavily Search API Guide  ",
        url: "https://docs.tavily.com/sdk/reference/?utm_source=github&ref=readme",
        content:
          "Use the <b>Tavily</b> search endpoint to retrieve\u0000 grounded snippets.",
        score: 0.94,
        published_date: "2026-02-14T12:30:00Z",
      },
    ];

    const normalized = normalizeSearchResults(tavilyRaw, "tavily");
    expect(normalized).toEqual([
      {
        title: "Tavily Search API Guide",
        url: "https://docs.tavily.com/sdk/reference",
        snippet:
          "Use the Tavily search endpoint to retrieve grounded snippets.",
        published_date: "2026-02-14T12:30:00.000Z",
        score: 0.94,
        provider: "tavily",
      },
    ]);
  });

  it("normalizes Exa response payloads using text or highlights and publishedDate", () => {
    const exaRaw: RawProviderResultInput[] = [
      {
        title: "Exa Neural Search",
        url: "https://exa.ai/blog/neural-search?fbclid=123",
        text: "Neural embeddings for <em>semantic</em> web retrieval.",
        publishedDate: "2026-01-20T08:00:00.000Z",
        score: 0.88,
      },
      {
        title: "Exa Highlights Only",
        url: "https://exa.ai/docs/highlights/",
        highlights: [
          "First <mark>highlighted</mark> passage.",
          "Second passage.",
        ],
        publishedDate: null,
        score: 0.76,
      },
    ];

    const normalized = normalizeSearchResults(exaRaw, "exa");
    expect(normalized).toEqual([
      {
        title: "Exa Neural Search",
        url: "https://exa.ai/blog/neural-search",
        snippet: "Neural embeddings for semantic web retrieval.",
        published_date: "2026-01-20T08:00:00.000Z",
        score: 0.88,
        provider: "exa",
      },
      {
        title: "Exa Highlights Only",
        url: "https://exa.ai/docs/highlights",
        snippet: "First highlighted passage. Second passage.",
        published_date: null,
        score: 0.76,
        provider: "exa",
      },
    ]);
  });

  it("normalizes Brave response payloads using description and page_age/age", () => {
    const braveRaw: RawProviderResultInput[] = [
      {
        title: "Brave Web Search API",
        url: "https://brave.com/search/api/?gclid=abc",
        description:
          "Independent search index with <strong>privacy</strong> guarantees.",
        age: "2 days ago",
        page_age: "2026-03-01T00:00:00Z",
      },
    ];

    const normalized = normalizeSearchResults(braveRaw, "brave");
    expect(normalized).toEqual([
      {
        title: "Brave Web Search API",
        url: "https://brave.com/search/api",
        snippet: "Independent search index with privacy guarantees.",
        published_date: "2026-03-01T00:00:00.000Z",
        score: null,
        provider: "brave",
      },
    ]);
  });

  it("normalizes Parallel response payloads using excerpts and publish_date", () => {
    const parallelRaw: RawProviderResultInput[] = [
      {
        title: "Parallel Search Documentation",
        url: "https://parallel.ai/docs/search/?utm_campaign=launch",
        excerpts: [
          "Excerpt one from <span>Parallel</span>.",
          "Excerpt two with details.",
        ],
        publish_date: "2026-04-10T15:45:00Z",
        score: 0.91,
      },
    ];

    const normalized = normalizeSearchResults(parallelRaw, "parallel");
    expect(normalized).toEqual([
      {
        title: "Parallel Search Documentation",
        url: "https://parallel.ai/docs/search",
        snippet: "Excerpt one from Parallel. Excerpt two with details.",
        published_date: "2026-04-10T15:45:00.000Z",
        score: 0.91,
        provider: "parallel",
      },
    ]);
  });

  it("falls back to the canonical URL when title is missing or blank and clamps scores into [0.0, 1.0]", () => {
    const raw: RawProviderResultInput[] = [
      {
        title: "   ",
        url: "https://example.com/untitled-page/?utm_source=rss",
        content: "Body content for untitled page.",
        score: 1.45,
      },
      {
        url: "https://example.com/negative-score",
        content: "Negative score item.",
        score: -0.3,
      },
    ];

    const normalized = normalizeSearchResults(raw, "tavily");
    expect(normalized).toEqual([
      {
        title: "https://example.com/untitled-page",
        url: "https://example.com/untitled-page",
        snippet: "Body content for untitled page.",
        published_date: null,
        score: 1,
        provider: "tavily",
      },
      {
        title: "https://example.com/negative-score",
        url: "https://example.com/negative-score",
        snippet: "Negative score item.",
        published_date: null,
        score: 0,
        provider: "tavily",
      },
    ]);
  });

  it("merges duplicate canonical URLs while retaining highest score and backfilling missing metadata", () => {
    const raw: RawProviderResultInput[] = [
      {
        title: "Complete Guide to Edge Routing",
        url: "https://example.com/edge-routing?utm_source=hn&id=7",
        content: "Detailed snippet from the first duplicate.",
        published_date: "2026-03-10T09:00:00Z",
        score: 0.62,
      },
      {
        title: "",
        url: "https://example.com/edge-routing/?id=7&fbclid=xyz",
        content: "",
        published_date: null,
        score: 0.95,
      },
    ];

    const normalized = normalizeSearchResults(raw, "tavily");
    expect(normalized).toEqual([
      {
        title: "Complete Guide to Edge Routing",
        url: "https://example.com/edge-routing?id=7",
        snippet: "Detailed snippet from the first duplicate.",
        published_date: "2026-03-10T09:00:00.000Z",
        score: 0.95,
        provider: "tavily",
      },
    ]);
  });

  it("truncates canonical result snippets to 500 chars by default or honors custom maxSnippetChars", () => {
    const raw: RawProviderResultInput[] = [
      {
        title: "Long Content Result",
        url: "https://example.com/long",
        content: "x".repeat(750),
        score: 0.5,
      },
    ];

    const defaultNormalized = normalizeSearchResults(raw, "tavily");
    expect(defaultNormalized[0]?.snippet.length).toBe(500);
    expect(defaultNormalized[0]?.snippet.endsWith("...")).toBe(true);

    const customNormalized = normalizeSearchResults(raw, "tavily", {
      maxSnippetChars: 120,
    });
    expect(customNormalized[0]?.snippet.length).toBe(120);
    expect(customNormalized[0]?.snippet.endsWith("...")).toBe(true);
  });

  it("skips items with missing or invalid URLs and handles empty inputs", () => {
    const raw: RawProviderResultInput[] = [
      { title: "Missing URL" },
      { title: "Null URL", url: null },
      { title: "Invalid URL", url: "not-a-valid-url" },
      { title: "Unsupported protocol", url: "javascript:alert(1)" },
      {
        title: "Valid entry",
        url: "https://example.com/valid",
        snippet: "Direct <b>snippet</b> field.",
      },
    ];

    expect(normalizeSearchResults([], "tavily")).toEqual([]);
    expect(normalizeSearchResults(raw, "  tavily  ")).toEqual([
      {
        title: "Valid entry",
        url: "https://example.com/valid",
        snippet: "Direct snippet field.",
        published_date: null,
        score: null,
        provider: "tavily",
      },
    ]);
  });

  it("handles string and sparse array highlights, blank or unparseable dates, and string or non-finite scores", () => {
    const malformedArrayItem = JSON.parse(
      '{"title":"Sparse highlights","url":"https://example.com/sparse","highlights":[123,"   ","Usable highlight"],"published_date":"   ","score":"0.75"}',
    ) as RawProviderResultInput;

    const raw: RawProviderResultInput[] = [
      malformedArrayItem,
      {
        title: "String highlights and unparseable age",
        url: "https://example.com/string-hl",
        highlights: "Single <em>highlight</em> string.",
        age: "2 days ago",
        score: "   ",
      },
      {
        title: "Non-numeric score string",
        url: "https://example.com/bad-score",
        content: "Content here.",
        published_date: "not-a-date",
        score: "high",
      },
      {
        title: "NaN numeric score",
        url: "https://example.com/nan-score",
        content: "More content.",
        score: Number.NaN,
      },
    ];

    const normalized = normalizeSearchResults(raw, "exa");
    expect(normalized).toEqual([
      {
        title: "Sparse highlights",
        url: "https://example.com/sparse",
        snippet: "Usable highlight",
        published_date: null,
        score: 0.75,
        provider: "exa",
      },
      {
        title: "String highlights and unparseable age",
        url: "https://example.com/string-hl",
        snippet: "Single highlight string.",
        published_date: null,
        score: null,
        provider: "exa",
      },
      {
        title: "Non-numeric score string",
        url: "https://example.com/bad-score",
        snippet: "Content here.",
        published_date: null,
        score: null,
        provider: "exa",
      },
      {
        title: "NaN numeric score",
        url: "https://example.com/nan-score",
        snippet: "More content.",
        published_date: null,
        score: null,
        provider: "exa",
      },
    ]);
  });

  it("preserves primary metadata during duplicate merging when primary already has all fields", () => {
    const raw: RawProviderResultInput[] = [
      {
        title: "Primary Title",
        url: "https://example.com/complete?utm_source=a",
        content: "Primary snippet.",
        published_date: "2026-05-01T00:00:00Z",
        score: 0.9,
      },
      {
        title: "Secondary Title",
        url: "https://example.com/complete?utm_source=b",
        content: "Secondary snippet.",
        published_date: "2026-05-02T00:00:00Z",
        score: 0.4,
      },
    ];

    expect(normalizeSearchResults(raw, "tavily")).toEqual([
      {
        title: "Primary Title",
        url: "https://example.com/complete",
        snippet: "Primary snippet.",
        published_date: "2026-05-01T00:00:00.000Z",
        score: 0.9,
        provider: "tavily",
      },
    ]);
  });
});
