import { describe, expect, it } from "vitest";
import {
  deduplicateResults,
  normalizeUrl,
  TRACKING_QUERY_PARAMS,
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

  it("preserves functional query parameters (?q=, ?page=, ?id=) and sorts parameter names stably", () => {
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

  it("sorts parameter names stably while preserving the original order of values for repeated parameters", () => {
    expect(
      normalizeUrl("https://example.com/search?q=zebra&q=apple&utm_source=x"),
    ).toBe("https://example.com/search?q=zebra&q=apple");

    expect(
      normalizeUrl(
        "https://example.com/search?z=2&q=zebra&a=1&q=apple&UTM_MEDIUM=email&Ref=nav",
      ),
    ).toBe("https://example.com/search?a=1&q=zebra&q=apple&z=2");
  });

  it("normalizes hostname casing, strips hash fragments, and removes trailing slashes on non-root paths", () => {
    expect(
      normalizeUrl("HTTPS://DOCS.Example.COM/guide/intro///#section-2"),
    ).toBe("https://docs.example.com/guide/intro");
    expect(normalizeUrl("http://Example.COM:8080/api/v1/")).toBe(
      "http://example.com:8080/api/v1",
    );
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com///")).toBe("https://example.com/");
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

  it("replaces a null-scored or non-finite-scored entry when a later duplicate has a finite score", () => {
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
      {
        title: "NaN scored entry",
        url: "https://example.com/other",
        score: Number.NaN,
      },
      {
        title: "Finite scored duplicate",
        url: "https://example.com/other/?ref=blog",
        score: 0.5,
      },
    ];

    const result = deduplicateResults(items);
    expect(result).toEqual([
      {
        title: "Scored duplicate",
        url: "https://example.com/item?q=rust",
        score: 0.65,
      },
      {
        title: "Finite scored duplicate",
        url: "https://example.com/other",
        score: 0.5,
      },
    ]);
  });

  it("does not collapse distinct repeated-parameter URLs", () => {
    const items = [
      {
        title: "Zebra then Apple",
        url: "https://example.com/search?q=zebra&q=apple&utm_source=a",
        score: 0.8,
      },
      {
        title: "Apple then Zebra",
        url: "https://example.com/search?q=apple&q=zebra&utm_source=b",
        score: 0.9,
      },
    ];

    const result = deduplicateResults(items);
    expect(result).toEqual([
      {
        title: "Zebra then Apple",
        url: "https://example.com/search?q=zebra&q=apple",
        score: 0.8,
      },
      {
        title: "Apple then Zebra",
        url: "https://example.com/search?q=apple&q=zebra",
        score: 0.9,
      },
    ]);
  });
});
