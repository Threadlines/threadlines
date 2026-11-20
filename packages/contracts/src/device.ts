/**
 * Simulators and emulators on the server's machine (docs/design/devices.md).
 *
 * The server owns them the way it owns terminals; clients watch and touch them
 * through the `device.*` RPCs and the device channel, agents through the
 * `device_*` MCP tools. Ported from T3 Code's device contracts without its
 * remote host kinds: a server has exactly one device host, its own machine.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DevicePlatform = Schema.Literals(["ios", "android"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type DeviceId = typeof DeviceId.Type;

export const DeviceSummary = Schema.Struct({
  id: DeviceId,
  platform: DevicePlatform,
  name: TrimmedNonEmptyString,
  /** OS version, such as "iOS 27.2" or "Android 16". */
  version: Schema.String,
  booted: Schema.Boolean,
  physical: Schema.Boolean,
  /**
   * The hardware the device is, for drawing its frame: an iOS simulator's
   * device type (`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`), an
   * emulator's hardware profile (`pixel_fold`), or a phone's
   * `ro.product.model`. Names can be changed, so frames follow this instead.
   * Absent from older servers and when the server could not tell.
   */
  model: Schema.optional(TrimmedNonEmptyString),
});
export type DeviceSummary = typeof DeviceSummary.Type;

export const DevicePlatformAvailability = Schema.Struct({
  platform: DevicePlatform,
  available: Schema.Boolean,
  /** Why not, in words the user can act on ("Xcode command line tools were not found."). */
  reason: Schema.optional(Schema.String),
});
export type DevicePlatformAvailability = typeof DevicePlatformAvailability.Type;

/** One pinned tool: the version this server wants, what is on disk, what is running. */
export const DeviceToolVersion = Schema.Struct({
  requiredVersion: Schema.String,
  installedVersions: Schema.Array(Schema.String),
  runningVersion: Schema.NullOr(Schema.String),
});
export type DeviceToolVersion = typeof DeviceToolVersion.Type;

export const DeviceToolName = Schema.Literals(["hub", "agent"]);
export type DeviceToolName = typeof DeviceToolName.Type;

export const DeviceToolVersions = Schema.Struct({
  /** expo-device-hub: streams and takes input. */
  hub: DeviceToolVersion,
  /** agent-device: the command line agents drive devices with. */
  agent: DeviceToolVersion,
});
export type DeviceToolVersions = typeof DeviceToolVersions.Type;

/**
 * - `disabled`: "Use devices" is off.
 * - `idle`: on, nothing started yet (nothing starts until a client or agent asks).
 * - `installing` / `starting`: the hub is being installed or started.
 * - `ready`: devices can be listed and opened.
 * - `failed`: see `hostStatusDetail`.
 */
export const DeviceHostStatus = Schema.Literals([
  "disabled",
  "idle",
  "installing",
  "starting",
  "ready",
  "failed",
]);
export type DeviceHostStatus = typeof DeviceHostStatus.Type;

/** A thread's hold on a device, from opening it until it is closed or the thread is put away. */
export const DeviceSession = Schema.Struct({
  threadId: ThreadId,
  deviceId: DeviceId,
  platform: DevicePlatform,
  openedAt: Schema.String,
  /** Threadlines booted it for this session, rather than finding it running. */
  bootedByThreadlines: Schema.Boolean,
  /** An agent's `device_open` brings the Device tab up for everyone watching the thread; a user's does not. */
  openedBy: Schema.Literals(["user", "agent"]),
});
export type DeviceSession = typeof DeviceSession.Type;

