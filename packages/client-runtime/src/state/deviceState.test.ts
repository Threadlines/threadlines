import type { DeviceServiceState, DeviceSession, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deviceToolInstallMessage, newAgentDeviceSessions } from "./deviceState.ts";

describe("deviceToolInstallMessage", () => {
  it("says installing for a fresh tool and updating from the old version otherwise", () => {
    expect(
      deviceToolInstallMessage("expo-device-hub", {
        requiredVersion: "0.22.1",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing expo-device-hub 0.22.1…");
    expect(
      deviceToolInstallMessage("expo-device-hub", {
        requiredVersion: "0.22.1",
        installedVersions: ["0.9.0", "0.21.0"],
        runningVersion: null,
      }),
    ).toBe("Updating expo-device-hub from 0.21.0 to 0.22.1…");
  });
});

describe("newAgentDeviceSessions", () => {
  const thread = "thread-1" as ThreadId;
  const session = (deviceId: string, openedBy: "user" | "agent"): DeviceSession => ({
    threadId: thread,
    deviceId,
    platform: "ios",
    openedAt: "2026-11-20T00:00:00.000Z",
    bootedByThreadlines: false,
    openedBy,
  });
  const state = (sessions: DeviceSession[]) => ({ sessions }) as unknown as DeviceServiceState;

  it("finds only agent sessions this thread did not have before", () => {
    const before = state([session("A", "agent")]);
    const after = state([
      session("A", "agent"),
      session("B", "user"),
      session("C", "agent"),
      { ...session("D", "agent"), threadId: "other" as ThreadId },
    ]);
    expect(newAgentDeviceSessions(before, after, thread).map((s) => s.deviceId)).toEqual(["C"]);
  });
});
