/**
 * This machine as a device host (docs/design/devices.md). Ported from T3
 * Code's LocalDeviceHost.
 *
 * The hub runs as a supervised child on a loopback port, with
 * `--require-token`: it prints a session token once in its startup line, the
 * server keeps it in memory and sends it as a bearer on every request, and
 * every hub route but its health checks refuses requests without it. A second
 * Threadlines server, an older release, or anything else on loopback cannot
 * use this hub.
 *
 * `<stateDir>/device/hub.json` records `{pid, port, entryPath}` so the next
 * server stops a hub this one left behind, checked by pid and command line,
 * never by name. agent-device's daemon is started by its own CLI (the pid we
 * spawn is the CLI's, not the daemon's) and stopped through the CLI's own stop
 * command with our isolated state folder.
 */
import * as OS from "node:os";

import type { DevicePlatform, DevicePlatformAvailability } from "@threadlines/contracts";
import { isCommandAvailable } from "@threadlines/shared/shell";
import * as NetService from "@threadlines/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import { setOwnDeviceToolPort } from "../preview/deviceToolPorts.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations, makeDeviceModelCache } from "./DeviceHubOperations.ts";
import {
  AGENT_DEVICE_VERSION,
  agentDeviceStateDir,
  DEVICE_HUB_VERSION,
  type DeviceToolchainInstallError,
  type DeviceToolPaths,
  deviceStateDir,
  deviceToolVersions,
  ensureDeviceTool,
  installedAgentDeviceEntry,
  isDeviceToolInstalled,
  leaseDeviceNode,
  pruneDeviceTool,
} from "./DeviceToolchain.ts";

const HUB_READY_TIMEOUT_MS = 30_000;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 100;
const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
const HUB_RESTART_MAX_DELAY_MS = 30_000;

const HubStateFile = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  entryPath: Schema.String,
});
const decodeHubStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(HubStateFile));
const encodeHubStateFile = Schema.encodeUnknownEffect(Schema.fromJsonString(HubStateFile));

const AgentDeviceDaemonFile = Schema.Struct({
  httpPort: Schema.Int,
  token: Schema.String,
  pid: Schema.optional(Schema.Int),
  version: Schema.optional(Schema.String),
});
const decodeDaemonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceDaemonFile));

/**
 * The hub's startup line with `--require-token` (expo-device-hub 0.22.1,
 * `startupMessage` in its cli.mjs): `  Local:   http://localhost:<port>/?token=<token>`.
 * The token is 32 random bytes in base64url.
 */
export const parseHubStartupLine = (
  line: string,
): { readonly port: number; readonly token: string } | null => {
  const match = /^\s*Local:\s+http:\/\/localhost:(\d+)\/\?token=([A-Za-z0-9_-]{16,})\s*$/.exec(
    line,
  );
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? { port, token: match[2]! } : null;
};

/** A hub output line with any token in it hidden, for the log. */
const redactHubLine = (line: string) => line.replace(/token=[A-Za-z0-9_-]+/g, "token=<hidden>");

interface HubProcess {
  readonly nodePath: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  /** Holds the child and the lease on the managed Node.js it runs on. */
  readonly scope: Scope.Closeable;
  readonly origin: string;
  readonly token: string;
  readonly startedAtMillis: number;
}

interface RunningHost {
  readonly hub: HubProcess;
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint | null;
  readonly helpers: DeviceHost.DeviceHostReady["helpers"];
}

interface AndroidSdk {
  readonly root: string | null;
  readonly adb: boolean;
  readonly emulator: boolean;
  readonly avdmanager: boolean;
  readonly legacyAvdmanager: boolean;
}

