/**
 * How an outside agent becomes a connection (docs/design/outside-agents.md,
 * "Sign-in" and "What the user does"). OutsideAgentConnectionsLive
 * implements it, together with OutsideAgentConnections, over one store.
 *
 * - The OAuth side (`oauthHttp.ts`): registration, the authorization request
 *   that waits for the user, the waiting page's status, and the token
 *   exchange that saves the connection.
 * - The owner side (`outsideAgents.*` in ws.ts, owner only): Settings' Agents
 *   group and the approval dialog.
 *
 * Waiting sign-ins, authorization codes, Deny all's quiet period and the
 * rate limits live in memory: a restart cancels them.
 */
import type {
  OutsideAgentApproveInput,
  OutsideAgentConnection,
  OutsideAgentConnectionInput,
  OutsideAgentError,
  OutsideAgentRequestId,
  OutsideAgentRequestInput,
  OutsideAgentsSnapshot,
  OutsideAgentUpdateInput,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OAuthFailure } from "./oauthRequests.ts";

/** A registration's answer: the client id, or why not. */
export type RegisterResult =
  | {
      readonly kind: "registered";
      readonly clientId: string;
      readonly clientName: string;
      readonly redirectUris: ReadonlyArray<string>;
      readonly softwareId: string | null;
      readonly issuedAt: number;
    }
  | { readonly kind: "refused"; readonly failure: OAuthFailure }
  | { readonly kind: "limited"; readonly retryAfterSeconds: number };

/**
 * An authorization request's answer, in the plan's order:
 * - `invalid`: its client or callback didn't check out (shown on the page,
 *   never redirected);
 * - `refused`: answered at its callback with `error`, `state` and `iss`;
 * - `quiet`: Deny all's quiet period is on;
 * - `limited`: too many sign-ins this minute;
 * - `full`: too many already waiting;
 * - `waiting`: it now waits for the user, with its code and the page's poll
 *   secret.
 * `quiet`, `limited` and `full` carry the `access_denied` /
 * `temporarily_unavailable` answer for the page to hand back to the agent.
 */
export type BeginSignInResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "refused"; readonly redirect: string }
  | { readonly kind: "quiet"; readonly redirect: string }
  | { readonly kind: "limited"; readonly redirect: string; readonly retryAfterSeconds: number }
  | { readonly kind: "full"; readonly redirect: string }
  | {
      readonly kind: "waiting";
      readonly requestId: OutsideAgentRequestId;
      readonly pollSecret: string;
      readonly code: string;
      readonly name: string;
      /** The answer the page hands back if the server restarts while it waits. */
      readonly restartRedirect: string;
    };

/**
 * What the waiting page sees when it polls:
 * - `waiting`;
 * - `approved`: the callback with `code`, `state` and `iss`;
 * - `denied` / `expired`: the callback with `access_denied`, `state` and `iss`;
 * - `replaced`: a newer sign-in from the same agent took over (nothing to
 *   hand back: the agent already moved on);
 * - `restarted`: the server doesn't know the request and isn't the one that
 *   took it;
 * - `gone`: the server doesn't know the request (or the secret is wrong).
 */
export type SignInStatus =
  | { readonly state: "waiting" }
  | {
      readonly state: "approved" | "denied" | "expired";
      readonly redirect: string;
    }
  | { readonly state: "replaced" | "restarted" | "gone" };

export type TokenResult =
  | {
      readonly kind: "issued";
      readonly accessToken: string;
      readonly scope: string;
    }
  | { readonly kind: "refused"; readonly failure: OAuthFailure };

export interface OutsideAgentSignInShape {
  /**
   * Stateless DCR (RFC 7591), 20 a minute: the client id is the signed
   * registration. Takes a slot in the rate limit before it reads `body`.
   */
  readonly register: <E>(body: Effect.Effect<unknown, E>) => Effect.Effect<RegisterResult, E>;
  /**
   * Checks an authorization request that arrived at `origin` (already known
   * to be this computer), and when it passes, puts it in front of the user.
   */
  readonly beginSignIn: (input: {
    readonly origin: string;
    readonly params: URLSearchParams;
  }) => Effect.Effect<BeginSignInResult>;
  readonly signInStatus: (input: {
    readonly requestId: string;
    readonly pollSecret: string;
    /** The process the page was served by (`bootId`). */
    readonly bootId: string;
  }) => Effect.Effect<SignInStatus>;
  /** Exchanges an approved sign-in's code for the connection's access token. */
  readonly exchangeCode: (params: URLSearchParams) => Effect.Effect<TokenResult>;
  /** This process, as the waiting page knows it: a different one after a restart. */
  readonly bootId: string;

  /** The Agents group now, then again on every change. */
  readonly changes: Stream.Stream<OutsideAgentsSnapshot, OutsideAgentError>;
  /**
   * Allows a waiting sign-in with what the user picked (at most what it
   * asked for). The connection is saved when the agent exchanges its code;
   * this returns it as it will be.
   */
  readonly approve: (
    input: OutsideAgentApproveInput,
  ) => Effect.Effect<OutsideAgentConnection, OutsideAgentError>;
  readonly deny: (input: OutsideAgentRequestInput) => Effect.Effect<void, OutsideAgentError>;
  /** Denies everything waiting and turns new sign-ins away for 10 minutes. */
  readonly denyAll: Effect.Effect<void, OutsideAgentError>;
  /** Ends Deny all's quiet period early. */
  readonly resumeRequests: Effect.Effect<void, OutsideAgentError>;
  /** Changes a connection's grant; its next call is checked against it. */
  readonly update: (
    input: OutsideAgentUpdateInput,
  ) => Effect.Effect<OutsideAgentConnection, OutsideAgentError>;
  /** Removes a connection: its next call is refused. */
  readonly remove: (input: OutsideAgentConnectionInput) => Effect.Effect<void, OutsideAgentError>;
}

export class OutsideAgentSignIn extends Context.Service<
  OutsideAgentSignIn,
  OutsideAgentSignInShape
>()("threadlines/outsideAgents/OutsideAgentSignIn") {}
