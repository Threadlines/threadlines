/**
 * The rules outside agents' OAuth requests are read by
 * (docs/design/outside-agents.md, "Sign-in"): registration (stateless DCR),
 * the authorization request and the token request. Pure: the sign-in
 * service holds the state, `oauthHttp.ts` the HTTP.
 */
import type { OutsideAgentAccess } from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ClientRegistration } from "./credentials.ts";
import { OUTSIDE_AGENT_SCOPES } from "./OutsideAgentConnections.ts";

/** The OAuth error codes these endpoints answer with (RFC 6749, 7591, 8707). */
export type OAuthErrorCode =
  | "invalid_request"
  | "access_denied"
  | "unsupported_response_type"
  | "invalid_scope"
  | "temporarily_unavailable"
  | "invalid_target"
  | "invalid_grant"
  | "invalid_client"
  | "unsupported_grant_type"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "server_error";

export interface OAuthFailure {
  readonly error: OAuthErrorCode;
  readonly description: string;
}

const failure = (error: OAuthErrorCode, description: string): OAuthFailure => ({
  error,
  description,
});

const MAX_CLIENT_NAME_LENGTH = 60;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const MAX_SOFTWARE_ID_LENGTH = 100;
const MAX_STATE_LENGTH = 1024;
const UNNAMED_CLIENT = "Unnamed agent";
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A name an agent gave, made safe to show: no control or formatting
 * characters (a right-to-left override could make "Claude Code" read as
 * something else), whitespace collapsed, at most `max` characters.
 */
export const displayText = (value: string, max: number): string =>
  Array.from(
    value
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, max)
    .join("")
    .trim();

/**
 * A callback on this computer: `http` to 127.0.0.1, localhost or [::1].
 * Refused: https and other schemes, other hosts, userinfo and fragments.
 */
export const parseLoopbackRedirect = (raw: string): URL | null => {
  if (raw.length > MAX_REDIRECT_URI_LENGTH || raw.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  return url;
};

/**
 * A callback without its port. A registered loopback callback matches any
 * port at authorize time (RFC 8252 §7.3), so a client that kept its
 * registration can sign in again with a fresh listener; everything else
 * (host name, path, query) must match exactly.
 */
export const redirectWithoutPort = (url: URL): string =>
  `${url.protocol}//${url.hostname}${url.pathname}${url.search}`;

/** The callback's port, as the approval dialog shows it. */
export const redirectPort = (url: URL): number => (url.port === "" ? 80 : Number(url.port));

const RegistrationBody = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String),
  software_id: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
});
const decodeRegistrationBody = Schema.decodeUnknownOption(RegistrationBody);

/**
 * A registration request's body (RFC 7591), read into what the client id
 * will carry. The name is trimmed and cut to 60 characters.
 *
 * Only callbacks on this computer are kept: a client may register others
 * too (Cursor's desktop app also registers its web callback), and RFC 7591
 * lets the server register less than was asked, so the answer lists what was
 * kept. A registration with no callback on this computer is refused.
 */
export const readRegistration = (
  body: unknown,
): Omit<ClientRegistration, "registrationId"> | OAuthFailure =>
  Option.match(decodeRegistrationBody(body), {
    onNone: () =>
      failure("invalid_client_metadata", "The registration needs a list of redirect_uris."),
    onSome: (request) => {
      if (request.redirect_uris.length === 0 || request.redirect_uris.length > MAX_REDIRECT_URIS) {
        return failure(
          "invalid_redirect_uri",
          `Register between 1 and ${MAX_REDIRECT_URIS} redirect_uris.`,
        );
      }
      const redirectUris = [
        ...new Set(request.redirect_uris.flatMap((raw) => parseLoopbackRedirect(raw)?.href ?? [])),
      ];
      if (redirectUris.length === 0) {
        return failure(
          "invalid_redirect_uri",
          "Register a callback on this computer: http on 127.0.0.1, localhost or [::1].",
        );
      }
      if (
        request.grant_types !== undefined &&
        !request.grant_types.includes("authorization_code")
      ) {
        return failure(
          "invalid_client_metadata",
          "Only the authorization_code grant is supported.",
        );
      }
      if (request.response_types !== undefined && !request.response_types.includes("code")) {
        return failure("invalid_client_metadata", "Only the code response type is supported.");
      }
      const softwareId =
        request.software_id === undefined
          ? ""
          : displayText(request.software_id, MAX_SOFTWARE_ID_LENGTH);
      return {
        name: displayText(request.client_name ?? "", MAX_CLIENT_NAME_LENGTH) || UNNAMED_CLIENT,
        redirectUris,
        softwareId: softwareId === "" ? null : softwareId,
      };
    },
  });

/** What a sign-in may be granted: `threads:read` alone is See threads only. */
const accessForScopes = (scopes: ReadonlyArray<string>): OutsideAgentAccess =>
  scopes.includes("threads:start") ? "start" : "see";

/** The scope string a grant answers with. Work has no scope of its own: only the user grants it. */
export const scopeForAccess = (access: OutsideAgentAccess): string =>
  access === "see" ? "threads:read" : "threads:read threads:start";

/** An authorization request that passed every check, ready to wait for the user. */
export interface AuthorizeRequest {
  readonly clientId: string;
  readonly client: ClientRegistration;
  /** The exact callback (port included) the answer goes to. */
  readonly redirectUri: string;
  readonly callbackPort: number;
  /** One waiting sign-in per (client, callback without port): a new flow replaces the old. */
  readonly flowKey: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly requestedAccess: OutsideAgentAccess;
}

