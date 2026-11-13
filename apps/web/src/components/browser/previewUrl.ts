/**
 * Turns whatever was typed in the address bar into something loadable.
 *
 * Deliberately permissive about scheme and strict about everything else: the
 * common case is a dev server typed as `localhost:5173`, which is not a valid
 * URL until it has a scheme, while a genuinely malformed entry should fail
 * quietly rather than navigate somewhere surprising.
 */
/** The site an address belongs to, or "" for anything that names no host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Whether a bare address should default to http rather than https.
 *
 * Local and private destinations rarely have a certificate, and an explicit
 * port is virtually always a dev server. Everything else is the public web,
 * where a normal browser tries https first -- so should we. A genuinely
 * http-only public site is reachable by typing the scheme.
 */
function defaultsToHttp(url: URL): boolean {
  if (url.port !== "") {
    return true;
  }
  const host = url.hostname;
  return (
    // A single-label name (localhost included) never left the local network.
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export function normalizePreviewUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // Parsed as http first because a bare host:port is not a valid URL at all
  // without some scheme; the real default is chosen once the host is known.
  const candidate = hasScheme ? trimmed : `http://${trimmed.replace(/^\/+/, "")}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.hostname === "") {
      return null;
    }
    if (!hasScheme && !defaultsToHttp(url)) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return null;
  }
}
