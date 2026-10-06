// @effect-diagnostics nodeBuiltinImport:off - one GET over node:https
/**
 * HttpsFetch — the `fetch` behind downloads of programs Threadlines installs.
 *
 * It differs from the global `fetch` where a download needs it to:
 * - it goes through the proxy the environment names (`HTTPS_PROXY`,
 *   `NO_PROXY`), using Node's own proxy support; the global `fetch` only
 *   does when the whole server was started for it. Extra certificate
 *   authorities (`NODE_EXTRA_CA_CERTS`) apply to both;
 * - it follows redirects itself, so every hop is https and there are at
 *   most five;
 * - it can be held to the public internet (`publicAddressesOnly`) and to
 *   named hosts (`allowedHosts`), on every hop, for addresses that come
 *   from a list Threadlines doesn't write.
 *
 * @module provider/managedRuntime/HttpsFetch
 */
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { Readable } from "node:stream";

import type { DownloadFetch } from "./VerifiedDownload.ts";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Statuses a `Response` may not carry a body for. */
const BODILESS_STATUSES = new Set([204, 205, 304]);

export interface HttpsFetchOptions {
  /** Where proxy settings are read from. Default: the server's environment. */
  readonly proxyEnv?: NodeJS.ProcessEnv;
  /** Test seam: also allow plain http, for a server on this machine. */
  readonly allowHttp?: boolean;
  /**
   * Only ever connect to the public internet. A URL whose host is an IP
   * address is refused, and so is a name when any address it resolves to is
   * this machine or a private network (see `isPublicAddress`).
   *
   * Through a proxy the proxy resolves the name, so only the first rule
   * applies there: a proxy the environment configures is trusted.
   */
  readonly publicAddressesOnly?: boolean;
  /** Refuse every host but these, by exact name. */
  readonly allowedHosts?: ReadonlyArray<string>;
}

/**
 * Where no public server lives: this machine, private networks, and
 * addresses that don't name one host. 198.18.0.0/15 is left out on purpose:
 * VPN and proxy apps answer with it as a stand-in for public names.
 */
const NON_PUBLIC_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network", the unspecified address included
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared by carriers (CGNAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.168.0.0", 16], // private
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast included
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, and IPv4 addresses in their retired IPv6 form
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether `address`, an IPv4 or IPv6 address as text, is on the public
 * internet. An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is judged
 * as the IPv4 address it is. False for anything that isn't an address.
 */
export function isPublicAddress(address: string): boolean {
  // A scoped address (`fe80::1%en0`) is the address before the `%`.
  const bare = address.split("%", 1)[0] ?? "";
  const family = net.isIP(bare);
  if (family === 0) return false;
  return !NON_PUBLIC_ADDRESSES.check(bare, family === 4 ? "ipv4" : "ipv6");
}

/** Whether a URL's `hostname` is an IP address rather than a name. */
export function isIpAddressHostname(hostname: string): boolean {
  // `URL` keeps the brackets of an IPv6 host and rewrites every IPv4
  // spelling (`0x7f.1`, `2130706433`) to four decimal parts.
  return hostname.startsWith("[") || net.isIP(hostname) !== 0;
}

/** `dns.lookup`, asked for every address of a name. */
type ResolveAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: Array<dns.LookupAddress>) => void,
) => void;

/**
 * The `lookup` of a connection that may only reach the public internet: it
 * refuses a name when any of its addresses isn't public. The name is
 * resolved once, here, and the connection is made to what this answers, so
 * a name can't pass the check and then connect somewhere else. Node never
 * asks it about a proxy, nor about a host given as an address.
 *
 * `resolveAll` is a test seam. Default: `dns.lookup`.
 */
export function publicAddressLookup(resolveAll: ResolveAll = dns.lookup): net.LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const [first] = addresses;
      const inside = addresses.find((entry) => !isPublicAddress(entry.address));
      if (first === undefined || inside !== undefined) {
        callback(
          new Error(
            inside
              ? `Refusing to download from ${hostname}: it resolves to ${inside.address}, which is not on the public internet.`
              : `Refusing to download from ${hostname}: it has no address.`,
          ),
          [],
        );
        return;
      }
      // Node asks for all of them, to try each in turn, or for one.
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

function toResponse(message: http.IncomingMessage): Response {
  const status = message.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, item);
    }
  }
  if (BODILESS_STATUSES.has(status)) {
    message.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, { status, headers });
}

/** Builds a `fetch` for GETs. Rejects for anything but https, and for a URL that carries credentials. */
export function makeHttpsFetch(options: HttpsFetchOptions = {}): DownloadFetch {
  const proxyEnv = options.proxyEnv ?? process.env;
  const httpsAgent = new https.Agent({ proxyEnv });
  const httpAgent = new http.Agent({ proxyEnv });
  const allowedHosts = options.allowedHosts
    ? new Set(options.allowedHosts.map((host) => host.toLowerCase()))
    : undefined;
  const lookup = options.publicAddressesOnly ? publicAddressLookup() : undefined;

  const get = (url: URL, init: RequestInit) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const requestOptions = {
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(lookup ? { lookup } : {}),
      };
      const request =
        url.protocol === "https:"
          ? https.get(url, { ...requestOptions, agent: httpsAgent }, resolve)
          : http.get(url, { ...requestOptions, agent: httpAgent }, resolve);
      request.on("error", reject);
      // Neither of these is a response, and without them the promise would
      // never settle: a server that switches protocols, and a connection
      // that ends first.
      request.on("upgrade", (_message, socket) => {
        socket.destroy();
        reject(new Error(`${url.host} answered with a protocol switch instead of the file.`));
      });
      request.on("close", () => {
        reject(new Error(`The connection to ${url.host} closed before it answered.`));
      });
    });

  return async (rawUrl, init) => {
    let url = new URL(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
      if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
        throw new Error(`Refusing to download from ${url.origin}: only https is allowed.`);
      }
      if (url.username !== "" || url.password !== "") {
        throw new Error(`Refusing to download from ${url.host}: the address carries a sign-in.`);
      }
      if (allowedHosts && !allowedHosts.has(url.hostname)) {
        throw new Error(
          `Refusing to download from ${url.host}: only ${[...allowedHosts].join(", ")} is allowed.`,
        );
      }
      if (options.publicAddressesOnly && isIpAddressHostname(url.hostname)) {
        throw new Error(
          `Refusing to download from ${url.host}: the address is an IP address, not a name.`,
        );
      }
      const message = await get(url, init);
      const location = message.headers.location;
      if (!REDIRECT_STATUSES.has(message.statusCode ?? 0) || location === undefined) {
        return toResponse(message);
      }
      message.resume();
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Gave up on ${rawUrl} after ${MAX_REDIRECTS} redirects.`);
      }
      url = new URL(location, url);
    }
  };
}
