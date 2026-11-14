import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const categories = [
  "technical_docs",
  "github_discovery",
  "error_troubleshooting",
  "recent_releases",
];

function readQueries(): Record<string, unknown>[] {
  return JSON.parse(
    readFileSync(
      new URL("../scripts/eval/queries.json", import.meta.url),
      "utf8",
    ),
  );
}

describe("offline search evaluation corpus", () => {
  it("contains exactly 30 entries with the required schema", () => {
    const queries = readQueries();
    expect(Array.isArray(queries)).toBe(true);
    expect(queries).toHaveLength(30);
    for (const entry of queries) {
      expect(Object.keys(entry).sort()).toEqual([
        "category",
        "expected_domains",
        "query",
      ]);
      expect(typeof entry.query).toBe("string");
      expect(categories).toContain(entry.category);
      expect(Array.isArray(entry.expected_domains)).toBe(true);
      expect((entry.expected_domains as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("uses nonempty trimmed queries unique regardless of case", () => {
    const queries = readQueries().map((entry) => entry.query as string);
    for (const query of queries) {
      expect(query).toBe(query.trim());
      expect(query.length).toBeGreaterThan(0);
    }
    expect(new Set(queries.map((query) => query.toLowerCase())).size).toBe(30);
  });

  it("represents every supported intent category", () => {
    expect(
      [...new Set(readQueries().map((entry) => entry.category))].sort(),
    ).toEqual([...categories].sort());
  });

  it("uses unique canonical public hostnames without URLs or paths", () => {
    for (const entry of readQueries()) {
      const domains = entry.expected_domains as string[];
      expect(new Set(domains).size).toBe(domains.length);
      for (const domain of domains) {
        expect(typeof domain).toBe("string");
        expect(domain.length).toBeLessThanOrEqual(253);
        expect(domain).toMatch(
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        );
        expect(new URL(`https://${domain}`).hostname).toBe(domain);
      }
    }
  });
});
