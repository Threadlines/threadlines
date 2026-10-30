/**
 * This computer's relay registration, for features that ride on it without
 * living inside RelayHost (assistants, docs/design/assistants.md). RelayHost
 * owns the registration, its host secret and the control socket;
 * RelayHostLive provides this alongside it.
 *
 * - `credentials` are the stored ones, or null while this computer isn't
 *   registered (or the relay address isn't valid).
 * - `register` registers it if it isn't yet, one registration at a time.
 * - `forgetHost` drops the stored credentials when the relay answered that
 *   it no longer knows `hostId`; the next `register` makes a new host.
 * - `keepOnline(reason, true)` keeps the control socket, and the lease that
 *   tells the relay this computer is there, up until the same reason is let
 *   go with `false`.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export interface RelayHostCredentials {
  readonly hostId: string;
  readonly hostSecret: string;
}

/** Registering failed; `transient` when trying again later may work (network, relay busy or down). */
export class RelayRegisterError extends Data.TaggedError("RelayRegisterError")<{
  readonly detail: string;
  readonly transient: boolean;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface RelayHostLinkShape {
  /** The relay's origin; null when the configured relay address isn't valid. */
  readonly relayOrigin: string | null;
  readonly credentials: Effect.Effect<RelayHostCredentials | null>;
  readonly register: Effect.Effect<RelayHostCredentials, RelayRegisterError>;
  readonly forgetHost: (hostId: string) => Effect.Effect<void>;
  readonly keepOnline: (reason: string, on: boolean) => Effect.Effect<void>;
}

export class RelayHostLink extends Context.Service<RelayHostLink, RelayHostLinkShape>()(
  "threadlines/relay/RelayHostLink",
) {}
