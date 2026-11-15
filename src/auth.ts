// Hash both inputs to equal-size buffers so Workers' native comparator accepts
// different token lengths. This avoids content-dependent string comparisons;
// hashing time can still depend on input length.
export async function constantTimeTokenEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

/**
 * Parses a comma-separated gateway token configuration into distinct non-empty tokens.
 *
 * @param raw - Raw environment secret string.
 * @returns Deduplicated array of trimmed, non-empty tokens.
 */
export function parseGatewayTokens(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

/**
 * Compares a candidate token against all configured tokens using constant-time digests.
 *
 * @param token - Caller-supplied credential.
 * @param configuredTokens - Allowed gateway tokens.
 * @returns True if the candidate matches any configured token.
 */
export async function matchesAnyGatewayToken(
  token: string,
  configuredTokens: readonly string[],
): Promise<boolean> {
  if (configuredTokens.length === 0) {
    return false;
  }
  // Evaluate every configured candidate without short-circuiting so response
  // timing does not depend on which slot matched.
  const results = await Promise.all(
    configuredTokens.map((candidate) =>
      constantTimeTokenEqual(token, candidate),
    ),
  );
  return results.some(Boolean);
}
