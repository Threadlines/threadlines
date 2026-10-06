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
 *   most five.
 *
 * @module provider/managedRuntime/HttpsFetch
 */
import * as http from "node:http";
import * as https from "node:https";
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

  const get = (url: URL, init: RequestInit) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const requestOptions = {
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(init.signal ? { signal: init.signal } : {}),
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
