/**
 * Reading a `DeviceServiceState` the way the Device tab and Settings → Devices
 * both need it: which platforms work, what the install line says, which
 * version of a tool is on disk. Pure, so every client words it the same.
 */
import type {
  DevicePlatform,
  DeviceServiceState,
  DeviceSession,
  DeviceSummary,
  DeviceToolVersion,
  ThreadId,
} from "@threadlines/contracts";

export const devicePlatformName = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS" : "Android";

/**
 * The line shown while a tool installs: "Installing expo-device-hub 0.22.1…",
 * or "Updating expo-device-hub from 0.21.0 to 0.22.1…" when an older one is
 * on disk. Ported from T3 Code's `deviceToolInstallMessage`.
 */
export function deviceToolInstallMessage(name: string, tool: DeviceToolVersion | undefined) {
  if (!tool) return `Installing ${name}…`;
  const previous =
    tool.runningVersion ??
    [...tool.installedVersions].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  return previous && !tool.installedVersions.includes(tool.requiredVersion)
    ? `Updating ${name} from ${previous} to ${tool.requiredVersion}…`
    : `Installing ${name} ${tool.requiredVersion}…`;
}

/** The version to show for a tool: the running one, else the newest on disk. Null when none. */
export function deviceToolShownVersion(tool: DeviceToolVersion | undefined): string | null {
  if (!tool) return null;
  return (
    tool.runningVersion ??
    (tool.installedVersions.includes(tool.requiredVersion)
      ? tool.requiredVersion
      : ([...tool.installedVersions]
          .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
          .at(-1) ?? null))
  );
}

/** A tool on disk that is not the version this server wants. */
export const deviceToolNeedsUpdate = (tool: DeviceToolVersion | undefined) =>
  tool !== undefined &&
  tool.installedVersions.length > 0 &&
  !tool.installedVersions.includes(tool.requiredVersion);

export const isDeviceHostBusy = (state: DeviceServiceState) =>
  state.hostStatus === "installing" || state.hostStatus === "starting";

/** Whether `platform` can be used, and the one line saying why not or what is there. */
export function devicePlatformStatus(
  state: DeviceServiceState,
  platform: DevicePlatform,
): { readonly ready: boolean; readonly message: string } {
  const name = devicePlatformName(platform);
  const availability = state.platforms.find((candidate) => candidate.platform === platform);
  if (!availability || !availability.available) {
    return {
      ready: false,
      message:
        availability?.reason ??
        (platform === "ios"
          ? "iOS Simulators need a Mac with Xcode installed."
          : "Android Emulators need the Android SDK with the emulator installed."),
    };
  }
  const hasDevices = state.devices.some((device) => device.platform === platform);
  if (state.hostStatus === "ready" && !hasDevices) {
    if (state.incompletePlatforms.includes(platform)) {
      return {
        ready: false,
        message: `No ${name} devices were listed because the listing failed. Refresh to try again.`,
      };
    }
    return {
      ready: false,
      message:
        platform === "ios"
          ? "Xcode is installed, but there is no iOS Simulator. Add a runtime in Xcode → Settings → Components."
          : "The Android SDK is installed, but there is no virtual device. Make one in Android Studio → Device Manager.",
    };
  }
  return {
    ready: true,
    message:
      platform === "ios"
        ? "Xcode and the iOS Simulator are installed."
        : "The Android SDK and Emulator are installed.",
  };
}

/** Booted devices first, then by name, grouped by platform (iOS first). */
export function groupDevicesByPlatform(devices: ReadonlyArray<DeviceSummary>) {
  const groups: Array<{ platform: DevicePlatform; devices: DeviceSummary[] }> = [];
  for (const platform of ["ios", "android"] as const) {
    const listed = devices
      .filter((device) => device.platform === platform)
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (listed.length > 0) groups.push({ platform, devices: listed });
  }
  return groups;
}

export const threadDeviceSessions = (
  state: DeviceServiceState,
  threadId: ThreadId,
): ReadonlyArray<DeviceSession> =>
  state.sessions.filter((session) => session.threadId === threadId);

/**
 * Sessions an agent opened for a thread that a previous state did not have:
 * the ones that should bring the Device tab up for whoever is watching. The
 * first state a client sees is not compared: a session already open then did
 * not just appear.
 */
export function newAgentDeviceSessions(
  previous: DeviceServiceState,
  next: DeviceServiceState,
  threadId: ThreadId,
): ReadonlyArray<DeviceSession> {
  const known = new Set(
    previous.sessions
      .filter((session) => session.threadId === threadId)
      .map((session) => `${session.deviceId}\u0000${session.openedAt}`),
  );
  return next.sessions.filter(
    (session) =>
      session.threadId === threadId &&
      session.openedBy === "agent" &&
      !known.has(`${session.deviceId}\u0000${session.openedAt}`),
  );
}