export const DeviceServiceState = Schema.Struct({
  /** Settings → Devices → Use devices. */
  enabled: Schema.Boolean,
  /** Settings → Devices → Agents can use devices. */
  agentAccessEnabled: Schema.Boolean,
  hostStatus: DeviceHostStatus,
  hostStatusDetail: Schema.optional(Schema.String),
  platforms: Schema.Array(DevicePlatformAvailability),
  /** Platforms whose last listing failed; their devices may be missing from `devices`. */
  incompletePlatforms: Schema.Array(DevicePlatform),
  tools: Schema.optional(DeviceToolVersions),
  toolInspectionError: Schema.optional(Schema.String),
  hubInstalled: Schema.Boolean,
  agentDeviceInstalled: Schema.Boolean,
  devices: Schema.Array(DeviceSummary),
  sessions: Schema.Array(DeviceSession),
  /** Devices booting right now, and the thread that asked. */
  bootingDevices: Schema.Array(Schema.Struct({ ...DeviceSummary.fields, threadId: ThreadId })),
  /** Rises with every change; clients drop states older than one they have. */
  revision: Schema.Int,
});
export type DeviceServiceState = typeof DeviceServiceState.Type;

export const DeviceListInput = Schema.Struct({
  /** Ask the hub again instead of answering from the last listing. Starts the hub if needed. */
  refresh: Schema.optional(Schema.Boolean),
});
export type DeviceListInput = typeof DeviceListInput.Type;

export const DeviceUpdateToolInput = Schema.Struct({
  tool: DeviceToolName,
});
export type DeviceUpdateToolInput = typeof DeviceUpdateToolInput.Type;

export const DeviceOpenInput = Schema.Struct({
  threadId: ThreadId,
  deviceId: DeviceId,
  platform: DevicePlatform,
  /** Boot the simulator or emulator when it is not running. Defaults to true. */
  boot: Schema.optional(Schema.Boolean),
});
export type DeviceOpenInput = typeof DeviceOpenInput.Type;

export const DeviceCloseInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to close every device session for the thread. */
  deviceId: Schema.optional(DeviceId),
  /** Also shut the simulator or emulator down. Defaults to false. */
  shutdown: Schema.optional(Schema.Boolean),
});
export type DeviceCloseInput = typeof DeviceCloseInput.Type;

export const DeviceShutdownInput = Schema.Struct({
  deviceId: DeviceId,
  platform: DevicePlatform,
});
export type DeviceShutdownInput = typeof DeviceShutdownInput.Type;

export const DeviceAppearance = Schema.Literals(["light", "dark"]);
export type DeviceAppearance = typeof DeviceAppearance.Type;

export const DeviceTextSize = Schema.Literals(["small", "default", "large", "extra-large"]);
export type DeviceTextSize = typeof DeviceTextSize.Type;

export const DeviceColorFilter = Schema.Literals([
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
]);
export type DeviceColorFilter = typeof DeviceColorFilter.Type;

export const DeviceOrientation = Schema.Literals([
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
]);
export type DeviceOrientation = typeof DeviceOrientation.Type;

/** What the Tools drawer shows, read back from the device. A missing field is one the platform lacks. */
export const DeviceSettings = Schema.Struct({
  appearance: Schema.optional(DeviceAppearance),
  textSize: Schema.optional(DeviceTextSize),
  reduceMotion: Schema.optional(Schema.Boolean),
  increaseContrast: Schema.optional(Schema.Boolean),
  reduceTransparency: Schema.optional(Schema.Boolean),
  showBorders: Schema.optional(Schema.Boolean),
  voiceOver: Schema.optional(Schema.Boolean),
  liquidGlass: Schema.optional(Schema.Literals(["clear", "tinted"])),
  colorFilter: Schema.optional(DeviceColorFilter),
  networkEnabled: Schema.optional(Schema.Boolean),
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ latitude: Schema.Number, longitude: Schema.Number })),
  ),
});
export type DeviceSettings = typeof DeviceSettings.Type;

export const DeviceForegroundApp = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});
export type DeviceForegroundApp = typeof DeviceForegroundApp.Type;

export const DeviceDetail = Schema.Struct({
  deviceId: DeviceId,
  settings: DeviceSettings,
  foregroundApp: Schema.NullOr(DeviceForegroundApp),
  readAt: Schema.String,
});
export type DeviceDetail = typeof DeviceDetail.Type;

