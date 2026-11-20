import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type DeviceSummary, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { agentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

const threadId = ThreadId.make("thread-devices");
const unused = Effect.die("not used in this test");

/** A host whose one simulator boots when asked, recording the agent sessions it ends. */
const fakeHost = (released: Array<string>) => {
  const device: { current: DeviceSummary } = {
    current: {
      id: "SIM-1",
      platform: "ios",
      name: "iPhone",
      version: "iOS 27.2",
      booted: false,
      physical: false,
    },
  };
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://127.0.0.1:1", token: "token" },
    devices: {
      list: Effect.sync(() => ({
        devices: [device.current],
        detail: undefined,
        incompletePlatforms: [],
      })),
      boot: (target) =>
        Effect.sync(() => {
          device.current = { ...device.current, booted: true };
          return target.id;
        }),
      attach: () => Effect.void,
      shutdown: () => unused,
      screenshot: () => unused,
    },
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  return Layer.mock(DeviceHost.DeviceHost)({
    summary: Effect.succeed({
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
      tools: undefined,
      toolInspectionError: undefined,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    current: Effect.succeed(ready),
    releaseAgentSession: (session) => Effect.sync(() => void released.push(session)),
    stop: Effect.void,
    stopAgent: Effect.void,
  });
};

const settingsLayer = Layer.mock(ServerSettingsService)({
  getSettings: Effect.succeed({ enableDevices: true, agentDeviceAccess: false } as never),
  streamChanges: Stream.never,
});

describe("DeviceService claims", () => {
  it.live("records a session before it is open, reloads it after a restart, and ends it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "tl-device-claims-" });
      const released: Array<string> = [];
      const layer = Layer.mergeAll(
        fakeHost(released),
        settingsLayer,
        ServerConfig.layerTest(process.cwd(), base),
      );
      const claimsPath = path.join(base, "userdata", "device", "claims.json");

      // First server: the user opens a simulator that was off.
      const session = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* DeviceService.make;
          return yield* service.open({ threadId, deviceId: "SIM-1", platform: "ios" }, "user");
        }),
      ).pipe(Effect.provide(layer));
      expect(session).toMatchObject({
        deviceId: "SIM-1",
        bootedByThreadlines: true,
        openedBy: "user",
      });
      expect(yield* fs.readFileString(claimsPath)).toContain("SIM-1");

      // Next server: the claim is a session again, and releasing the thread ends it.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* DeviceService.make;
          expect((yield* service.state).sessions).toEqual([session]);
          yield* service.releaseThread(threadId);
          expect((yield* service.state).sessions).toEqual([]);
        }),
      ).pipe(Effect.provide(layer));
      expect(released).toEqual([agentDeviceSession(threadId, "SIM-1")]);
      expect(yield* fs.readFileString(claimsPath)).not.toContain("SIM-1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("extractPng", () => {
  it("finds one complete PNG and reads its size", () => {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(390, 8);
    ihdr.writeUInt32BE(844, 12);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ihdr,
      Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    ]);
    const extracted = DeviceService.extractPng(Buffer.concat([Buffer.from("noise"), png]));
    expect(extracted?.width).toBe(390);
    expect(extracted?.height).toBe(844);
    expect(extracted?.png.length).toBe(png.length);
    expect(DeviceService.extractPng(png.subarray(0, 30))).toBeUndefined();
  });
});
