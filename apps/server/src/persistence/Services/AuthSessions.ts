import { AuthClientMetadataDeviceType, AuthSessionId } from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export const ExtendAuthSessionExpiryInput = Schema.Struct({
  sessionId: AuthSessionId,
  expiresAt: Schema.DateTimeUtcFromString,
  now: Schema.DateTimeUtcFromString,
});
export type ExtendAuthSessionExpiryInput = typeof ExtendAuthSessionExpiryInput.Type;

export interface AuthSessionRepositoryShape {
  readonly create: (
    input: CreateAuthSessionInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getById: (
    input: GetAuthSessionByIdInput,
  ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
  readonly listActive: (
    input: ListActiveAuthSessionsInput,
  ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
  readonly revoke: (
    input: RevokeAuthSessionInput,
  ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
  readonly setLastConnectedAt: (
    input: SetAuthSessionLastConnectedAtInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  /**
   * Moves a live session's expiry later (never earlier). Returns whether the
   * session is still usable; revoked, expired, or unknown sessions return false
   * and are never revived.
   */
  readonly extendExpiry: (
    input: ExtendAuthSessionExpiryInput,
  ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
}

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  AuthSessionRepositoryShape
>()("threadlines/persistence/Services/AuthSessions/AuthSessionRepository") {}
