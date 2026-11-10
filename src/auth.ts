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
