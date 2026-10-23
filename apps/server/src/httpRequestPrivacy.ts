/**
 * Request paths that carry a credential never reach the server's logs or
 * traces. An event task's address on this computer's port
 * (`/api/hooks/{taskId}/{token}`, docs/design/event-tasks.md) is one: its
 * token is the only sign-in. The HTTP server's own request logger and tracer
 * would record the path of every request, including a CORS preflight the
 * route never sees, so both are handled here, around everything the server
 * answers: such a request is logged with its path cut to `/api/hooks/…`, and
 * never traced.
 *
 * Outside agents' sign-in routes (docs/design/outside-agents.md) carry the
 * client id, `state` and the waiting page's secret in their query strings.
 * The request logger drops a query from the path it records, but a failed
 * request (a method no route takes) is logged with its error, whose message
 * holds the whole URL. So these are handled the same way: logged here
 * without their query or error, and never traced.
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

import { makeRoutePatternMatcher } from "./httpRoutePaths.ts";
import { isOutsideAgentSignInPath } from "./outsideAgents/oauthPaths.ts";
import { LOCAL_HOOK_ROUTE_PREFIX } from "./scheduled/EventTaskHooks.ts";

/** Path prefixes whose remainder is a credential. */
const SECRET_PATH_PREFIXES: ReadonlyArray<string> = [LOCAL_HOOK_ROUTE_PREFIX];

/** The secret prefix a request URL's path falls under, if any. */
const secretPrefixOf = makeRoutePatternMatcher(
  SECRET_PATH_PREFIXES.map((prefix) => [`${prefix}/*`, prefix] as const),
);

/** Whether a request URL's path carries a credential. */
export const hasSecretPath = (url: string): boolean => secretPrefixOf(url) !== undefined;

/** Whether a request URL's path or query carries a credential. */
const carriesCredential = (url: string): boolean =>
  hasSecretPath(url) || isOutsideAgentSignInPath(url);

/** A request URL's path as logs may show it: a credential-carrying one cut to its prefix. */
export const redactedRequestPath = (url: string): string => {
  const prefix = secretPrefixOf(url);
  return prefix !== undefined ? `${prefix}/…` : (url.split(/[?#;]/u, 1)[0] ?? "");
};

/**
 * Wraps everything the server answers (`HttpRouter.serve`'s middleware, so
 * inside its request logger): a request whose path or query carries a
 * credential is left out of that logger, and logged here instead, with the
 * path cut, the query dropped and no error, when `logRequests` (the logger
 * is on).
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
      if (!carriesCredential(request.url)) return yield* httpApp;
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

/**
 * Leaves requests whose path or query carries a credential out of server
 * tracing, whose spans record both.
 */
export const requestTracingPrivacyLayer = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  (request: HttpServerRequest.HttpServerRequest) => carriesCredential(request.url),
);
