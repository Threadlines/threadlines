import type {
  AuthBearerBootstrapResult,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingLink,
  AuthPairingCredentialResult,
  AuthSessionId,
  AuthSessionState,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  AuthWebSocketTokenResult,
} from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { ClientSessionRole, SessionRole } from "./SessionCredentialService.ts";

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly role: SessionRole;
  /** The device the session was issued to, as recorded then (see MessageSentFrom). */
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
}

/** A session of a client app (the owner's or a paired one): never a linked computer's. */
export interface ClientAuthenticatedSession extends AuthenticatedSession {
  readonly role: Exclude<SessionRole, "peer">;
}

/** A linked computer's server, signed in for the `/peer` endpoint only. */
export interface PeerAuthenticatedSession extends AuthenticatedSession {
  readonly role: "peer";
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 500;
  readonly cause?: unknown;
}> {}

export interface ServerAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthSessionState, never>;
  readonly exchangeBootstrapCredential: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly exchangeBootstrapCredentialForBearerSession: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<AuthBearerBootstrapResult, AuthError>;
  readonly issuePairingCredential: (
    input?: AuthCreatePairingCredentialInput & {
      readonly role?: ClientSessionRole;
    },
  ) => Effect.Effect<AuthPairingCredentialResult, AuthError>;
  readonly listPairingLinks: () => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthError>;
  readonly listClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<AuthClientSession>, AuthError>;
  readonly revokeClientSession: (
    currentSessionId: AuthSessionId,
    targetSessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthError>;
  readonly revokeOtherClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthError>;
  /**
   * Names a phone, tablet or browser using this computer; `null` goes back to
   * what it called itself. Fails 400 for a session that isn't a live device
   * (a linked computer keeps the name it gives itself).
   */
  readonly renameClientSession: (
    targetSessionId: AuthSessionId,
    name: string | null,
  ) => Effect.Effect<void, AuthError>;
  /** Any client app's request. A linked computer's (`peer`) session is refused. */
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<ClientAuthenticatedSession, AuthError>;
  /** `/ws`: a client app's socket. A linked computer's (`peer`) session is refused. */
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<ClientAuthenticatedSession, AuthError>;
  /** `/peer`: a linked computer's socket, by WebSocket token only. Every other role is refused. */
  readonly authenticatePeerUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<PeerAuthenticatedSession, AuthError>;
  readonly issueWebSocketToken: (
    session: AuthenticatedSession,
  ) => Effect.Effect<AuthWebSocketTokenResult, AuthError>;
  readonly issueStartupPairingUrl: (baseUrl: string) => Effect.Effect<string, AuthError>;
}

export class ServerAuth extends Context.Service<ServerAuth, ServerAuthShape>()(
  "threadlines/auth/Services/ServerAuth",
) {}
