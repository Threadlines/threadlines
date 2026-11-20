/**
 * What the device tools do (docs/design/devices.md), for McpDeviceServer.
 * Ported from T3 Code's device toolkit handlers, with one host per server.
 */
import {
  type DeviceError,
  type DeviceId,
  type DevicePlatform,
  type DeviceServiceState,
  type DeviceSummary,
  type DeviceToolCloseInput,
  type DeviceToolListResult,
  type DeviceToolOpenInput,
  type DeviceToolOpenResult,
  type DeviceToolTargetInput,
  DeviceToolUnavailableError,
  type ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import { DeviceService, type DeviceScreenshot } from "../device/DeviceService.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { outsideDeviceDetail } from "./outsideToolLimit.ts";

const shellWord = (value: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** How to drive the device with its bound launcher: returned by `device_open`, never kept in a prompt. */
export function agentDeviceQuickStart(device: DeviceSummary, command: string): string {
  const executable = shellWord(command);
  const run = (args: string) => `${executable} ${args}`;
  return [
    `The user is watching ${device.name} (${device.version}) in the Device tab.`,
    `Drive it with ${executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH.`,
    // Screenshots and input need the session `open` starts, and an iOS snapshot also needs its app.
    // device_open does not run open itself: on iOS that can start a minutes-long XCTest runner build.
    "Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.",
    `  ${run("open <bundle-or-package-id> --relaunch")}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it`,
    `  ${run("open <bundle-or-package-id> <deep-link-url>")}`,
    `  ${run("snapshot -i")}  # accessibility tree with @eN refs`,
    `  ${run("press @e3 --settle")}`,
    `  ${run('fill @e5 "text" --settle')}`,
    `  ${run("alert accept")}`,
    `  ${run("settings appearance dark")}  # also text-size, permission grant <name>`,
    `  ${run("screenshot /tmp/shot.png")}  # ${device.platform === "ios" ? "iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, " : ""}or call device_screenshot to look`,
    `  ${run("record start --scope device /tmp/run.mp4")}  # then record stop`,
    `  ${run("install <app> <path-to-.app-or-.apk>")}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help <command> for flags and ${executable} help workflow for guides.`,
    "Do not use simctl, idb, adb or ssh for those actions. They stay fine for builds, installs, code sync, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.",
    "Each device_open returns its own command; opening another device does not retarget this one.",
    "The command is removed when the device closes or the thread is put away. If it is missing, call device_open again.",
    device.platform === "ios"
      ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.",
  ].join("\n");
}

const NO_ACCESS =
  "Agents can't use devices on this computer right now. Ask the user to turn on Use devices and Agents can use devices in Settings → Devices; it applies to agent sessions started after that, such as in a new thread.";

/** The caller may use the device tools: its credential has the grant and the settings still allow it. */
const requireAccess = (caller: McpInvocationScope) =>
  Effect.gen(function* () {
    if (!caller.device) return yield* new DeviceToolUnavailableError({ reason: NO_ACCESS });
    // Work from an outside connection must not reach this machine's devices.
    if (caller.outsideLimit !== undefined) {
      return yield* new DeviceToolUnavailableError({
        reason: outsideDeviceDetail(caller.outsideLimit),
      });
    }
    const state = yield* (yield* DeviceService).state;
    if (!state.enabled || !state.agentAccessEnabled) {
      return yield* new DeviceToolUnavailableError({ reason: NO_ACCESS });
    }
    return state;
  });

/**
 * The device an agent means: the one it named, else the booted or first
 * simulator or emulator of its platform. A physical phone is never picked by
 * default; an agent gets one only by naming its id.
 */
export const pickDevice = (
  state: Pick<DeviceServiceState, "devices" | "hostStatus" | "hostStatusDetail">,
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
  },
): Effect.Effect<DeviceSummary, DeviceToolUnavailableError> => {
  if (input.deviceId !== undefined) {
    const found = state.devices.find((device) => device.id === input.deviceId);
    if (found) return Effect.succeed(found);
    return Effect.fail(
      new DeviceToolUnavailableError({
        reason: [
          `No device ${input.deviceId} on this computer.`,
          ...(state.hostStatus === "failed" && state.hostStatusDetail
            ? [`Device support failed to start: ${state.hostStatusDetail}`]
            : []),
          "Call device_list for current ids.",
        ].join(" "),
      }),
    );
  }
  const candidates = state.devices.filter(
    (device) =>
      !device.physical && (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    return Effect.fail(
      new DeviceToolUnavailableError({
        reason:
          state.hostStatus === "failed" && state.hostStatusDetail
            ? state.hostStatusDetail
            : input.platform === undefined
              ? "No simulators or emulators were found. Call device_list to see why."
              : `No ${input.platform === "ios" ? "iOS" : "Android"} devices were found. Call device_list to see why.`,
      }),
    );
  }
  if (
    input.platform === undefined &&
    new Set(candidates.map((device) => device.platform)).size > 1
  ) {
    return Effect.fail(
      new DeviceToolUnavailableError({
        reason: "Both iOS and Android devices are available; pass platform or deviceId.",
      }),
    );
  }
  return Effect.succeed(candidates.find((device) => device.booted) ?? candidates[0]!);
};

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

export const deviceList = (
  caller: McpInvocationScope,
  input: { readonly refresh?: boolean | undefined },
) =>
  Effect.gen(function* () {
    yield* requireAccess(caller);
    const devices = yield* DeviceService;
    const state = yield* devices.list({ refresh: input.refresh !== false });
    return {
      hostStatus: state.hostStatus,
      ...(state.hostStatusDetail ? { hostStatusDetail: state.hostStatusDetail } : {}),
      platforms: state.platforms,
      devices: state.devices,
      open: state.sessions
        .filter((session) => session.threadId === caller.threadId)
        .map((session) => ({ deviceId: session.deviceId })),
    } satisfies DeviceToolListResult;
  }).pipe(Effect.mapError(toolError));

export const deviceOpen = (caller: McpInvocationScope, input: DeviceToolOpenInput) =>
  Effect.gen(function* () {
    yield* requireAccess(caller);
    const devices = yield* DeviceService;
    const listed = yield* devices.list({ refresh: true });
    const target = yield* pickDevice(listed, input);
    const opened = yield* devices.agentOpen({
      threadId: caller.threadId,
      deviceId: target.id,
      platform: target.platform,
    });
    return {
      device: opened.device,
      agentDevice: { command: opened.command, session: opened.agentSession },
      quickStart: agentDeviceQuickStart(opened.device, opened.command),
    } satisfies DeviceToolOpenResult;
  }).pipe(Effect.mapError(toolError));

/** The session a screenshot or close means: the one named, else the last one this thread opened. */
const sessionFor = (threadId: ThreadId, deviceId: DeviceId | undefined) =>
  Effect.gen(function* () {
    const sessions = yield* (yield* DeviceService).sessionsForThread(threadId);
    const session =
      deviceId === undefined
        ? sessions.at(-1)
        : sessions.find((candidate) => candidate.deviceId === deviceId);
    if (!session) {
      return yield* new DeviceToolUnavailableError({
        reason:
          deviceId === undefined
            ? "No device is open in this thread. Call device_open first."
            : `Device ${deviceId} is not open in this thread. Call device_open first.`,
      });
    }
    return session;
  });

export const deviceScreenshot = (
  caller: McpInvocationScope,
  input: DeviceToolTargetInput,
): Effect.Effect<DeviceScreenshot, DeviceError | DeviceToolUnavailableError, DeviceService> =>
  Effect.gen(function* () {
    yield* requireAccess(caller);
    const session = yield* sessionFor(caller.threadId, input.deviceId);
    return yield* (yield* DeviceService).screenshot(session.deviceId);
  }).pipe(Effect.mapError(toolError));

export const deviceClose = (caller: McpInvocationScope, input: DeviceToolCloseInput) =>
  Effect.gen(function* () {
    yield* requireAccess(caller);
    const devices = yield* DeviceService;
    if (input.deviceId !== undefined) yield* sessionFor(caller.threadId, input.deviceId);
    yield* devices.close({
      threadId: caller.threadId,
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
    });
    return {};
  }).pipe(Effect.mapError(toolError));
