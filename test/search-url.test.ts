import { describe, expect, it } from "vitest";
import {
  TRACKING_QUERY_PARAMS,
  deduplicateResults,
  normalizeUrl,
} from "../src/search/url.js";

describe("normalizeUrl", () => {
  it("exposes the canonical tracking query parameter set", () => {
    expect(TRACKING_QUERY_PARAMS.has("utm_source")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("utm_medium")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("utm_campaign")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("utm_term")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("utm_content")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("ref")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("fbclid")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("gclid")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("msclkid")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("mc_cid")).toBe(true);
    expect(TRACKING_QUERY_PARAMS.has("mc_eid")).toBe(true);
  });

  it("strips utm_*, ref, fbclid, gclid, and other tracking query parameters", () => {
    const rawUrl =
      "https://example.com/articles/search?utm_source=newsletter&utm_medium=email&utm_campaign=spring&utm_term=ai&utm_content=cta&utm_custom=123&ref= producthunt &fbclid=abc123&gclid=xyz789&msclkid=m1&mc_cid=c1&mc_eid=e1";
    expect(normalizeUrl(rawUrl)).toBe("https://example.com/articles/search");
  });

  it("preserves functional query parameters (?q=, ?page=, ?id=) and sorts them deterministically", () => {
    const first =
      "https://example.com/search/?page=2&q=cloudflare+workers&id=42&utm_source=google&fbclid=track1";
    const second =
      "https://example.com/search?id=42&q=cloudflare+workers&page=2&ref=hn&gclid=track2";

    const normalizedFirst = normalizeUrl(first);
    const normalizedSecond = normalizeUrl(second);

    expect(normalizedFirst).toBe(
      "https://example.com/search?id=42&page=2&q=cloudflare+workers",
    );
    expect(normalizedSecond).toBe(normalizedFirst);
  });

  it("normalizes hostname casing, strips hash fragments, and removes trailing slashes on non-root paths", () => {
    expect(
      normalizeUrl("HTTPS://DOCS.Example.COM/guide/intro///#section-2"),
    ).toBe("https://docs.example.com/guide/intro");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("returns null for invalid URLs or unsupported protocols", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("not-a-valid-url")).toBeNull();
    expect(normalizeUrl("ftp://example.com/file.txt")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("mailto:user@example.com")).toBeNull();
  });
});

describe("deduplicateResults", () => {
  it("deduplicates entries sharing the same canonical URL and retains the highest-scoring item", () => {
    const items = [
      {
        title: "Lower scored variant",
        url: "https://example.com/docs/api/?utm_source=twitter",
        score: 0.45,
      },
      {
        title: "Distinct page",
        url: "https://example.com/docs/getting-started/?ref=nav",
        score: 0.7,
      },
      {
        title: "Highest scored variant",
        url: "https://EXAMPLE.com/docs/api#overview",
        score: 0.92,
      },
      {
        title: "Middle scored variant",
        url: "https://example.com/docs/api?fbclid=12345",
        score: 0.81,
      },
    ];

    const result = deduplicateResults(items);

    expect(result).toEqual([
      {
        title: "Highest scored variant",
        url: "https://example.com/docs/api",
        score: 0.92,
      },
      {
        title: "Distinct page",
        url: "https://example.com/docs/getting-started",
        score: 0.7,
      },
    ]);
  });

  it("retains the first occurrence when duplicate scores are equal or null and skips invalid URLs", () => {
    const items = [
      {
        title: "First with null score",
        url: "https://example.com/post?id=10&utm_medium=social",
        score: null,
      },
      {
        title: "Second with null score",
        url: "https://example.com/post/?id=10&gclid=999",
        score: null,
      },
      {
        title: "Invalid URL entry",
        url: "notaurl",
        score: 0.99,
      },
    ];

    const result = deduplicateResults(items);
    expect(result).toEqual([
      {
        title: "First with null score",
        url: "https://example.com/post?id=10",
        score: null,
      },
    ]);
  });

  it("replaces a null-scored entry when a later duplicate has a numeric score", () => {
    const items = [
      {
        title: "Unscored entry",
        url: "https://example.com/item?q=rust",
        score: null,
      },
      {
        title: "Scored duplicate",
        url: "https://example.com/item/?q=rust&utm_campaign=dev",
        score: 0.65,
      },
    ];

    const result = deduplicateResults(items);
    expect(result).toEqual([
      {
        title: "Scored duplicate",
        url: "https://example.com/item?q=rust",
        score: 0.65,
      },
    ]);
  });
});