/** Where the Android SDK is, the way Android Studio and the hub look for it. */
export const findAndroidSdk = Effect.fn("LocalDeviceHost.findAndroidSdk")(function* (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = platform === "win32";
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const explicit = [environment.ANDROID_HOME?.trim(), environment.ANDROID_SDK_ROOT?.trim()].filter(
    (root): root is string => !!root,
  );
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const adbBinary = windows ? "adb.exe" : "adb";
  const avdmanagerBinary = windows ? "avdmanager.bat" : "avdmanager";
  const inspect = Effect.fnUntraced(function* (root: string) {
    const adb = yield* exists(path.join(root, "platform-tools", adbBinary));
    const emulator = yield* exists(
      path.join(root, "emulator", windows ? "emulator.exe" : "emulator"),
    );
    const avdmanager = yield* exists(
      path.join(root, "cmdline-tools", "latest", "bin", avdmanagerBinary),
    );
    const legacyAvdmanager =
      !avdmanager && (yield* exists(path.join(root, "tools", "bin", avdmanagerBinary)));
    return { root, adb, emulator, avdmanager, legacyAvdmanager } satisfies AndroidSdk;
  });
  const candidates = [
    ...explicit,
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
    path.join(environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk"),
  ];
  for (const root of candidates) {
    const sdk = yield* inspect(root);
    if (sdk.adb || sdk.emulator) return sdk;
  }
  // PATH entries can be slow to stat (network shares), so only after the standard places miss.
  const searchPath = environment.PATH ?? environment.Path ?? "";
  for (const directory of searchPath.split(windows ? ";" : ":")) {
    if (!directory) continue;
    const adb = path.join(directory, adbBinary);
    if (!(yield* exists(adb))) continue;
    const resolved = yield* fs.realPath(adb).pipe(Effect.orElseSucceed(() => adb));
    const sdk = yield* inspect(path.dirname(path.dirname(resolved)));
    if (sdk.adb || sdk.emulator) return sdk;
  }
  // No real SDK anywhere: report what the configured root is missing.
  if (explicit[0]) return yield* inspect(explicit[0]);
  return {
    root: null,
    adb: false,
    emulator: false,
    avdmanager: false,
    legacyAvdmanager: false,
  } satisfies AndroidSdk;
});

/** Why a platform can't run here, in words the user can act on, or null when it can. */
export const platformReason = (
  platform: DevicePlatform,
  hostPlatform: NodeJS.Platform,
  sdk: AndroidSdk,
  hasXcrun: boolean,
): string | null => {
  if (platform === "ios") {
    if (hostPlatform !== "darwin") return "iOS Simulators need macOS with Xcode.";
    if (!hasXcrun) return "Xcode command line tools were not found.";
    return null;
  }
  if (!sdk.root)
    return "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK folder.";
  if (!sdk.adb)
    return `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  if (!sdk.emulator)
    return `Android Emulator is missing from ${sdk.root}. Install it in Android Studio's SDK Manager.`;
  if (!sdk.avdmanager) {
    if (sdk.legacyAvdmanager)
      return `The Android SDK command-line tools in ${sdk.root} are an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.`;
    return `Android SDK Command-line Tools (latest) are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  }
  return null;
};

/** The environment device tools run in: the SDK's tools first on PATH. */
const deviceHostEnvironment = (
  environment: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  hostPlatform: NodeJS.Platform,
  path: Path.Path,
): NodeJS.ProcessEnv => {
  const { NODE_OPTIONS: _nodeOptions, ...rest } = environment;
  return sdkRoot
    ? {
        ...rest,
        ANDROID_HOME: sdkRoot,
        PATH: [
          path.join(sdkRoot, "platform-tools"),
          path.join(sdkRoot, "emulator"),
          environment.PATH ?? environment.Path ?? "",
        ].join(hostPlatform === "win32" ? ";" : ":"),
      }
    : rest;
};

/** Only a Mac can list Apple simulators; elsewhere the hub's attempt surfaces as an error. */
const hubPlatformArguments = (hostPlatform: NodeJS.Platform) =>
  hostPlatform === "darwin" ? [] : ["--platform", "android"];

/** The hub's arguments: loopback only, token required, no device list or boot controls of its own. */
export const hubArguments = (entryPath: string, port: number, hostPlatform: NodeJS.Platform) => [
  entryPath,
  "--port",
  String(port),
  "--host",
  "127.0.0.1",
  "--require-token",
  "--hide-sidebar",
  "--hide-boot-device",
  ...hubPlatformArguments(hostPlatform),
];

const isProcessAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/** Where the emulator keeps AVDs: `ANDROID_AVD_HOME`, `ANDROID_USER_HOME/avd`, or `~/.android/avd`. */
const androidAvdHome = (environment: NodeJS.ProcessEnv, path: Path.Path) =>
  environment.ANDROID_AVD_HOME?.trim() ||
  path.join(environment.ANDROID_USER_HOME?.trim() || path.join(OS.homedir(), ".android"), "avd");

const hostError =
  (step: string, detail?: string) =>
  (cause: unknown): DeviceHost.DeviceHostError =>
    new DeviceHost.DeviceHostError({ step, ...(detail ? { detail } : {}), cause });

const installFailure = (step: string) => (cause: DeviceToolchainInstallError) =>
  new DeviceHost.DeviceHostError({ step, detail: cause.message, cause });

export const make = Effect.fn("LocalDeviceHost.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const net = yield* NetService.NetService;
  const runner = yield* ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = process.env;
  const hostPlatform = process.platform;
  const stateDir = config.stateDir;
  const services = Effect.provideService(FileSystem.FileSystem, fs);
  const withPath = Effect.provideService(Path.Path, path);

  // Resolved per use: an SDK installed after the server started is found without a restart.
  const currentSdk = findAndroidSdk(environment, hostPlatform).pipe(services, withPath);
  const currentHostEnvironment = currentSdk.pipe(
    Effect.map((sdk) => deviceHostEnvironment(environment, sdk.root, hostPlatform, path)),
  );
  const startLock = yield* Semaphore.make(1);
  const runningRef = yield* Ref.make<RunningHost | null>(null);
  const restartDelayRef = yield* Ref.make(0);
  const hubStatePath = path.join(deviceStateDir(path, stateDir), "hub.json");
  const daemonFilePath = path.join(agentDeviceStateDir(path, stateDir), "daemon.json");

  const platformAvailability = Effect.fn("LocalDeviceHost.platformAvailability")(function* (
    platform: DevicePlatform,
  ): Effect.fn.Return<DevicePlatformAvailability> {
    const sdk = yield* currentSdk;
    const hasXcrun = platform === "ios" && hostPlatform === "darwin" && isCommandAvailable("xcrun");
    const reason = platformReason(platform, hostPlatform, sdk, hasXcrun);
    return reason === null ? { platform, available: true } : { platform, available: false, reason };
  });

  const readDaemonFile = fs
    .readFileString(daemonFilePath)
    .pipe(Effect.flatMap(decodeDaemonFile), Effect.option);

  const summary: DeviceHost.DeviceHost["Service"]["summary"] = Effect.gen(function* () {
    const [platforms, hubInstalled, agentDeviceInstalled] = yield* Effect.all([
      Effect.all([platformAvailability("ios"), platformAvailability("android")]),
      isDeviceToolInstalled(stateDir, "hub").pipe(services, withPath),
      isDeviceToolInstalled(stateDir, "agent").pipe(services, withPath),
    ]);
    const running = yield* Ref.get(runningRef);
    const hubAlive = running
      ? yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false))
      : false;
    const daemon = running?.agentDevice ? yield* readDaemonFile : Option.none();
    const agentAlive =
      Option.isSome(daemon) && daemon.value.pid ? yield* isProcessAlive(daemon.value.pid) : false;
    const tools = yield* deviceToolVersions(stateDir, {
      ...(hubAlive ? { hub: DEVICE_HUB_VERSION } : {}),
      ...(agentAlive && Option.isSome(daemon) && daemon.value.version
        ? { agent: daemon.value.version }
        : {}),
    }).pipe(services, withPath, Effect.option);
    return {
      platforms,
      hubInstalled,
      agentDeviceInstalled,
      tools: Option.getOrUndefined(tools),
      toolInspectionError: Option.isNone(tools)
        ? "Could not read which device tool versions are installed."
        : undefined,
    };
  });

  const stopHub = (hub: HubProcess | undefined) =>
    hub ? Scope.close(hub.scope, Exit.void).pipe(Effect.ignore) : Effect.void;

  const commandLineOf = (pid: number) =>
    runner
      .run({
        command: "ps",
        args: ["-o", "command=", "-p", String(pid)],
        timeout: Duration.seconds(5),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.orElseSucceed(() => ""),
      );

  // A previous server's hub, stopped only if the recorded pid still runs the recorded entry:
  // the pid may have been reused by anything since.
  const reapStaleHub = Effect.gen(function* () {
    const previous = yield* fs
      .readFileString(hubStatePath)
      .pipe(Effect.flatMap(decodeHubStateFile), Effect.option);
    if (Option.isNone(previous)) return;
    const { pid, port, entryPath } = previous.value;
    if (hostPlatform !== "win32" && (yield* isProcessAlive(pid))) {
      if ((yield* commandLineOf(pid)).includes(entryPath)) {
        yield* Effect.logWarning("Stopping a device hub left behind by a previous server", {
          pid,
          port,
        });
        yield* Effect.sync(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        });
      }
    }
    yield* fs.remove(hubStatePath, { force: true }).pipe(Effect.ignore);
  }).pipe(Effect.ignoreCause);

  const recordHub = (hub: HubProcess, hubTool: DeviceToolPaths) =>
    encodeHubStateFile({
      pid: Number(hub.child.pid),
      port: Number(new URL(hub.origin).port),
      entryPath: hubTool.entryPath,
    }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: hubStatePath, contents })),
      services,
      withPath,
      Effect.ignore,
    );

  const waitForReady = (origin: string) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + HUB_READY_TIMEOUT_MS;
      while (true) {
        const ok = yield* httpClient
          .pipe(HttpClient.withScope)
          .get(`${origin}/readyz`)
          .pipe(
            Effect.flatMap((response) =>
              response.arrayBuffer.pipe(Effect.as(response.status === 200)),
            ),
            Effect.scoped,
            Effect.timeout(Duration.seconds(2)),
            Effect.orElseSucceed(() => false),
          );
        if (ok) return;
        if ((yield* Clock.currentTimeMillis) > deadline) {
          return yield* new DeviceHost.DeviceHostError({
            step: "waiting for the device hub to answer",
            detail: `The device hub did not become ready within ${HUB_READY_TIMEOUT_MS / 1000} seconds.`,
          });
        }
        yield* Effect.sleep(Duration.millis(200));
      }
    });

  const hubEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...base,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    // The hub writes `server-<port>.json` there; keep it out of the shared temp folder.
    EXPO_DEVICE_HUB_STATE_DIR: path.join(deviceStateDir(path, stateDir), "hub-state"),
  });

  const spawnHub = Effect.fn("LocalDeviceHost.spawnHub")(function* (hubTool: DeviceToolPaths) {
    yield* reapStaleHub;
    yield* fs
      .makeDirectory(deviceStateDir(path, stateDir), { recursive: true })
      .pipe(Effect.ignore);
    const reserved = yield* net
      .reserveLoopbackPort("127.0.0.1")
      .pipe(Effect.mapError(hostError("reserving a port for the device hub")));
    const scope = yield* Scope.make("sequential");
    // Not recorded yet: stop it on failure or interruption from the spawn on.
    return yield* Effect.gen(function* () {
      const node = yield* leaseDeviceNode(stateDir).pipe(
        Effect.provideService(Scope.Scope, scope),
        services,
        withPath,
        Effect.mapError(installFailure("preparing Node.js")),
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(node.node, hubArguments(hubTool.entryPath, reserved, hostPlatform), {
            cwd: deviceStateDir(path, stateDir),
            detached: false,
            shell: false,
            stdout: "pipe",
            stderr: "pipe",
            env: hubEnvironment(yield* currentHostEnvironment),
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(hostError("starting the device hub")),
        );
      const startedAtMillis = yield* Clock.currentTimeMillis;
      const started = yield* Deferred.make<{ readonly port: number; readonly token: string }>();
      yield* Effect.forkIn(observeHubOutput(child, started), scope);
      const announced = yield* Deferred.await(started).pipe(
        Effect.timeoutOption(Duration.millis(HUB_READY_TIMEOUT_MS)),
      );
      if (Option.isNone(announced)) {
        return yield* new DeviceHost.DeviceHostError({
          step: "waiting for the device hub to start",
          detail: "The device hub did not print its startup line. Update it in Settings → Devices.",
        });
      }
      const origin = `http://127.0.0.1:${announced.value.port}`;
      yield* waitForReady(origin);
      const hub: HubProcess = {
        child,
        scope,
        origin,
        token: announced.value.token,
        startedAtMillis,
        nodePath: node.node,
      };
      yield* recordHub(hub, hubTool);
      // The preview tunnel refuses this port while the hub has it, on every platform.
      setOwnDeviceToolPort("hub", announced.value.port);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => setOwnDeviceToolPort("hub", null, announced.value.port)),
      );
      yield* Effect.logInfo("Device hub started", {
        pid: Number(child.pid),
        port: announced.value.port,
      });
      return hub;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  const observeHubOutput = (
    child: ChildProcessSpawner.ChildProcessHandle,
    started: Deferred.Deferred<{ readonly port: number; readonly token: string }>,
  ) =>
    child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const startup = parseHubStartupLine(line);
          if (startup) {
            yield* Deferred.succeed(started, startup);
            return;
          }
          const text = line.trim();
          if (text.length > 0) {
            yield* Effect.logDebug("Device hub output", {
              pid: Number(child.pid),
              output: redactHubLine(text),
            });
          }
        }),
      ),
      Effect.ignoreCause,
    );

  // Waits for the hub's lifetime and starts a replacement with backoff; a span would nest across restarts.
  const superviseHub: (hub: HubProcess, hubTool: DeviceToolPaths) => Effect.Effect<void> =
    Effect.fnUntraced(
      function* (hub: HubProcess, hubTool: DeviceToolPaths) {
        yield* Effect.result(hub.child.exitCode);
        const running = yield* Ref.get(runningRef);
        if (running?.hub.child.pid !== hub.child.pid) return;
        const uptime = (yield* Clock.currentTimeMillis) - hub.startedAtMillis;
        const delay = yield* Ref.modify(restartDelayRef, (current) => {
          if (uptime >= HUB_RESTART_STABLE_UPTIME_MS) return [0, 0];
          const next = current === 0 ? 1_000 : Math.min(current * 2, HUB_RESTART_MAX_DELAY_MS);
          return [current, next];
        });
        yield* Effect.logWarning("Device hub exited; restarting", {
          pid: Number(hub.child.pid),
          delayMs: delay,
        });
        yield* stopHub(hub);
        yield* Effect.sleep(Duration.millis(delay));
        yield* startLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(runningRef);
            if (current?.hub.child.pid !== hub.child.pid) return;
            const replacement = yield* spawnHub(hubTool);
            yield* Ref.set(runningRef, { ...current, hub: replacement });
            yield* Effect.forkDetach(superviseHub(replacement, hubTool));
          }),
        );
      },
      Effect.catchCause((cause) => Effect.logWarning("Device hub supervisor failed", { cause })),
    );

  /** Every process's command line, for keeping tool versions a running process uses. */
  const runningCommandLines = runner
    .run({
      command: "ps",
      args: ["-ax", "-o", "command="],
      timeout: Duration.seconds(10),
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(
      Effect.map((result) => (result.code === 0 && !result.timedOut ? result.stdout : null)),
      Effect.orElseSucceed(() => null),
    );

  const pruneTool = (tool: "hub" | "agent") =>
    hostPlatform === "win32"
      ? Effect.void
      : pruneDeviceTool(stateDir, tool, runningCommandLines).pipe(
          services,
          withPath,
          Effect.ignore,
        );

  const daemonEnvironment = Effect.gen(function* () {
    return {
      ...(yield* currentHostEnvironment),
      AGENT_DEVICE_STATE_DIR: agentDeviceStateDir(path, stateDir),
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      // No five-minute idle timeout: the server owns shutdown.
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    } satisfies NodeJS.ProcessEnv;
  });

  const startAgentDeviceDaemon = Effect.fn("LocalDeviceHost.startAgentDeviceDaemon")(function* (
    entryPath: string,
    nodePath: string,
  ) {
    yield* fs
      .makeDirectory(agentDeviceStateDir(path, stateDir), { recursive: true })
      .pipe(Effect.ignore);
    const toEndpoint = (
      file: typeof AgentDeviceDaemonFile.Type,
    ): DeviceHost.AgentDeviceEndpoint => {
      // The preview tunnel refuses the daemon's port too (forgotten when it is stopped).
      setOwnDeviceToolPort("agent", file.httpPort);
      return { baseUrl: `http://127.0.0.1:${file.httpPort}`, token: file.token, entryPath };
    };
    const existing = yield* readDaemonFile;
    if (Option.isSome(existing) && existing.value.version !== AGENT_DEVICE_VERSION) {
      // An earlier server's daemon on another pin: stop it with its own CLI and start ours.
      yield* stopAgentDeviceDaemon;
    } else if (Option.isSome(existing)) {
      const alive = yield* httpClient
        .pipe(HttpClient.withScope)
        .get(`http://127.0.0.1:${existing.value.httpPort}/health`)
        .pipe(
          Effect.timeout(Duration.seconds(2)),
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(Effect.as(response.status === 200)),
          ),
          Effect.scoped,
          Effect.orElseSucceed(() => false),
        );
      if (alive) return toEndpoint(existing.value);
      yield* fs.remove(daemonFilePath, { force: true }).pipe(Effect.ignore);
    }
    // agent-device has no `daemon start`; `devices` is the cheapest command that starts and awaits it.
    const runResult = yield* runner
      .run({
        command: nodePath,
        args: [entryPath, "devices", "--json"],
        env: yield* daemonEnvironment,
        timeout: Duration.millis(DAEMON_READY_TIMEOUT_MS),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    // Discovery may fail after startup; a published endpoint is enough.
    const started = yield* readDaemonFile;
    if (Option.isSome(started)) return toEndpoint(started.value);
    if (runResult._tag === "Failure") {
      return yield* hostError("starting agent tools")(runResult.failure);
    }
    if (runResult.success.timedOut) {
      return yield* new DeviceHost.DeviceHostError({
        step: "starting agent tools",
        detail: `Agent tools did not start within ${DAEMON_READY_TIMEOUT_MS / 1000} seconds.`,
      });
    }
    if (runResult.success.code !== 0) {
      return yield* new DeviceHost.DeviceHostError({
        step: "starting agent tools",
        detail: `agent-device could not start (exit code ${runResult.success.code}). Its log is in ${agentDeviceStateDir(path, stateDir)}.`,
      });
    }
    const deadline = (yield* Clock.currentTimeMillis) + DAEMON_READY_TIMEOUT_MS;
    while (true) {
      const file = yield* readDaemonFile;
      if (Option.isSome(file)) return toEndpoint(file.value);
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new DeviceHost.DeviceHostError({
          step: "starting agent tools",
          detail: `Agent tools did not start within ${DAEMON_READY_TIMEOUT_MS / 1000} seconds.`,
        });
      }
      yield* Effect.sleep(Duration.millis(DAEMON_POLL_MS));
    }
  });

  // The daemon may predate this process (an earlier server was killed, possibly on an
  // older pin), so it is stopped with the CLI of its recorded version when that is installed.
  const stopAgentDeviceDaemon = Effect.gen(function* () {
    setOwnDeviceToolPort("agent", null);
    if (!(yield* fs.exists(daemonFilePath).pipe(Effect.orElseSucceed(() => false)))) return;
    const recorded = yield* readDaemonFile;
    if (
      Option.isSome(recorded) &&
      recorded.value.pid &&
      !(yield* isProcessAlive(recorded.value.pid))
    ) {
      return yield* fs.remove(daemonFilePath, { force: true });
    }
    const entryPath = yield* installedAgentDeviceEntry(stateDir, [
      ...(Option.isSome(recorded) && recorded.value.version ? [recorded.value.version] : []),
      AGENT_DEVICE_VERSION,
    ]).pipe(withPath, services);
    if (!entryPath) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const node = yield* leaseDeviceNode(stateDir).pipe(services, withPath);
        yield* runner.run({
          command: node.node,
          args: [entryPath, "daemon", "stop", "--state-dir", agentDeviceStateDir(path, stateDir)],
          env: { ...(yield* currentHostEnvironment), AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
          timeout: Duration.seconds(10),
          timeoutBehavior: "timedOutResult",
        });
      }),
    );
  }).pipe(Effect.ignore);

  const serveSimHelpers = Effect.fn("LocalDeviceHost.serveSimHelpers")(function* (
    hubTool: DeviceToolPaths,
  ) {
    const serveSimDist = path.join(
      hubTool.installDir,
      "node_modules",
      "expo-device-hub",
      "vendor",
      "serve-sim",
      "dist",
    );
    const candidate = {
      serveSimAxSettings: path.join(serveSimDist, "simax", "serve-sim-ax-settings"),
      serveSimCli: path.join(serveSimDist, "serve-sim.js"),
    };
    const [axExists, cliExists] = yield* Effect.all([
      fs.exists(candidate.serveSimAxSettings).pipe(Effect.orElseSucceed(() => false)),
      fs.exists(candidate.serveSimCli).pipe(Effect.orElseSucceed(() => false)),
    ]);
    return {
      serveSimAxSettings: axExists ? candidate.serveSimAxSettings : null,
      serveSimCli: cliExists ? candidate.serveSimCli : null,
    };
  });

  const ensureHubReady = Effect.fn("LocalDeviceHost.ensureHubReady")(function* (
    onPhase: (phase: DeviceHost.DeviceHostPhase, detail?: string) => Effect.Effect<void>,
  ) {
    const running = yield* Ref.get(runningRef);
    // A dead hub's record stays until a replacement is published: the agent
    // daemon outlives the hub, and close needs its endpoint if the restart fails.
    if (running) {
      const alive = yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (alive) return running;
    }
    if (!(yield* isDeviceToolInstalled(stateDir, "hub").pipe(services, withPath))) {
      yield* onPhase("installing", `Installing the device hub ${DEVICE_HUB_VERSION}…`);
    }
    const { paths: hubTool } = yield* Effect.scoped(
      ensureDeviceTool(stateDir, "hub").pipe(
        services,
        withPath,
        Effect.mapError(installFailure("installing device support")),
      ),
    );
    yield* onPhase("starting");
    const hub = yield* spawnHub(hubTool);
    const next = yield* Effect.gen(function* () {
      const nextRunning: RunningHost = {
        hub,
        agentDevice: running?.agentDevice ?? null,
        helpers: yield* serveSimHelpers(hubTool),
      };
      yield* Ref.set(runningRef, nextRunning);
      return nextRunning;
    }).pipe(Effect.onError(() => stopHub(hub)));
    if (running) yield* stopHub(running.hub);
    yield* Ref.set(restartDelayRef, 0);
    yield* Effect.forkDetach(superviseHub(hub, hubTool));
    yield* pruneTool("hub").pipe(Effect.forkDetach);
    return next;
  });

  const run: DeviceHost.DeviceHostReady["run"] = (command, args, options) =>
    currentSdk.pipe(
      Effect.flatMap((sdk) =>
        runner.run({
          command:
            command === "emulator" && sdk.root
              ? path.join(
                  sdk.root,
                  "emulator",
                  hostPlatform === "win32" ? "emulator.exe" : "emulator",
                )
              : command,
          args,
          env: deviceHostEnvironment(environment, sdk.root, hostPlatform, path),
          timeout: Duration.millis(options?.timeoutMs ?? 20_000),
          timeoutBehavior: "timedOutResult",
          ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options?.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: options.maxOutputBytes }),
        }),
      ),
      Effect.map((result) => ({
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.timedOut ? 124 : Number(result.code ?? 127),
      })),
      Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: String(cause), code: 127 })),
    );

  // Outlives each hub start, so refreshing the picker does not run simctl or adb again.
  const modelCache = makeDeviceModelCache();
  const toReady = (running: RunningHost): DeviceHost.DeviceHostReady => ({
    hub: { origin: running.hub.origin, token: running.hub.token },
    devices: makeDeviceHubOperations({
      origin: running.hub.origin,
      token: running.hub.token,
      http: httpClient,
      run,
      platformAvailable: (platform) =>
        platformAvailability(platform).pipe(Effect.map((availability) => availability.available)),
      scratchDir: path.join(deviceStateDir(path, stateDir), "tmp"),
      modelCache,
      androidAvds: {
        home: androidAvdHome(environment, path),
        readTextFile: (file) =>
          fs.readFileString(file).pipe(
            Effect.map((text) => (text.length > 256 * 1024 ? undefined : text)),
            Effect.orElseSucceed(() => undefined),
          ),
      },
    }),
    nodePath: running.hub.nodePath,
    run,
    helpers: running.helpers,
    ...(running.agentDevice
      ? { releaseAgentSession: releaseAgentDeviceSession(httpClient, running.agentDevice) }
      : {}),
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    startLock.withPermits(1)(ensureHubReady(onPhase).pipe(Effect.map(toReady)));

  const ensureAgentReady: DeviceHost.DeviceHost["Service"]["ensureAgentReady"] = (onPhase) =>
    startLock.withPermits(1)(
      Effect.gen(function* () {
        const running = yield* ensureHubReady(onPhase);
        if (!(yield* isDeviceToolInstalled(stateDir, "agent").pipe(services, withPath))) {
          yield* onPhase("installing", `Installing agent tools ${AGENT_DEVICE_VERSION}…`);
        }
        const { paths: agentTool } = yield* Effect.scoped(
          ensureDeviceTool(stateDir, "agent").pipe(
            services,
            withPath,
            Effect.mapError(installFailure("installing agent tools")),
          ),
        );
        if (!running.agentDevice) yield* onPhase("starting");
        const agentDevice = yield* startAgentDeviceDaemon(
          agentTool.entryPath,
          running.hub.nodePath,
        );
        const next = { ...running, agentDevice };
        yield* Ref.set(runningRef, next);
        yield* pruneTool("agent").pipe(Effect.forkDetach);
        return { ...toReady(next), agentDevice };
      }),
    );

  const current: DeviceHost.DeviceHost["Service"]["current"] = Ref.get(runningRef).pipe(
    Effect.map((running) => (running ? toReady(running) : null)),
  );

  const releaseAgentSession: DeviceHost.DeviceHost["Service"]["releaseAgentSession"] = (session) =>
    Effect.gen(function* () {
      const running = yield* Ref.get(runningRef);
      const endpoint =
        running?.agentDevice ??
        (yield* readDaemonFile.pipe(
          Effect.map((file) =>
            Option.isSome(file)
              ? { baseUrl: `http://127.0.0.1:${file.value.httpPort}`, token: file.value.token }
              : null,
          ),
        ));
      if (!endpoint) return true;
      yield* releaseAgentDeviceSession(httpClient, endpoint)(session);
      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not end the agent-device session", { session, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const stopAgent: DeviceHost.DeviceHost["Service"]["stopAgent"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      yield* stopAgentDeviceDaemon;
      yield* Ref.update(runningRef, (running) =>
        running ? { ...running, agentDevice: null } : running,
      );
    }),
  );

  const stop: DeviceHost.DeviceHost["Service"]["stop"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      const running = yield* Ref.getAndSet(runningRef, null);
      // Hub cleanup waits for its exit; it must not strand the detached agent daemon.
      yield* Effect.all(
        [
          stopHub(running?.hub).pipe(
            Effect.andThen(fs.remove(hubStatePath, { force: true }).pipe(Effect.ignore)),
          ),
          stopAgentDeviceDaemon,
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  /**
   * Installs the pinned version (a repair when its files went missing). The
   * hub always starts on the pinned version; a daemon an earlier server left
   * running on an older pin is restarted on this one.
   */
  const updateTool: DeviceHost.DeviceHost["Service"]["updateTool"] = (tool) =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        ensureDeviceTool(stateDir, tool).pipe(
          services,
          withPath,
          Effect.mapError(
            installFailure(tool === "hub" ? "updating the device hub" : "updating agent tools"),
          ),
        ),
      );
      if (tool !== "agent") return;
      const running = yield* Ref.get(runningRef);
      if (!running?.agentDevice) return;
      const daemon = yield* readDaemonFile;
      if (Option.isSome(daemon) && daemon.value.version === AGENT_DEVICE_VERSION) return;
      yield* stopAgent;
      yield* ensureAgentReady(() => Effect.void);
    });

  yield* Effect.addFinalizer(() => stop);

  return DeviceHost.DeviceHost.of({
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady,
    updateTool,
    current,
    releaseAgentSession,
    stopAgent,
    stop,
  });
});

export const layer = Layer.effect(DeviceHost.DeviceHost, make());
