/**
 * Turns whatever was typed in the address bar into something loadable.
 *
 * Deliberately permissive about scheme and strict about everything else: the
 * common case is a dev server typed as `localhost:5173`, which is not a valid
 * URL until it has a scheme, while a genuinely malformed entry should fail
 * quietly rather than navigate somewhere surprising.
 */
export function normalizePreviewUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : // A bare host:port or path is http, not https: dev servers rarely have a
      // certificate, and defaulting to https would fail on every one of them.
      `http://${trimmed.replace(/^\/+/, "")}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.hostname === "") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
