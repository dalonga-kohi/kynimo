// lib is ES2023 without DOM: describe just the Web Crypto call we use (Node 22+, browsers, workers).
type Subtle = { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
const subtle = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;

/** Lowercase hex SHA-256; `fail` builds the error thrown when Web Crypto is missing. */
export async function sha256Hex(
  bytes: Uint8Array,
  fail: (message: string) => Error,
): Promise<string> {
  if (subtle === undefined) throw fail("Web Crypto (crypto.subtle) is unavailable");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
