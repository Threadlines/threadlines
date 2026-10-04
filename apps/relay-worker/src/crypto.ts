// @effect-diagnostics globalDate:off cryptoRandomUUID:off

/** Random URL-safe secret (32 bytes by default). */
export function generateToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Uniform random decimal string of exactly `length` digits (leading zeros kept). */
export function randomDigits(length: number): string {
  let out = "";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  for (const value of bytes) {
    // 4294967296 % 10 = 6, so reject the top sliver to stay uniform.
    let next = value;
    while (next >= 4_294_967_290) {
      const retry = new Uint32Array(1);
      crypto.getRandomValues(retry);
      next = retry[0] ?? 0;
    }
    out += String(next % 10);
  }
  return out;
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Constant-time comparison for equal-length hash strings. */
export function timingSafeEqualString(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
