// @effect-diagnostics nodeBuiltinImport:off - runs the generated launcher as a real subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  agentDeviceLauncherKey,
  agentDeviceLaunchersDir,
  bindAgentDeviceLauncher,
  pruneAgentDeviceLaunchers,
} from "./AgentDeviceShim.ts";
import { agentDeviceConfigPath, writeAgentDeviceConfig } from "./AgentDeviceTarget.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

/** A loopback port that accepts connections until the scope closes, like the agent-device daemon. */
const listeningPort = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeNet.Server>((resolve) => {
        const server = NodeNet.createServer((socket) => socket.destroy());
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

describe.skipIf(process.platform === "win32")("agent-device launcher", () => {
  it.live(
    "binds one device's flags, refuses override flags, strips Android --serial on cdp, and leaves help alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tl-device-launcher-" });
        const port = yield* listeningPort;
        const entryPath = path.join(dir, "cli.mjs");
        yield* fs.writeFileString(entryPath, "console.log(JSON.stringify(process.argv.slice(2)));");
        const config = agentDeviceConfigPath(path, dir);
        yield* writeAgentDeviceConfig(config, { baseUrl: `http://127.0.0.1:${port}`, token: "t" });
        const target = [
          "--platform",
          "ios",
          "--udid",
          "UDID-1",
          "--config",
          config,
          "--session",
          "tl-a",
        ];
        const command = yield* bindAgentDeviceLauncher({
          stateDir: dir,
          threadId: "thread-1",
          deviceId: "UDID-1",
          node: process.execPath,
          entryPath,
          targetArgs: target,
        });
        expect(command).toBe(
          path.join(agentDeviceLaunchersDir(path, dir), "thread-1", "UDID-1", "agent-device"),
        );
        const launch = (args: ReadonlyArray<string>) =>
          exec(command, [...args]).then((result) => JSON.parse(result.stdout));

        expect(yield* Effect.promise(() => launch(["snapshot", "-i"]))).toEqual([
          "snapshot",
          "-i",
          ...target,
        ]);
        // Override flags are refused so every session stays one Threadlines ends.
        for (const args of [
          ["open", "--session", "mine"],
          ["open", "-s", "mine"],
          ["snapshot", "--udid=OTHER"],
          ["snapshot", "--daemon-base-url", "http://127.0.0.1:9999"],
        ]) {
          yield* Effect.promise(() =>
            expect(launch(args)).rejects.toThrow("bound to one device and its session"),
          );
        }
        // Positional `-h` on text commands is text, not help.
        expect(yield* Effect.promise(() => launch(["fill", "@e5", "-h"]))).toEqual([
          "fill",
          "@e5",
          "-h",
          ...target,
        ]);
        // Android `cdp` strips `--serial` as well as `--platform`/`--config`/`--session`.
        const androidCommand = yield* bindAgentDeviceLauncher({
          stateDir: dir,
          threadId: "thread-1",
          deviceId: "emulator-5554",
          node: process.execPath,
          entryPath,
          targetArgs: [
            "--platform",
            "android",
            "--serial",
            "emulator-5554",
            "--config",
            config,
            "--session",
            "tl-b",
          ],
        });
        const launchAndroid = (args: ReadonlyArray<string>) =>
          exec(androidCommand, [...args]).then((result) => JSON.parse(result.stdout));
        expect(yield* Effect.promise(() => launchAndroid(["cdp", "list"]))).toEqual([
          "cdp",
          "list",
        ]);
        // After `--` everything is text, and bound flags go before it.
        expect(yield* Effect.promise(() => launch(["fill", "@e5", "--", "--help"]))).toEqual([
          "fill",
          "@e5",
          ...target,
          "--",
          "--help",
        ]);
        for (const args of [["help", "gesture"], ["open", "--help"], []]) {
          expect(yield* Effect.promise(() => launch(args))).toEqual(args);
        }
        // Commands that would replace Threadlines' connection are refused.
        yield* Effect.promise(() =>
          expect(launch(["daemon", "stop"])).rejects.toThrow("Threadlines manages this command"),
        );
        // A runtime that moved since device_open names the fix.
        yield* fs.remove(entryPath);
        yield* Effect.promise(() =>
          expect(launch(["snapshot"])).rejects.toThrow("Call device_open again"),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says the device connection is down before running agent-device", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tl-device-launcher-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, "process.exit(3);");
      const port = yield* Effect.scoped(listeningPort);
      const config = agentDeviceConfigPath(path, dir);
      yield* writeAgentDeviceConfig(config, { baseUrl: `http://127.0.0.1:${port}`, token: "t" });
      const command = yield* bindAgentDeviceLauncher({
        stateDir: dir,
        threadId: "thread-1",
        deviceId: "UDID-1",
        node: process.execPath,
        entryPath,
        targetArgs: ["--config", config, "--session", "tl-a"],
      });
      yield* Effect.promise(() =>
        expect(exec(command, ["snapshot"])).rejects.toThrow("is not reachable from this shell"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the launchers of sessions that ended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tl-device-launcher-" });
      for (const [threadId, deviceId] of [
        ["thread-1", "UDID-1"],
        ["thread-1", "Pixel 9"],
        ["thread-2", "UDID-1"],
      ] as const) {
        yield* bindAgentDeviceLauncher({
          stateDir: dir,
          threadId,
          deviceId,
          node: process.execPath,
          entryPath: "/missing.mjs",
          targetArgs: [],
        });
      }
      yield* pruneAgentDeviceLaunchers({
        stateDir: dir,
        live: new Set([agentDeviceLauncherKey("thread-1", "Pixel 9")]),
      });
      const root = agentDeviceLaunchersDir(path, dir);
      expect(yield* fs.readDirectory(root)).toEqual(["thread-1"]);
      expect(yield* fs.readDirectory(path.join(root, "thread-1"))).toEqual([
        agentDeviceLauncherKey("thread-1", "Pixel 9").split("/")[1],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
