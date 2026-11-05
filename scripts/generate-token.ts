/**
 * Generates a cryptographically secure 32-byte hex string token.
 *
 * @returns A 64-character lowercase hexadecimal token string.
 */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function main(): void {
  const token = generateToken();
  process.stdout.write(`${token}\n`);
}

const isDirectExecution = process.argv[1]?.endsWith("generate-token.ts");

if (isDirectExecution) {
  main();
}
