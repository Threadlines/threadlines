import * as Effect from "effect/Effect";
import { HttpMiddleware, HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

import { isOutsideAgentSignInPath } from "./outsideAgents/oauthPaths.ts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
] as const;

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;

const allowAnyOrigin = HttpMiddleware.cors({
  allowedMethods: [...browserApiCorsAllowedMethods],
  allowedHeaders: [...browserApiCorsAllowedHeaders],
  maxAge: 600,
});

/**
 * The browser API's CORS (any origin; the routes check their own
 * credentials), for every route but outside agents' sign-in
 * (docs/design/outside-agents.md): those are for agents and the page an
 * agent opens on this computer, never for another site's scripts, so they
 * get no CORS headers and no preflight answer.
 */
export const browserApiCors = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> => {
  const withCors = allowAnyOrigin(httpApp);
  return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isOutsideAgentSignInPath(request.url) ? httpApp : withCors,
  );
};
