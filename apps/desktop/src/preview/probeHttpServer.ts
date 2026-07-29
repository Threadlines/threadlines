/**
 * Decides whether a listening port is something you could actually open.
 *
 * A machine has many listeners that are not web servers: Handoff daemons,
 * AirPlay receivers, database sockets, an app's own internal ports. Listing
 * them all makes the useful entries hard to find, so each candidate is asked
 * for a page and kept only if it serves one.
 *
 * Measured against a real machine: a dev server answers 200 text/html, AirPlay
 * answers 403 with no content type, and a Handoff daemon does not speak HTTP at
 * all. Serving HTML is the line that separates them.
 */

import { get, type IncomingMessage } from "node:http";

const PROBE_TIMEOUT_MS = 800;
/** Enough for <head>; a title after this is not worth holding a socket open for. */
const MAX_TITLE_BYTES = 16_000;
const MAX_REDIRECTS = 2;

/**
 * A page's title, for labelling. Titles are far more useful than process names:
 * three dev servers all called "node" are indistinguishable, while their titles
 * are exactly what the user is looking for.
 */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html);
  if (match?.[1] === undefined) {
    return null;
  }
  const title = match[1].replace(/\s+/g, " ").trim();
  return title === "" ? null : title;
}

export function isHtmlContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.toLowerCase().includes("text/html");
}

export interface HttpProbeResult {
  title: string | null;
}

/**
 * Resolves null for anything that is not an HTML-serving HTTP endpoint.
 *
 * The host must be the loopback address the listener is bound to: a server on
 * ::1 refuses 127.0.0.1, and vice versa.
 */
export function probeHttpServer(
  port: number,
  host: string,
  redirectsLeft = MAX_REDIRECTS,
): Promise<HttpProbeResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpProbeResult | null) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const request = get(
      { host, port, path: "/", timeout: PROBE_TIMEOUT_MS },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location !== undefined && redirectsLeft > 0) {
          // A dev server redirecting to its app shell is still a web server;
          // the page that matters is the one it points at.
          response.resume();
          const target = /^https?:\/\//i.test(location) ? null : location;
          if (target === null) {
            finish(null);
            return;
          }
          void probeHttpServer(port, host, redirectsLeft - 1).then(finish);
          return;
        }
        if (status >= 400 || !isHtmlContentType(response.headers["content-type"])) {
          response.resume();
          finish(null);
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length >= MAX_TITLE_BYTES) {
            response.destroy();
            finish({ title: extractHtmlTitle(body) });
          }
        });
        response.on("end", () => finish({ title: extractHtmlTitle(body) }));
        response.on("error", () => finish(null));
      },
    );

    request.on("timeout", () => {
      request.destroy();
      finish(null);
    });
    request.on("error", () => finish(null));
  });
}
