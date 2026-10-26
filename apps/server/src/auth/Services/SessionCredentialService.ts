import type {
  AuthClientMetadata,
  AuthClientSession,
  AuthSessionId,
  ServerAuthSessionMethod,
} from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/** `peer`: another computer's server, linked to this one (docs/design/fleet.md). */
export type SessionRole = "owner" | "client" | "peer";
/** The roles a client app's session (and so a pairing credential) can have. */
export type ClientSessionRole = Exclude<SessionRole, "peer">;

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly role: SessionRole;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly role: SessionRole;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export class SessionCredentialError extends Data.TaggedError("SessionCredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SessionCredentialServiceShape {
  readonly cookieName: string;
  readonly issue: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly method?: ServerAuthSessionMethod;
    readonly role?: SessionRole;
    readonly client?: AuthClientMetadata;
  }) => Effect.Effect<IssuedSession, SessionCredentialError>;
  readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly issueWebSocketToken: (
    sessionId: AuthSessionId,
    input?: {
      readonly ttl?: Duration.Duration;
    },
  ) => Effect.Effect<
    {
      readonly token: string;
      readonly expiresAt: DateTime.DateTime;
    },
    SessionCredentialError
  >;
  readonly verifyWebSocketToken: (
    token: string,
  ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    SessionCredentialError
  >;
  readonly streamChanges: Stream.Stream<SessionCredentialChange>;
  /** `streamChanges`, subscribed now: for a reader that lists first, then follows. */
  readonly subscribeChanges: Effect.Effect<
    Stream.Stream<SessionCredentialChange>,
    never,
    Scope.Scope
  >;
  /**
   * Resolves once `sessionId` is no longer usable, and resolves immediately when
   * it is already revoked or unknown.
   *
   * Callers that hold a live connection for a session (the websocket route) need
   * to drop it the instant the owner revokes access. `streamChanges` cannot
   * carry that invariant on its own: `Stream.fromPubSub` subscribes when the
   * stream starts running, so a revocation published between "read the session"
   * and "start consuming" is lost and the connection stays open forever. This
   * subscribes first and only then re-reads the session, so neither ordering
   * drops the signal.
   */
  readonly awaitRevoked: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<void, SessionCredentialError, Scope.Scope>;
  readonly revoke: (sessionId: AuthSessionId) => Effect.Effect<boolean, SessionCredentialError>;
  /**
   * Names a phone, tablet or browser's session (`null`: back to what the
   * device called itself), announced like any other change. False when there
   * is no such live session: revoked, expired, unknown, or a linked computer,
   * which keeps the name it gives itself.
   */
  readonly rename: (
    sessionId: AuthSessionId,
    name: string | null,
  ) => Effect.Effect<boolean, SessionCredentialError>;
  /** The session's device as stored now, a rename included; none once it is revoked. */
  readonly clientOf: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<Option.Option<AuthClientMetadata>, SessionCredentialError>;
  /**
   * Slides a live session's expiry to `ttl` from now (never shortens it).
   * Used for relay devices, which never hold their signed session token, so the
   * stored expiry is the one that counts. Returns whether the session is still
   * usable; a revoked or already-expired session is never revived.
   */
  readonly extendExpiry: (
    sessionId: AuthSessionId,
    ttl: Duration.Duration,
  ) => Effect.Effect<boolean, SessionCredentialError>;
  readonly markConnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
  readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
}

export class SessionCredentialService extends Context.Service<
  SessionCredentialService,
  SessionCredentialServiceShape
>()("threadlines/auth/Services/SessionCredentialService") {}
