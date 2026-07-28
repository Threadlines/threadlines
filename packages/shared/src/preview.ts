/**
 * The browser session the in-app preview runs in.
 *
 * Shared because both ends have to agree: the renderer sets it as the
 * <webview>'s partition attribute, and the main process refuses to attach a
 * webview asking for anything else. Preview content is untrusted and has no
 * business sharing cookies with Threadlines itself.
 */
export const PREVIEW_PARTITION = "persist:threadlines-preview";

/**
 * Where an agent may take the browser without asking.
 *
 * Two ends enforce this and they must agree exactly: the renderer refuses an
 * agent's `navigate` before it happens, and the main process blocks the page's
 * own navigations after the fact. Two copies of "is this host allowed" would
 * eventually disagree, and the half that said yes would be the one that mattered.
 *
 * Everything here is pure and case-insensitive, and hostnames arrive in every
 * shape a URL can produce: `URL.hostname` keeps the brackets on an IPv6
 * literal, and users type capitals.
 */

/** `[::1]` and `::1` are the same host; so are `EXAMPLE.com` and `example.com`. */
function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function parseIpv4Octets(hostname: string): readonly [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * The leading 16 bits of an IPv6 literal, which is all the ranges below need.
 *
 * Null for anything that is not plainly an IPv6 address written out, including
 * the `::`-compressed forms that start with the separator: those cannot be in
 * fe80::/10 or fc00::/7 anyway, since both ranges have a non-zero first hextet.
 */
function firstIpv6Hextet(hostname: string): number | null {
  const head = hostname.split(":")[0] ?? "";
  return /^[0-9a-f]{1,4}$/.test(head) ? Number.parseInt(head, 16) : null;
}

/**
 * Whether a host is somewhere only this machine or this network can reach.
 *
 * These are the addresses the browser panel exists for -- a dev server, a
 * device on the LAN, a tailnet peer -- and asking permission to look at your
 * own localhost would make the guardrail noise rather than a guardrail.
 *
 * Deliberately conservative: anything not recognised here is treated as public
 * and needs approval. A false "public" costs one click; a false "private" is a
 * hole.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "") {
    return false;
  }
  if (host === "localhost") {
    return true;
  }
  // mDNS names and tailnet names are LAN identity, not the public internet.
  if (host.endsWith(".local") || host.endsWith(".ts.net")) {
    return true;
  }

  const octets = parseIpv4Octets(host);
  if (octets !== null) {
    const [first, second] = octets;
    // "This host": dev servers print 0.0.0.0 as their address and browsers
    // resolve it to the local machine, so it can never name a public site.
    if (first === 0) return true;
    if (first === 127) return true; // loopback
    if (first === 10) return true; // RFC 1918
    if (first === 172 && second >= 16 && second <= 31) return true; // RFC 1918
    if (first === 192 && second === 168) return true; // RFC 1918
    if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT
    if (first === 169 && second === 254) return true; // link-local
    return false;
  }

  if (!host.includes(":")) {
    return false;
  }
  // Loopback, written either way round.
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const hextet = firstIpv6Hextet(host);
  if (hextet === null) {
    return false;
  }
  if (hextet >= 0xfe80 && hextet <= 0xfebf) return true; // link-local
  if (hextet >= 0xfc00 && hextet <= 0xfdff) return true; // unique local
  return false;
}

/**
 * The form a host is remembered in once approved.
 *
 * Approval is deliberately exact-host, with one exception below. Allowing
 * arbitrary subdomains without a public-suffix-aware parser can turn an
 * approval for a tenant host such as `www.github.io` into approval for every
 * `*.github.io` site.
 */
export function browserApprovalKey(hostname: string): string {
  return normalizeHostname(hostname);
}

/**
 * Whether `www.example.com` and `example.com` are the same site, which on the
 * public web they are: most sites answer on one and redirect the other to it,
 * so approving one and prompting for the other reads as asking twice.
 *
 * Only the single fixed `www.` label, and only when the bare side has a dot of
 * its own -- so `www.example.com` never covers a lone label like `com`, and
 * nothing here covers arbitrary subdomains. The tenant concern above does not
 * apply: `www.github.io` <-> `github.io` grants the suffix's own apex, not any
 * other tenant.
 */
function isSameSiteWww(left: string, right: string): boolean {
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left];
  return longer === `www.${shorter}` && shorter.includes(".");
}

/**
 * Whether the browser may go to this host for this project.
 *
 * Exact-host by design, plus the `www.` equivalence above. A broader host
 * suffix is not necessarily one site: `github.io` and many other public
 * suffixes contain unrelated tenants.
 */
export function isBrowserHostApproved(hostname: string, approved: ReadonlyArray<string>): boolean {
  if (isPrivateNetworkHost(hostname)) {
    return true;
  }
  const key = browserApprovalKey(hostname);
  if (key === "") {
    return false;
  }
  return approved.some((entry) => {
    const approvedKey = browserApprovalKey(entry);
    return approvedKey !== "" && (key === approvedKey || isSameSiteWww(key, approvedKey));
  });
}

/**
 * The approval list with this host added, or the same list if it changes nothing.
 *
 * Returned unchanged rather than rebuilt so a redundant approval -- the user
 * typing a localhost address, or revisiting a site already allowed -- does not
 * write settings and does not grow the list.
 */
export function withBrowserApproval(
  approved: ReadonlyArray<string>,
  hostname: string,
): ReadonlyArray<string> {
  const key = browserApprovalKey(hostname);
  if (key === "" || isBrowserHostApproved(hostname, approved)) {
    return approved;
  }
  return [...approved, key];
}
