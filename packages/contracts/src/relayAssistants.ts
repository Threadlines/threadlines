import * as Schema from "effect/Schema";

import { IsoDateTime, OutsideAgentConnectionId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Assistants (docs/design/assistants.md): always-on agents in their makers'
 * clouds (Grok Bot, dots, Muse, Claude Duet) reach a user's computer through
 * the relay's public door. These are the shapes between the relay and the
 * computer. Credentials and sign-in codes are formatted in
 * `@threadlines/shared/assistantCredentials`.
 *
 * Host-secret routes, under `/v2/hosts/{hostId}/assistants`:
 *
 *   GET    /                  RelayAssistantInfo: the public address, and whether the door is on
 *   POST   /code              RelayAssistantCodeResult: a new sign-in code (replaces this computer's last one)
 *   DELETE /code              forget this computer's code
 *   POST   /route-tags        RelayAssistantRouteTagRequest -> RelayAssistantRouteTagResult
 *   POST   /revocations       RelayAssistantRevokeRequest: removed connections, refused from now on
 *   GET    /socket            WebSocket (host secret as the token protocol): the assistant socket
 *
 * On the assistant socket, the relay sends RelayAssistantRelayFrame and the
 * computer answers with RelayAssistantHostFrame, all as JSON text frames.
 */

/** OAuth scopes an assistant may ask for. `threads:read` maps to See, `threads:start` to Start. */
export const AssistantScope = Schema.Literals(["threads:read", "threads:start"]);
export type AssistantScope = typeof AssistantScope.Type;

/** Path of the MCP endpoint on the assistants origin; the resource is `<origin>/mcp`. */
export const ASSISTANT_MCP_PATH = "/mcp";
/** A frame either way, serialized: our own limit (Cloudflare allows 32 MiB). */
export const RELAY_ASSISTANT_FRAME_MAX_BYTES = 768 * 1024;
/** How long the relay holds an assistant's request for the computer's answer. */
export const RELAY_ASSISTANT_REQUEST_TIMEOUT_MS = 30_000;
/** Requests in flight per computer; more get 503 at the relay. */
export const RELAY_ASSISTANT_MAX_IN_FLIGHT = 32;
/** A sign-in code's life, and a pending sign-in's. */
export const ASSISTANT_SIGN_IN_TTL_MS = 10 * 60_000;
/** Tries a pending sign-in's page gets at typing a code. */
export const ASSISTANT_SIGN_IN_CODE_TRIES = 3;
/** An access token's life. */
export const ASSISTANT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** An authorization code's life on the computer. */
export const ASSISTANT_AUTHORIZATION_CODE_TTL_MS = 60_000;
/** The longest `thread_wait` an assistant gets, under the relay's request timeout. */
export const ASSISTANT_THREAD_WAIT_MAX_SECONDS = 25;

export const RelayAssistantInfo = Schema.Struct({
  /** `<origin>/mcp`: what the user pastes into an assistant. */
  address: TrimmedNonEmptyString,
  /** False while the relay's kill switch is on. */
  enabled: Schema.Boolean,
});
export type RelayAssistantInfo = typeof RelayAssistantInfo.Type;

export const RelayAssistantCodeResult = Schema.Struct({
  /** 8 characters, no separator; the app shows it as `K4D8-2PQX`. */
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type RelayAssistantCodeResult = typeof RelayAssistantCodeResult.Type;

export const RelayAssistantRouteTagRequest = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
});
export type RelayAssistantRouteTagRequest = typeof RelayAssistantRouteTagRequest.Type;

export const RelayAssistantRouteTagResult = Schema.Struct({
  routeTag: TrimmedNonEmptyString,
});
export type RelayAssistantRouteTagResult = typeof RelayAssistantRouteTagResult.Type;

export const RelayAssistantRevokeRequest = Schema.Struct({
  connectionIds: Schema.Array(OutsideAgentConnectionId).check(Schema.isMaxLength(100)),
});
export type RelayAssistantRevokeRequest = typeof RelayAssistantRevokeRequest.Type;

/**
 * Who is signing in, as far as the relay could tell.
 * - `cimd`: the client id is an https URL whose metadata document the relay
 *   fetched; `host` is that URL's host, and it is verified.
 * - `registered`: a client that registered itself (stateless DCR); its name
 *   is its own claim, and `host` is its redirect URI's host.
 */
export const RelayAssistantClientIdentity = Schema.Struct({
  kind: Schema.Literals(["cimd", "registered"]),
  host: TrimmedNonEmptyString,
  /** On the relay's short list of known assistants: a hint for the dialog, never a gate. */
  known: Schema.Boolean,
});
export type RelayAssistantClientIdentity = typeof RelayAssistantClientIdentity.Type;

/** Roughly where the sign-in page was opened, from Cloudflare's request data. Information only. */
export const RelayAssistantPlace = Schema.Struct({
  city: Schema.optionalKey(TrimmedNonEmptyString),
  country: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayAssistantPlace = typeof RelayAssistantPlace.Type;

/** A sign-in whose page typed this computer's code: the approval dialog's facts. */
export const RelayAssistantSignIn = Schema.Struct({
  signInId: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  clientName: TrimmedNonEmptyString,
  identity: RelayAssistantClientIdentity,
  redirectUri: TrimmedNonEmptyString,
  /** What it asked for; approval can't grant more. */
  scopes: Schema.Array(AssistantScope),
  /** PKCE S256 challenge, checked by the computer at the token exchange. */
  codeChallenge: TrimmedNonEmptyString,
  /** The canonical resource, `<origin>/mcp`; tokens are bound to it. */
  resource: TrimmedNonEmptyString,
  /** The assistants origin, sent back as `iss` with the code. */
  issuer: TrimmedNonEmptyString,
  place: Schema.NullOr(RelayAssistantPlace),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type RelayAssistantSignIn = typeof RelayAssistantSignIn.Type;

/** Relay -> computer: an assistant's request, for the computer to answer. */
export const RelayAssistantRequestFrame = Schema.Struct({
  type: Schema.Literal("request"),
  id: TrimmedNonEmptyString,
  /** `mcp`: a POST to `/mcp`. `token`: a POST to `/token`, its form body as sent. */
  route: Schema.Literals(["mcp", "token"]),
  /**
   * The credential the relay routed by: the bearer for `mcp`, the code or
   * refresh token for `token`. The computer authenticates it; it's never logged.
   */
  credential: TrimmedNonEmptyString,
  resource: TrimmedNonEmptyString,
  /**
   * Only `content-type`, `mcp-protocol-version`, `mcp-method`, `mcp-name` and
   * `mcp-session-id`, names lowercased.
   */
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
export type RelayAssistantRequestFrame = typeof RelayAssistantRequestFrame.Type;

/** Relay -> computer: a page typed this computer's code. Sent again after a reconnect while it waits. */
export const RelayAssistantSignInFrame = Schema.Struct({
  type: Schema.Literal("signin"),
  signIn: RelayAssistantSignIn,
});

/** Relay -> computer: a sign-in it was shown is over without a decision. */
export const RelayAssistantSignInGoneFrame = Schema.Struct({
  type: Schema.Literal("signin.gone"),
  signInId: TrimmedNonEmptyString,
  reason: Schema.Literals(["expired", "cancelled"]),
});

export const RelayAssistantRelayFrame = Schema.Union([
  RelayAssistantRequestFrame,
  RelayAssistantSignInFrame,
  RelayAssistantSignInGoneFrame,
]);
export type RelayAssistantRelayFrame = typeof RelayAssistantRelayFrame.Type;

/** Computer -> relay: the answer to a request frame, passed on as the HTTP response. */
export const RelayAssistantResponseFrame = Schema.Struct({
  type: Schema.Literal("response"),
  id: TrimmedNonEmptyString,
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
export type RelayAssistantResponseFrame = typeof RelayAssistantResponseFrame.Type;

/** Computer -> relay: the user's decision on a sign-in. Allow carries the authorization code. */
export const RelayAssistantDecisionFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("signin.decision"),
    signInId: TrimmedNonEmptyString,
    decision: Schema.Literal("allow"),
    authorizationCode: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("signin.decision"),
    signInId: TrimmedNonEmptyString,
    decision: Schema.Literal("deny"),
  }),
]);
export type RelayAssistantDecisionFrame = typeof RelayAssistantDecisionFrame.Type;

export const RelayAssistantHostFrame = Schema.Union([
  RelayAssistantResponseFrame,
  RelayAssistantDecisionFrame,
]);
export type RelayAssistantHostFrame = typeof RelayAssistantHostFrame.Type;