export const DevicePermission = Schema.Literals([
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "location",
  "notifications",
  "motion",
  "media-library",
  "faceid",
]);
export type DevicePermission = typeof DevicePermission.Type;

const DeviceTarget = {
  deviceId: DeviceId,
};

/**
 * One Tools drawer control. The server runs `simctl`, `adb` or a serve-sim
 * helper binary for each itself; none of them goes through the hub.
 */
export const DeviceActionInput = Schema.Union([
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setAppearance"),
    value: DeviceAppearance,
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("setTextSize"), value: DeviceTextSize }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setToggle"),
    setting: Schema.Literals([
      "reduceMotion",
      "increaseContrast",
      "reduceTransparency",
      "showBorders",
      "voiceOver",
      "networkEnabled",
    ]),
    value: Schema.Boolean,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setLiquidGlass"),
    value: Schema.Literals(["clear", "tinted"]),
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setColorFilter"),
    value: DeviceColorFilter,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setOrientation"),
    value: DeviceOrientation,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setLocation"),
    latitude: Schema.Number.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
    longitude: Schema.Number.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("clearLocation") }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setPermission"),
    appId: TrimmedNonEmptyString,
    permission: DevicePermission,
    decision: Schema.Literals(["grant", "revoke", "reset"]),
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("openUrl"), url: TrimmedNonEmptyString }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("launchApp"),
    appId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("terminateApp"),
    appId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("shake") }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("sendPush"),
    appId: TrimmedNonEmptyString,
    payload: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
  }),
]);
export type DeviceActionInput = typeof DeviceActionInput.Type;
export type DeviceActionType = DeviceActionInput["type"];

export const DeviceDetailInput = Schema.Struct(DeviceTarget);
export type DeviceDetailInput = typeof DeviceDetailInput.Type;

// ── Errors ─────────────────────────────────────────────────────────────

/** Devices are off, or the hub could not be installed or started. */
export class DeviceHostUnavailableError extends Schema.TaggedError<DeviceHostUnavailableError>()(
  "DeviceHostUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Devices are unavailable: ${this.reason}`;
  }
}

export class DevicePlatformUnavailableError extends Schema.TaggedError<DevicePlatformUnavailableError>()(
  "DevicePlatformUnavailableError",
  { platform: DevicePlatform, reason: Schema.String },
) {
  override get message(): string {
    return `${this.platform === "ios" ? "iOS" : "Android"} devices are unavailable: ${this.reason}`;
  }
}

export class DeviceNotFoundError extends Schema.TaggedError<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  { deviceId: DeviceId },
) {
  override get message(): string {
    return `Device ${this.deviceId} was not found.`;
  }
}

export class DeviceBootError extends Schema.TaggedError<DeviceBootError>()("DeviceBootError", {
  deviceId: DeviceId,
  reason: Schema.Literals(["disk_space", "timeout", "launch_failed"]),
  diagnostics: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
}) {
  override get message(): string {
    const explanation = {
      disk_space: "There is not enough free disk space.",
      timeout: "The device did not become ready in time.",
      launch_failed: "The simulator or emulator could not start.",
    }[this.reason];
    const summary = `Device ${this.deviceId} failed to start: ${explanation}`;
    return this.diagnostics ? `${summary}\n\n${this.diagnostics}` : summary;
  }
}

