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
  FindMyWay,
  HttpMiddleware,
  type HttpServerRequest,
  HttpServerRequest as HttpServerRequestTag,
  type HttpServerResponse,
} from "effect/unstable/http";

import { LOCAL_HOOK_ROUTE_PREFIX } from "./scheduled/EventTaskHooks.ts";

/** Path prefixes whose remainder is a credential. */
const SECRET_PATH_PREFIXES: ReadonlyArray<string> = [LOCAL_HOOK_ROUTE_PREFIX];

/**
 * The router's own matcher, set up as the server's router is (its defaults:
 * any case, duplicate and trailing slashes ignored, escapes decoded, a query
 * after `?`, `;` or `#`), so a path is secret exactly when the router could
 * hand it to a secret route, however it is spelled.
 */
const secretPaths = (() => {
  const router = FindMyWay.make<string>();
  for (const prefix of SECRET_PATH_PREFIXES) {
    router.on("GET", `${prefix}/*` as FindMyWay.PathInput, prefix);
  }
  return router;
})();

/** The secret prefix a request URL's path falls under, if any. */
const secretPrefixOf = (url: string): string | undefined => {
  let target = url;
  // An absolute-form request URL: the router reads its path.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(target)) {
    try {
      const parsed = new URL(target);
      target = `${parsed.pathname}${parsed.search}`;
    } catch {
      // Not a URL after all: read it as a path.
    }
  }
  return secretPaths.find("GET", target)?.handler;
};

/** Whether a request URL's path carries a credential. */
export const hasSecretPath = (url: string): boolean => secretPrefixOf(url) !== undefined;

/** A request URL's path as logs may show it: a credential-carrying one cut to its prefix. */
export const redactedRequestPath = (url: string): string => {
  const prefix = secretPrefixOf(url);
  return prefix !== undefined ? `${prefix}/…` : (url.split(/[?#;]/u, 1)[0] ?? "");
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
