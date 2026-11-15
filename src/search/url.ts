/**
 * Known marketing, analytics, and ad-click tracking query parameters
 * that should be stripped during canonical URL normalization.
 */
export const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACKING_QUERY_PARAMS.has(lower) || lower.startsWith("utm_");
}

function toFiniteScore(score: number | null | undefined): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  return score;
}

/**
 * Normalizes a raw result URL into a canonical form suitable for comparison
 * and deduplication.
 *
 * - Parses using the WHATWG URL API and accepts only http: and https: protocols.
 * - Lowercases the hostname and removes hash fragments.
 * - Removes marketing/tracking query parameters while preserving and sorting
 *   functional query parameters for deterministic comparison.
 * - Strips trailing slashes from non-root paths.
 */
export function normalizeUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.hostname.length === 0) {
    return null;
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";

  const retainedParams: Array<readonly [string, string]> = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!isTrackingParam(key)) {
      retainedParams.push([key, value]);
    }
  }

  retainedParams.sort((left, right) => {
    if (left[0] !== right[0]) {
      return left[0] < right[0] ? -1 : 1;
    }
    if (left[1] !== right[1]) {
      return left[1] < right[1] ? -1 : 1;
    }
    return 0;
  });

  parsed.search = "";
  for (const [key, value] of retainedParams) {
    parsed.searchParams.append(key, value);
  }

  if (parsed.pathname.length > 1) {
    const strippedPath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = strippedPath.length > 0 ? strippedPath : "/";
  }

  return parsed.toString();
}

/**
 * Normalizes each item's URL and deduplicates entries sharing the same
 * canonical URL. When duplicates occur, the entry with the highest numeric
 * score is retained (or the first occurrence when scores are equal or absent).
 */
export function deduplicateResults<
  T extends {
    readonly url: string;
    readonly score?: number | null | undefined;
  },
>(items: readonly T[]): T[] {
  const deduplicated: T[] = [];
  const indexByUrl = new Map<string, number>();

  for (const item of items) {
    const canonicalUrl = normalizeUrl(item.url);
    if (canonicalUrl === null) {
      continue;
    }

    const normalizedItem: T = {
      ...item,
      url: canonicalUrl,
    };

    const existingIndex = indexByUrl.get(canonicalUrl);
    if (existingIndex === undefined) {
      indexByUrl.set(canonicalUrl, deduplicated.length);
      deduplicated.push(normalizedItem);
      continue;
    }

    const existingItem = deduplicated[existingIndex];
    if (existingItem === undefined) {
      continue;
    }

    const existingScore = toFiniteScore(existingItem.score);
    const candidateScore = toFiniteScore(normalizedItem.score);

    if (
      candidateScore !== null &&
      (existingScore === null || candidateScore > existingScore)
    ) {
      deduplicated[existingIndex] = normalizedItem;
    }
  }

  return deduplicated;
}