/**
 * What an authorization request comes to:
 * - `page`: its client or callback didn't check out, so there is nowhere
 *   safe to send the answer; the browser page says so instead;
 * - `redirect`: refused, answered at its callback with `error` (and `state`);
 * - `valid`: every check passed.
 */
export type AuthorizeCheck =
  | { readonly kind: "page" }
  | {
      readonly kind: "redirect";
      readonly redirectUri: string;
      readonly state: string | null;
      readonly failure: OAuthFailure;
    }
  | { readonly kind: "valid"; readonly request: AuthorizeRequest };

/** The one value of a query or form parameter; null when absent or given more than once. */
export const singleParam = (params: URLSearchParams, name: string): string | null => {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
};

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Checks an authorization request in the plan's order: the client id's
 * signature and the callback on its list first (a failure there is shown on
 * the page and never redirects), then `response_type`, `state`, an S256
 * `code_challenge`, `resource` (the canonical one for this origin, when
 * sent) and `scope` (within what this server supports; absent asks for all).
 */
export const checkAuthorizeRequest = (input: {
  readonly params: URLSearchParams;
  readonly resource: string;
  readonly readClientId: (clientId: string) => ClientRegistration | null;
}): AuthorizeCheck => {
  const { params } = input;
  const clientId = singleParam(params, "client_id");
  const client = clientId === null ? null : input.readClientId(clientId);
  const rawRedirect = singleParam(params, "redirect_uri");
  const redirect = rawRedirect === null ? null : parseLoopbackRedirect(rawRedirect);
  if (clientId === null || client === null || redirect === null) return { kind: "page" };
  const key = redirectWithoutPort(redirect);
  const registered = client.redirectUris.some((uri) => {
    const url = parseLoopbackRedirect(uri);
    return url !== null && redirectWithoutPort(url) === key;
  });
  if (!registered) return { kind: "page" };

  const state = singleParam(params, "state");
  const refuse = (error: OAuthErrorCode, description: string): AuthorizeCheck => ({
    kind: "redirect",
    redirectUri: redirect.href,
    state: state !== null && state.length <= MAX_STATE_LENGTH ? state : null,
    failure: failure(error, description),
  });
  if (singleParam(params, "response_type") !== "code") {
    return refuse("unsupported_response_type", "Only response_type=code is supported.");
  }
  if (state === null || state.length === 0 || state.length > MAX_STATE_LENGTH) {
    return refuse("invalid_request", "A state parameter is required.");
  }
  const codeChallenge = singleParam(params, "code_challenge");
  if (singleParam(params, "code_challenge_method") !== "S256" || codeChallenge === null) {
    return refuse("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    return refuse("invalid_request", "The code_challenge isn't an S256 challenge.");
  }
  if (params.has("resource") && singleParam(params, "resource") !== input.resource) {
    return refuse("invalid_target", `The resource must be ${input.resource}.`);
  }
  if (params.getAll("scope").length > 1) {
    return refuse("invalid_scope", "Send scope once.");
  }
  const scopes = (params.get("scope") ?? "").split(" ").filter((scope) => scope.length > 0);
  if (scopes.some((scope) => !(OUTSIDE_AGENT_SCOPES as ReadonlyArray<string>).includes(scope))) {
    return refuse("invalid_scope", `Supported scopes: ${OUTSIDE_AGENT_SCOPES.join(" ")}.`);
  }
  return {
    kind: "valid",
    request: {
      clientId,
      client,
      redirectUri: redirect.href,
      callbackPort: redirectPort(redirect),
      flowKey: `${clientId}\n${key}`,
      state,
      codeChallenge,
      resource: input.resource,
      requestedAccess: scopes.length === 0 ? "start" : accessForScopes(scopes),
    },
  };
};

/** The callback URL with the answer's parameters added. */
export const callbackWith = (
  redirectUri: string,
  params: Record<string, string | null>,
): string => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url.href;
};

/** A token request (RFC 6749 §4.1.3, RFC 7636, RFC 8707), read from its form body. */
export interface TokenRequest {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  /** Null: not sent. */
  readonly resource: string | null;
}

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;

export const readTokenRequest = (params: URLSearchParams): TokenRequest | OAuthFailure => {
  const grantType = singleParam(params, "grant_type");
  if (grantType !== "authorization_code") {
    return grantType === null
      ? failure("invalid_request", "Send grant_type once.")
      : failure("unsupported_grant_type", "Only the authorization_code grant is supported.");
  }
  const code = singleParam(params, "code");
  const clientId = singleParam(params, "client_id");
  const redirectUri = singleParam(params, "redirect_uri");
  const codeVerifier = singleParam(params, "code_verifier");
  if (code === null || clientId === null || redirectUri === null || codeVerifier === null) {
    return failure(
      "invalid_request",
      "Send code, client_id, redirect_uri and code_verifier, each once.",
    );
  }
  if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) {
    return failure("invalid_request", "The code_verifier isn't a PKCE verifier.");
  }
  if (params.getAll("resource").length > 1) {
    return failure("invalid_request", "Send resource once.");
  }
  return { code, clientId, redirectUri, codeVerifier, resource: params.get("resource") };
};

export const isOAuthFailure = (value: object): value is OAuthFailure => "error" in value;
