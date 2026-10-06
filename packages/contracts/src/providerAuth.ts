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
 * `claude auth login`, Antigravity's Google sign-in); `claude-setup-token`
 * mints the long-lived headless token and stores it as a sensitive instance
 * environment variable; `logout` signs the provider out where it can.
 */
export const ProviderAuthFlow = Schema.Literals(["login", "claude-setup-token", "logout"]);
export type ProviderAuthFlow = typeof ProviderAuthFlow.Type;

export const ProviderAuthStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flow: ProviderAuthFlow,
  cols: Schema.optional(ProviderAuthColsSchema),
  rows: Schema.optional(ProviderAuthRowsSchema),
  /**
   * The starting client's own id for this request, echoed on the run's
   * `command` event so that client (and only it) knows the run is its own.
   */
  requestId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type ProviderAuthStartInput = Schema.Codec.Encoded<typeof ProviderAuthStartInput>;

/**
 * Input for the running flow: terminal keystrokes, or, for a browser
 * sign-in, the address the browser ended on (pasted from another device).
 * `flowId` names the run it is meant for; input for an older run is refused.
 */
export const ProviderAuthWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  flowId: Schema.optional(Schema.String),
});
export type ProviderAuthWriteInput = Schema.Codec.Encoded<typeof ProviderAuthWriteInput>;

export const ProviderAuthResizeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cols: ProviderAuthColsSchema,
  rows: ProviderAuthRowsSchema,
});
export type ProviderAuthResizeInput = Schema.Codec.Encoded<typeof ProviderAuthResizeInput>;

/** `flowId`: stop only that run, so a stale panel can't cancel a newer one. */
export const ProviderAuthStopInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: Schema.optional(Schema.String),
});
export type ProviderAuthStopInput = Schema.Codec.Encoded<typeof ProviderAuthStopInput>;

/** The user's answer to a `pageRequest`: opened the page (`accept`), or cancelled. */
export const ProviderAuthRespondInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: Schema.String,
  requestId: Schema.String,
  accept: Schema.Boolean,
});
export type ProviderAuthRespondInput = Schema.Codec.Encoded<typeof ProviderAuthRespondInput>;

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
  /** Identifies this run for writes and stops. */
  flowId: Schema.optional(Schema.String),
  /** The `requestId` the run was started with. */
  requestId: Schema.optional(Schema.String),
  /** `browser`: no terminal; the flow opens a sign-in page and accepts its final address. */
  surface: Schema.optional(Schema.Literals(["terminal", "browser"])),
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

/**
 * The agent asked for a web page to be opened to finish signing in. Nothing
 * opens by itself: the panel shows the address, and the user's click is
 * answered with `providerAuth.respond`. A second event with `settled: true`
 * tells every panel the request was answered or withdrawn.
 */
const ProviderAuthPageRequestEvent = Schema.Struct({
  ...ProviderAuthEventBase.fields,
  type: Schema.Literal("pageRequest"),
  flowId: Schema.String,
  requestId: Schema.String,
  /** Always http or https. */
  url: Schema.String.check(Schema.isMaxLength(4096)),
  /** What the agent says the page is for. */
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  settled: Schema.Boolean,
});

export const ProviderAuthEvent = Schema.Union([
  ProviderAuthCommandEvent,
  ProviderAuthOutputEvent,
  ProviderAuthStatusEvent,
  ProviderAuthPageRequestEvent,
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
      "inputRejected",
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
      case "inputRejected":
        return this.detail ?? "The sign-in did not accept that input.";
    }
  }
}
