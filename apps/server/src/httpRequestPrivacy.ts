/**
 * Request paths that carry a credential never reach the server's logs or
 * traces. An event task's address on this computer's port
 * (`/api/hooks/{taskId}/{token}`, docs/design/event-tasks.md) is one: its
 * token is the only sign-in. The HTTP server's own request logger and tracer
 * would record the path of every request, including a CORS preflight the
 * route never sees, so both are handled here, around everything the server
 * answers: such a request is logged with its path cut to `/api/hooks/…`, and
 * never traced.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  HttpMiddleware,
  type HttpServerRequest,
  HttpServerRequest as HttpServerRequestTag,
  type HttpServerResponse,
} from "effect/unstable/http";

import { LOCAL_HOOK_ROUTE_PREFIX } from "./scheduled/EventTaskHooks.ts";

/** Path prefixes whose remainder is a credential. */
const SECRET_PATH_PREFIXES: ReadonlyArray<string> = [`${LOCAL_HOOK_ROUTE_PREFIX}/`];

/**
 * A request's path as routing sees it: without query or fragment, from an
 * absolute-form URL too, percent-escapes decoded where they decode.
 */
const requestPath = (url: string): string => {
  let path = url;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      // Not a URL after all: read it as a path.
    }
  }
  path = path.split(/[?#]/u, 1)[0] ?? "";
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

/** Whether a request URL's path carries a credential. */
export const hasSecretPath = (url: string): boolean => {
  const path = requestPath(url);
  return SECRET_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
};

/** A request URL's path as logs may show it: a credential-carrying one cut to its prefix. */
export const redactedRequestPath = (url: string): string => {
  const path = requestPath(url);
  const prefix = SECRET_PATH_PREFIXES.find((candidate) => path.startsWith(candidate));
  return prefix === undefined ? path : `${prefix}…`;
};

/**
 * Wraps everything the server answers (`HttpRouter.serve`'s middleware, so
 * inside its request logger): a request whose path carries a credential is
 * left out of that logger, and logged here instead, with the path cut,
 * when `logRequests` (the logger is on).
 */
export const requestPrivacy =
  (logRequests: boolean) =>
  <E, R>(
    httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequestTag.HttpServerRequest;
      if (!hasSecretPath(request.url)) return yield* httpApp;
      const exit = yield* httpApp.pipe(HttpMiddleware.withLoggerDisabled, Effect.exit);
      if (logRequests) {
        yield* Effect.log("Sent HTTP response").pipe(
          Effect.annotateLogs({
            "http.method": request.method,
            "http.url": redactedRequestPath(request.url),
            ...(Exit.isSuccess(exit) ? { "http.status": exit.value.status } : {}),
          }),
        );
      }
      return yield* exit;
    });

/** Leaves requests whose path carries a credential out of server tracing, whose spans record it. */
export const requestTracingPrivacyLayer = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  (request: HttpServerRequest.HttpServerRequest) => hasSecretPath(request.url),
);