export class DeviceOperationError extends Schema.TaggedError<DeviceOperationError>()(
  "DeviceOperationError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "command_failed",
      "request_failed",
      "invalid_payload",
      "settings_failed",
      "hub_rejected",
      "package_manager_missing",
    ]),
    exitCode: Schema.optional(Schema.Number),
    /** What the tool said, trimmed. No stack traces: this reaches the browser. */
    detail: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  },
) {
  override get message(): string {
    const explanation = {
      command_failed: `The device command failed${this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`}.`,
      request_failed: "Could not reach device support. Try refreshing devices.",
      invalid_payload: "The device request could not be encoded.",
      settings_failed: "Could not read or save device settings.",
      hub_rejected: "The device hub could not complete the request.",
      package_manager_missing:
        "Device support needs npm, which is not on the Threadlines server's PATH. Install Node.js from nodejs.org, restart Threadlines, then try again.",
    }[this.reason];
    const base = `Device ${this.operation} failed: ${explanation}`;
    return this.detail ? `${base}\n\n${this.detail}` : base;
  }
}

export class DeviceActionUnavailableError extends Schema.TaggedError<DeviceActionUnavailableError>()(
  "DeviceActionUnavailableError",
  {
    operation: Schema.String,
    platform: DevicePlatform,
    reason: Schema.Literals(["unsupported", "helper_missing"]),
  },
) {
  override get message(): string {
    return this.reason === "helper_missing"
      ? `Device ${this.operation} needs a helper missing from this install. Update the device hub in Settings → Devices.`
      : `Device ${this.operation} is not supported on ${this.platform === "ios" ? "iOS" : "Android"}.`;
  }
}

export const DeviceError = Schema.Union([
  DeviceHostUnavailableError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
  DeviceActionUnavailableError,
]);
export type DeviceError = typeof DeviceError.Type;

// ── Device channel ─────────────────────────────────────────────────────
//
// Every byte between the Device tab and the hub rides the client's WS RPC
// connection, so it works the same from the desktop app, a browser, a phone
// and a saved computer over the relay. Modeled on the preview tunnel
// (previewTunnel.ts): open while subscribed, never resubscribed, flow
// controlled by credit. The server checks every path against its allowlist and
// adds the hub's token itself; clients never see it.

/** The most one `data` or `message` event carries, before base64. */
export const DEVICE_CHANNEL_CHUNK_BYTES = 256 * 1024;

/** Bytes the server sends down a channel before the client credits them. */
export const DEVICE_CHANNEL_WINDOW_BYTES = 2 * 1024 * 1024;

const DeviceChannelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

const DeviceChannelPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^\/[^?#]*$/),
);

const DeviceChannelQuery = Schema.Record(Schema.String, Schema.String);

export const DeviceChannelOpen = Schema.Union([
  Schema.TaggedStruct("http", {
    /** Chosen by the client, so sends and credits can name the channel. */
    channelId: DeviceChannelId,
    method: Schema.Literals(["GET", "POST"]),
    /** A hub path such as `/vendor/serve-sim/helper/<udid>/stream.avcc`. */
    path: DeviceChannelPath,
    query: Schema.optional(DeviceChannelQuery),
    /** Request body, base64. Only on the hub's few POST routes. */
    body: Schema.optional(Schema.String.check(Schema.isMaxLength(256 * 1024))),
    contentType: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  }),
  Schema.TaggedStruct("ws", {
    channelId: DeviceChannelId,
    path: DeviceChannelPath,
    query: Schema.optional(DeviceChannelQuery),
    protocols: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(128)))),
  }),
]);
export type DeviceChannelOpen = typeof DeviceChannelOpen.Type;

/**
 * What the server sends down an open channel. The subscription ends after
 * `end`, and fails when the channel could not open or broke.
 *
 * - `opened`: http status and content type, or a ws that connected.
 * - `data`: a slice of an http response body, base64, in order.
 * - `message`: a ws message, or a part of one when `final` is false; parts of
 *   one message arrive together and in order.
 * - `end`: the http body finished, or the ws closed (`code`, `reason`).
 */
export const DeviceChannelEvent = Schema.Union([
  Schema.TaggedStruct("opened", {
    status: Schema.optional(Schema.Int),
    contentType: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("data", { data: Schema.String }),
  Schema.TaggedStruct("message", {
    data: Schema.String,
    binary: Schema.Boolean,
    final: Schema.Boolean,
  }),
  Schema.TaggedStruct("end", {
    code: Schema.optional(Schema.Int),
    reason: Schema.optional(Schema.String),
  }),
]);
export type DeviceChannelEvent = typeof DeviceChannelEvent.Type;

/** One ws message for the hub, in order. Answered once written to the hub's socket. */
export const DeviceChannelSend = Schema.Struct({
  channelId: DeviceChannelId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** base64 when `binary`, the text itself otherwise. */
  data: Schema.String.check(Schema.isMaxLength(512 * 1024)),
  binary: Schema.Boolean,
});
export type DeviceChannelSend = typeof DeviceChannelSend.Type;

/** The client's decoder took this many more bytes of the channel's data. */
export const DeviceChannelCredit = Schema.Struct({
  channelId: DeviceChannelId,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type DeviceChannelCredit = typeof DeviceChannelCredit.Type;

export const DeviceChannelFailureReason = Schema.Literals([
  /** The path is not one a client may use. */
  "forbidden",
  /** Devices are off or the hub is not running. */
  "unavailable",
  /** The hub could not be reached, or refused. */
  "unreachable",
  /** The connection broke after it opened. */
  "broken",
  /** The client stopped reading and the server stopped holding data for it. */
  "slow",
  /** Too many channels open, or a send out of all proportion. */
  "limit",
  /** A send or credit named a channel this connection does not have open. */
  "unknownChannel",
]);
export type DeviceChannelFailureReason = typeof DeviceChannelFailureReason.Type;

export class DeviceChannelError extends Schema.TaggedError<DeviceChannelError>()(
  "DeviceChannelError",
  { reason: DeviceChannelFailureReason, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

// ── Agent tools ────────────────────────────────────────────────────────

export const DeviceToolListResult = Schema.Struct({
  hostStatus: DeviceHostStatus,
  hostStatusDetail: Schema.optional(Schema.String),
  platforms: Schema.Array(DevicePlatformAvailability),
  devices: Schema.Array(DeviceSummary),
  /** Devices this thread has open. */
  open: Schema.Array(Schema.Struct({ deviceId: DeviceId })),
});
export type DeviceToolListResult = typeof DeviceToolListResult.Type;

export const DeviceToolOpenInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description: "Device id from `device_list`. Default: the booted or last used device.",
    }),
  ),
  platform: Schema.optional(
    DevicePlatform.annotate({
      description: "Needed with no `deviceId` when both platforms exist.",
    }),
  ),
});
export type DeviceToolOpenInput = typeof DeviceToolOpenInput.Type;

export const DeviceToolOpenResult = Schema.Struct({
  device: DeviceSummary,
  agentDevice: Schema.Struct({
    /** Absolute path of the launcher bound to this thread and device. */
    command: Schema.String,
    session: Schema.String,
  }),
  quickStart: Schema.String,
});
export type DeviceToolOpenResult = typeof DeviceToolOpenResult.Type;

export const DeviceToolTargetInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({ description: "Device. Default: the last one opened here." }),
  ),
});
export type DeviceToolTargetInput = typeof DeviceToolTargetInput.Type;

export const DeviceToolScreenshotResult = Schema.Struct({
  device: DeviceSummary,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type DeviceToolScreenshotResult = typeof DeviceToolScreenshotResult.Type;

export const DeviceToolCloseInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({ description: "Device to close. None: close all here." }),
  ),
  shutdown: Schema.optional(
    Schema.Boolean.annotate({ description: "Also turn it off. Default false." }),
  ),
});
export type DeviceToolCloseInput = typeof DeviceToolCloseInput.Type;

export class DeviceToolUnavailableError extends Schema.TaggedError<DeviceToolUnavailableError>()(
  "DeviceToolUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const DeviceToolError = Schema.Union([
  DeviceToolUnavailableError,
  DeviceHostUnavailableError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
  DeviceActionUnavailableError,
]);
export type DeviceToolError = typeof DeviceToolError.Type;
