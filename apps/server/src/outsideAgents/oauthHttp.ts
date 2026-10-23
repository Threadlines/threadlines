/**
 * Outside agents' OAuth routes (docs/design/outside-agents.md, "Endpoints"):
 * the server is its own authorization server for `/mcp/connect`.
 *
 * - `GET /.well-known/oauth-protected-resource/mcp/connect` (RFC 9728) and
 *   `GET /.well-known/oauth-authorization-server` (RFC 8414): discovery.
 * - `POST /oauth/register`: stateless DCR (RFC 7591).
 * - `GET /oauth/authorize`: puts the sign-in in front of the user and serves
 *   the waiting page; `GET /oauth/authorize/status`: what the page polls.
 * - `POST /oauth/token`: `authorization_code` with PKCE, once per code.
 *
 * Every route answers only requests from this computer (a loopback socket,
 * no proxy header, a loopback Host on the server's port; 421 otherwise),
 * and refuses what a browser says another site sent (Fetch Metadata). None
 * of them logs a token, code, poll secret or client id.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { requestRemoteAddress } from "../auth/utils.ts";
import { ServerConfig } from "../config.ts";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  AUTHORIZE_STATUS_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
} from "./oauthPaths.ts";
import type { OAuthFailure } from "./oauthRequests.ts";
import {
  OUTSIDE_AGENT_SCOPES,
  outsideAgentOrigin,
  outsideAgentResource,
} from "./OutsideAgentConnections.ts";
import { OutsideAgentSignIn } from "./OutsideAgentSignIn.ts";
import { renderSignInPage, type SignInPageState } from "./signInPage.ts";

/** The origin a request reached this server under, when it came from this computer; else null. */
export const outsideAgentRequestOrigin = (
  request: HttpServerRequest.HttpServerRequest,
  port: number,
): string | null =>
  outsideAgentOrigin({
    host: request.headers.host,
    port,
    remoteAddress: requestRemoteAddress(request),
    headers: request.headers,
  });

/** Nothing here may be cached, sniffed into another type, or leak the URL onward. */
const PRIVATE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const notOnThisComputer = HttpServerResponse.text(
  "Agents can sign in to Threadlines only on this computer, at 127.0.0.1 or localhost on Threadlines' own port.\n",
  { status: 421, headers: PRIVATE_HEADERS },
);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });

const oauthError = (failure: OAuthFailure, status: number, headers: Record<string, string> = {}) =>
  json({ error: failure.error, error_description: failure.description }, status, headers);

const page = (
  state: SignInPageState,
  status: number,
  options: {
    readonly name?: string;
    readonly code?: string;
    readonly statusUrl?: string;
    readonly redirect?: string;
    readonly headers?: Record<string, string>;
  } = {},
) => {
  const rendered = renderSignInPage({
    state,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.statusUrl === undefined ? {} : { status: options.statusUrl }),
    ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
  });
  return HttpServerResponse.text(rendered.html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: {
      ...PRIVATE_HEADERS,
      ...options.headers,
      "content-security-policy": rendered.contentSecurityPolicy,
      "x-frame-options": "DENY",
    },
  });
};

/**
 * A browser's word on who sent a request (`Sec-Fetch-Site`). Agents' own
 * HTTP clients send none. `none` means the user or the OS opened it;
 * `same-origin` is the waiting page itself.
 */
type FetchSite = "none" | "same-origin";

/**
 * Runs a sign-in route for requests from this computer, whose
 * `Sec-Fetch-Site`, when a browser sent one, is in `sites`. `refuse`
 * answers a request another site sent.
 */
const fromThisComputer = <R>(
  sites: ReadonlyArray<FetchSite>,
  refuse: () => HttpServerResponse.HttpServerResponse,
  handle: (input: {
    readonly request: HttpServerRequest.HttpServerRequest;
    readonly origin: string;
  }) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const origin = outsideAgentRequestOrigin(request, config.port);
    if (origin === null) return notOnThisComputer;
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && !(sites as ReadonlyArray<string>).includes(site)) return refuse();
    return yield* handle({ request, origin });
  });

const API_SITES: ReadonlyArray<FetchSite> = ["none", "same-origin"];
const refusedFromWebPage = () =>
  oauthError(
    { error: "invalid_request", description: "Requests from web pages aren't accepted here." },
    403,
  );

const queryOf = (request: HttpServerRequest.HttpServerRequest, origin: string) =>
  new URL(request.url, origin).searchParams;

const protectedResourceMetadataRoute = HttpRouter.add(
  "GET",
  PROTECTED_RESOURCE_METADATA_PATH,
  fromThisComputer(API_SITES, refusedFromWebPage, ({ origin }) =>
    Effect.succeed(
      json({
        resource: outsideAgentResource(origin),
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        scopes_supported: [...OUTSIDE_AGENT_SCOPES],
      }),
    ),
  ),
);

