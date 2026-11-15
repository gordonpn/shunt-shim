import { deduplicateResults, normalizeUrl } from "./url.js";

/**
 * Canonical search result item produced by the normalizer regardless of which
 * upstream search provider served the query.
 */
export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published_date: string | null;
  readonly score: number | null;
  readonly provider: string;
}

/**
 * Default maximum character bound for standalone snippet sanitization.
 */
export const DEFAULT_MAX_SNIPPET_CHARS = 1000;

/**
 * Default maximum character bound for normalized canonical search result snippets.
 */
export const CANONICAL_RESULT_SNIPPET_CHARS = 500;

/**
 * Heterogeneous raw result shape accepted from upstream search providers:
 * - Tavily: title, url, content, score, published_date
 * - Exa: title, url, text, highlights, publishedDate, score
 * - Brave: title, url, description, age, page_age
 * - Parallel: title, url, excerpts, publish_date, score
 */
export interface RawProviderResultInput {
  readonly title?: string | null | undefined;
  readonly url?: string | null | undefined;
  readonly snippet?: string | null | undefined;
  readonly content?: string | null | undefined;
  readonly text?: string | null | undefined;
  readonly highlights?: readonly string[] | string | null | undefined;
  readonly description?: string | null | undefined;
  readonly excerpts?: readonly string[] | string | null | undefined;
  readonly published_date?: string | null | undefined;
  readonly publishedDate?: string | null | undefined;
  readonly publish_date?: string | null | undefined;
  readonly page_age?: string | null | undefined;
  readonly age?: string | null | undefined;
  readonly score?: number | string | null | undefined;
}

export interface NormalizeSearchResultsOptions {
  readonly maxSnippetChars?: number | undefined;
}

const HTML_HIGHLIGHT_TAG_PATTERN =
  /<\/?(?:b|em|mark|strong|i|span)(?:\s[^>]*)?>/gi;

function isDisallowedControlCode(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
}

function stripControlCharacters(input: string): string {
  let result = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (!isDisallowedControlCode(code)) {
      result += input.charAt(i);
    }
  }
  return result;
}

/**
 * Sanitizes raw snippet text by removing null bytes and ASCII control
 * characters, stripping HTML highlight/formatting tags, normalizing vertical
 * and horizontal whitespace while preserving code tokens, and clamping to
 * `maxChars` with an `"..."` ellipsis when truncated.
 */
export function sanitizeSnippet(
  rawText: string | null | undefined,
  maxChars = DEFAULT_MAX_SNIPPET_CHARS,
): string {
  if (typeof rawText !== "string" || rawText.length === 0 || maxChars <= 0) {
    return "";
  }

  const withoutControlChars = stripControlCharacters(rawText);
  const withoutHighlightTags = withoutControlChars.replace(
    HTML_HIGHLIGHT_TAG_PATTERN,
    "",
  );
  const normalizedNewlines = withoutHighlightTags.replace(/\r\n?/g, "\n");

  const normalizedLines = normalizedNewlines
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  const collapsedWhitespace = normalizedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (collapsedWhitespace.length <= maxChars) {
    return collapsedWhitespace;
  }

  if (maxChars <= 3) {
    return "...".slice(0, maxChars);
  }

  return `${collapsedWhitespace.slice(0, maxChars - 3)}...`;
}

function coerceStringOrArray(
  value: readonly string[] | string | null | undefined,
): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        parts.push(entry.trim());
      }
    }
    return parts.join(" ");
  }
  return "";
}

function extractRawSnippet(item: RawProviderResultInput): string {
  const candidates: string[] = [
    typeof item.snippet === "string" ? item.snippet : "",
    typeof item.content === "string" ? item.content : "",
    typeof item.description === "string" ? item.description : "",
    typeof item.text === "string" ? item.text : "",
    coerceStringOrArray(item.highlights),
    coerceStringOrArray(item.excerpts),
  ];

  for (const candidate of candidates) {
    if (candidate.trim().length > 0) {
      return candidate;
    }
  }

  return "";
}

function normalizePublishedDate(item: RawProviderResultInput): string | null {
  const candidates = [
    item.published_date,
    item.publishedDate,
    item.publish_date,
    item.page_age,
    item.age,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsedTime = Date.parse(trimmed);
    if (!Number.isNaN(parsedTime)) {
      return new Date(parsedTime).toISOString();
    }
  }

  return null;
}

function normalizeScore(
  rawScore: number | string | null | undefined,
): number | null {
  if (rawScore === null || rawScore === undefined) {
    return null;
  }

  const numeric =
    typeof rawScore === "number"
      ? rawScore
      : typeof rawScore === "string" && rawScore.trim().length > 0
        ? Number(rawScore.trim())
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(1, Math.max(0, numeric));
}

/**
 * Normalizes heterogeneous provider result items into canonical
 * `SearchResultItem` objects, deduplicating by canonical URL and merging
 * non-null metadata from duplicate entries.
 */
export function normalizeSearchResults(
  rawItems: readonly RawProviderResultInput[],
  providerId: string,
  options?: NormalizeSearchResultsOptions,
): SearchResultItem[] {
  const maxSnippetChars =
    options?.maxSnippetChars ?? CANONICAL_RESULT_SNIPPET_CHARS;
  const normalizedProvider = providerId.trim();

  const mappedItems: SearchResultItem[] = [];
  const duplicatesByUrl = new Map<string, SearchResultItem[]>();

  for (const rawItem of rawItems) {
    if (typeof rawItem.url !== "string") {
      continue;
    }

    const canonicalUrl = normalizeUrl(rawItem.url);
    if (canonicalUrl === null) {
      continue;
    }

    const trimmedTitle =
      typeof rawItem.title === "string" ? rawItem.title.trim() : "";
    const title = trimmedTitle.length > 0 ? trimmedTitle : canonicalUrl;
    const snippet = sanitizeSnippet(
      extractRawSnippet(rawItem),
      maxSnippetChars,
    );
    const publishedDate = normalizePublishedDate(rawItem);
    const score = normalizeScore(rawItem.score);

    const item: SearchResultItem = {
      title,
      url: canonicalUrl,
      snippet,
      published_date: publishedDate,
      score,
      provider: normalizedProvider,
    };

    mappedItems.push(item);

    const bucket = duplicatesByUrl.get(canonicalUrl);
    if (bucket !== undefined) {
      bucket.push(item);
    } else {
      duplicatesByUrl.set(canonicalUrl, [item]);
    }
  }

  const deduplicated = deduplicateResults(mappedItems);

  return deduplicated.map((primary) => {
    const group = duplicatesByUrl.get(primary.url);
    if (group === undefined || group.length <= 1) {
      return primary;
    }

    let mergedTitle = primary.title;
    let mergedSnippet = primary.snippet;
    let mergedPublishedDate = primary.published_date;
    let mergedScore = primary.score;

    for (const candidate of group) {
      if (mergedTitle === primary.url && candidate.title !== primary.url) {
        mergedTitle = candidate.title;
      }
      if (mergedSnippet.length === 0 && candidate.snippet.length > 0) {
        mergedSnippet = candidate.snippet;
      }
      if (mergedPublishedDate === null && candidate.published_date !== null) {
        mergedPublishedDate = candidate.published_date;
      }
      if (mergedScore === null && candidate.score !== null) {
        mergedScore = candidate.score;
      }
    }

    return {
      title: mergedTitle,
      url: primary.url,
      snippet: mergedSnippet,
      published_date: mergedPublishedDate,
      score: mergedScore,
      provider: primary.provider,
    };
  });
}
