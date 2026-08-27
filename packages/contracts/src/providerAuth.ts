/**
 * Provider sign-in sessions.
 *
 * Wire shapes for the settings-owned auth flow: Threadlines spawns the
 * provider's own auth command in an ephemeral PTY (never a thread terminal,
 * never persisted) and streams its output back to the Providers settings
 * page. Secrets printed by `claude setup-token` are captured and masked
 * server-side, so `ProviderAuthOutputEvent.data` never carries a raw token.
 *
 * @module providerAuth
 */
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

const ProviderAuthColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const ProviderAuthRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);

/**
 * `login` runs the driver's interactive sign-in (`codex login`,
 * `claude auth login`); `claude-setup-token` mints the long-lived headless
 * token and stores it as a sensitive instance environment variable.
 */
export const ProviderAuthFlow = Schema.Literals(["login", "claude-setup-token"]);
export type ProviderAuthFlow = typeof ProviderAuthFlow.Type;

export const ProviderAuthStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flow: ProviderAuthFlow,
  cols: Schema.optional(ProviderAuthColsSchema),
  rows: Schema.optional(ProviderAuthRowsSchema),
});
export type ProviderAuthStartInput = Schema.Codec.Encoded<typeof ProviderAuthStartInput>;

export const ProviderAuthWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type ProviderAuthWriteInput = Schema.Codec.Encoded<typeof ProviderAuthWriteInput>;

export const ProviderAuthResizeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cols: ProviderAuthColsSchema,
  rows: ProviderAuthRowsSchema,
});
export type ProviderAuthResizeInput = Schema.Codec.Encoded<typeof ProviderAuthResizeInput>;

export const ProviderAuthStopInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderAuthStopInput = Schema.Codec.Encoded<typeof ProviderAuthStopInput>;

export const ProviderAuthSubscribeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderAuthSubscribeInput = Schema.Codec.Encoded<typeof ProviderAuthSubscribeInput>;

/**
 * `idle` is only ever emitted as the first event of a subscription that
 * attached before (or after) a run — it carries no history.
 */
export const ProviderAuthStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "succeeded",
  "failed",
]);
export type ProviderAuthStatus = typeof ProviderAuthStatus.Type;

const ProviderAuthEventBase = Schema.Struct({
  instanceId: ProviderInstanceId,
  createdAt: Schema.String,
});

const ProviderAuthCommandEvent = Schema.Struct({
  ...ProviderAuthEventBase.fields,
  type: Schema.Literal("command"),
  flow: ProviderAuthFlow,
  /** Shell-quoted command, shown under the copy fallback disclosure. */
  command: Schema.String,
});

const ProviderAuthOutputEvent = Schema.Struct({
  ...ProviderAuthEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const ProviderAuthStatusEvent = Schema.Struct({
  ...ProviderAuthEventBase.fields,
  type: Schema.Literal("status"),
  status: ProviderAuthStatus,
  exitCode: Schema.NullOr(Schema.Int),
  /** Plain-language reason shown when a flow fails. */
  detail: Schema.NullOr(Schema.String),
});

export const ProviderAuthEvent = Schema.Union([
  ProviderAuthCommandEvent,
  ProviderAuthOutputEvent,
  ProviderAuthStatusEvent,
]);
export type ProviderAuthEvent = typeof ProviderAuthEvent.Type;

export class ProviderAuthError extends Schema.TaggedError<ProviderAuthError>()(
  "ProviderAuthError",
  {
    instanceId: Schema.String,
    reason: Schema.Literals([
      "unknownInstance",
      "unsupportedFlow",
      "notRunning",
      "spawnFailed",
      "settingsFailed",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    const suffix = this.detail ? ` (${this.detail})` : "";
    switch (this.reason) {
      case "unknownInstance":
        return `Unknown provider instance: ${this.instanceId}${suffix}`;
      case "unsupportedFlow":
        return `This provider does not support that sign-in flow: ${this.instanceId}${suffix}`;
      case "notRunning":
        return `No sign-in is running for provider instance: ${this.instanceId}${suffix}`;
      case "spawnFailed":
        return `Could not start the sign-in command for ${this.instanceId}${suffix}`;
      case "settingsFailed":
        return `Could not save credentials for ${this.instanceId}${suffix}`;
    }
  }
}