const authorizationServerMetadataRoute = HttpRouter.add(
  "GET",
  AUTHORIZATION_SERVER_METADATA_PATH,
  fromThisComputer(API_SITES, refusedFromWebPage, ({ origin }) =>
    Effect.succeed(
      json({
        issuer: origin,
        authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
        token_endpoint: `${origin}${TOKEN_PATH}`,
        registration_endpoint: `${origin}${REGISTER_PATH}`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...OUTSIDE_AGENT_SCOPES],
        authorization_response_iss_parameter_supported: true,
      }),
    ),
  ),
);

const registerRoute = HttpRouter.add(
  "POST",
  REGISTER_PATH,
  fromThisComputer(API_SITES, refusedFromWebPage, ({ request }) =>
    Effect.gen(function* () {
      const signIn = yield* OutsideAgentSignIn;
      const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
      const result = yield* signIn.register(body);
      switch (result.kind) {
        case "refused":
          return oauthError(result.failure, 400);
        case "limited":
          return oauthError(
            {
              error: "temporarily_unavailable",
              description: "Too many registrations this minute. Try again shortly.",
            },
            429,
            { "retry-after": String(result.retryAfterSeconds) },
          );
        case "registered":
          return json(
            {
              client_id: result.clientId,
              client_id_issued_at: result.issuedAt,
              client_name: result.clientName,
              redirect_uris: result.redirectUris,
              grant_types: ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
              scope: OUTSIDE_AGENT_SCOPES.join(" "),
              ...(result.softwareId === null ? {} : { software_id: result.softwareId }),
            },
            201,
          );
      }
    }),
  ),
);

const authorizeRoute = HttpRouter.add(
  "GET",
  AUTHORIZE_PATH,
  // Only a page the agent or the OS opened: a link or script on a web page
  // can't start a sign-in, whether the user clicked it or not.
  fromThisComputer(
    ["none"],
    () => page("cross-site", 403),
    ({ request, origin }) =>
      Effect.gen(function* () {
        const signIn = yield* OutsideAgentSignIn;
        const result = yield* signIn.beginSignIn({ origin, params: queryOf(request, origin) });
        switch (result.kind) {
          case "invalid":
            return page("invalid", 400);
          case "refused":
            return HttpServerResponse.redirect(result.redirect, { headers: PRIVATE_HEADERS });
          case "quiet":
            return page("quiet", 403, { redirect: result.redirect });
          case "limited":
            return page("limited", 429, {
              redirect: result.redirect,
              headers: { "retry-after": String(result.retryAfterSeconds) },
            });
          case "full":
            return page("full", 429, { redirect: result.redirect });
          case "waiting": {
            const status = new URLSearchParams({
              request: result.requestId,
              poll: result.pollSecret,
              boot: signIn.bootId,
            });
            return page("waiting", 200, {
              name: result.name,
              code: result.code,
              statusUrl: `${AUTHORIZE_STATUS_PATH}?${status.toString()}`,
              redirect: result.restartRedirect,
            });
          }
        }
      }),
  ),
);

const authorizeStatusRoute = HttpRouter.add(
  "GET",
  AUTHORIZE_STATUS_PATH,
  fromThisComputer(API_SITES, refusedFromWebPage, ({ request, origin }) =>
    Effect.gen(function* () {
      const signIn = yield* OutsideAgentSignIn;
      const query = queryOf(request, origin);
      return json(
        yield* signIn.signInStatus({
          requestId: query.get("request") ?? "",
          pollSecret: query.get("poll") ?? "",
          bootId: query.get("boot") ?? "",
        }),
      );
    }),
  ),
);

const tokenRoute = HttpRouter.add(
  "POST",
  TOKEN_PATH,
  fromThisComputer(API_SITES, refusedFromWebPage, ({ request }) =>
    Effect.gen(function* () {
      const signIn = yield* OutsideAgentSignIn;
      const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const result = yield* signIn.exchangeCode(new URLSearchParams(body));
      if (result.kind === "refused") {
        const status =
          result.failure.error === "server_error"
            ? 500
            : result.failure.error === "invalid_client"
              ? 401
              : 400;
        return oauthError(result.failure, status);
      }
      return json({
        access_token: result.accessToken,
        token_type: "Bearer",
        scope: result.scope,
      });
    }),
  ),
);

/** Every sign-in route; needs OutsideAgentSignIn and the server config. */
export const outsideAgentSignInRouteLayer = Layer.mergeAll(
  protectedResourceMetadataRoute,
  authorizationServerMetadataRoute,
  registerRoute,
  authorizeRoute,
  authorizeStatusRoute,
  tokenRoute,
);
