/**
 * Simulators and emulators on this server's machine (docs/design/devices.md).
 * Ported from T3 Code's DeviceService with one host per server.
 *
 * Owns the state clients subscribe to (`DeviceServiceState`), the sessions
 * threads hold on devices, and the agent's way in (`agentOpen`). Nothing
 * installs or starts until a client or an agent asks, and only after the
 * matching setting: the hub after "Use devices", agent-device after "Agents
 * can use devices".
 *
 * Sessions survive a crash. `<stateDir>/device/claims.json` records each one
 * before it is reported open and drops it on close; the next server loads
 * them back, and DeviceThreadReactor releases those whose thread was put away
 * while it was down. Closing never shuts a device down unless asked: a
 * simulator the user booted is theirs.
 */
import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  DeviceHostUnavailableError,
  type DeviceId,
  DeviceNotFoundError,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  DeviceSession,
  type DeviceShutdownInput,
  type DeviceSummary,
  type ThreadId,
} from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import {
  agentDeviceLauncherKey,
  bindAgentDeviceLauncher,
  pruneAgentDeviceLaunchers,
} from "./AgentDeviceShim.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { deviceStateDir } from "./DeviceToolchain.ts";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";

export interface DeviceScreenshot {
  readonly device: DeviceSummary;
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** What `device_open` hands an agent: the device and the launcher bound to it. */
export interface DeviceAgentOpened {
  readonly device: DeviceSummary;
  readonly session: DeviceSession;
  /** Absolute path of the `agent-device` launcher for this thread and device. */
  readonly command: string;
  readonly agentSession: string;
}

/** A session as claims.json keeps it: with the agent-device session it may hold. */
const DeviceClaim = Schema.Struct({
  ...DeviceSession.fields,
  agentSession: Schema.String,
});
type DeviceClaim = typeof DeviceClaim.Type;
const ClaimsFile = Schema.Struct({
  version: Schema.Literal(1),
  claims: Schema.Array(DeviceClaim),
  /** agent-device sessions whose close the daemon did not confirm: tried again later. */
  pendingReleases: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>)),
  ),
});
const decodeClaimsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaimsFile));
const encodeClaimsFile = Schema.encodeUnknownEffect(Schema.fromJsonString(ClaimsFile));

export interface DeviceServiceShape {
  readonly state: Effect.Effect<DeviceServiceState>;
  /** The state now and after every change. */
  readonly stream: Stream.Stream<DeviceServiceState>;
  /** The devices; with `refresh`, asks the hub again (starting it). */
  readonly list: (input: {
    readonly refresh?: boolean | undefined;
  }) => Effect.Effect<DeviceServiceState, DeviceError>;
  readonly updateTool: (tool: "hub" | "agent") => Effect.Effect<DeviceServiceState, DeviceError>;
  readonly open: (
    input: DeviceOpenInput,
    openedBy?: "user" | "agent",
  ) => Effect.Effect<DeviceSession, DeviceError>;
  readonly close: (input: DeviceCloseInput) => Effect.Effect<void, DeviceError>;
  readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
  readonly detail: (input: DeviceDetailInput) => Effect.Effect<DeviceDetail, DeviceError>;
  readonly action: (input: DeviceActionInput) => Effect.Effect<DeviceDetail, DeviceError>;
  readonly screenshot: (deviceId: DeviceId) => Effect.Effect<DeviceScreenshot, DeviceError>;
  /**
   * An agent opens a device: agent tools readied, the device opened for the
   * thread (`openedBy: "agent"`), and a launcher bound to them.
   */
  readonly agentOpen: (input: {
    readonly threadId: ThreadId;
    readonly deviceId: DeviceId;
    readonly platform: DevicePlatform;
    /** Skip the initial listing when the caller just refreshed devices. */
    readonly alreadyListed?: boolean;
  }) => Effect.Effect<DeviceAgentOpened, DeviceError>;
  /** Every session a thread holds, oldest first. */
  readonly sessionsForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeviceSession>>;
  /** The running hub, for the device channel. Never starts it. */
  readonly currentHub: Effect.Effect<DeviceHost.DeviceHubEndpoint | null>;
  /** A thread was archived, deleted or moved: its sessions end, devices keep running. */
  readonly releaseThread: (threadId: ThreadId) => Effect.Effect<void>;
}

export class DeviceService extends Context.Service<DeviceService, DeviceServiceShape>()(
  "@threadlines/server/device/DeviceService",
) {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** The one complete PNG in `bytes` (from its signature to its IEND chunk), with its size. */
export const extractPng = (
  bytes: Uint8Array,
): { readonly png: Uint8Array; readonly width: number; readonly height: number } | undefined => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = buffer.indexOf(Buffer.from(PNG_SIGNATURE));
  if (start < 0) return undefined;
  const end = buffer.indexOf(PNG_END, start);
  if (end < 0 || end - start < 24) return undefined;
  const png = new Uint8Array(buffer.subarray(start, end + PNG_END.length));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(12) !== 0x49484452) return undefined;
  return { png, width: view.getUint32(16), height: view.getUint32(20) };
};

const sameSession = (
  a: { readonly threadId: ThreadId; readonly deviceId: DeviceId },
  b: { readonly threadId: ThreadId; readonly deviceId: DeviceId },
) => a.threadId === b.threadId && a.deviceId === b.deviceId;

const agentTargetArgs = (device: DeviceSummary): ReadonlyArray<string> =>
  device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];

const hostUnavailable = (error: DeviceHost.DeviceHostError) =>
  new DeviceHostUnavailableError({ reason: error.message });

export const make = Effect.gen(function* () {
  const host = yield* DeviceHost.DeviceHost;
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const analytics = yield* Effect.serviceOption(AnalyticsService);
  const stateDir = config.stateDir;
  const claimsPath = path.join(deviceStateDir(path, stateDir), "claims.json");
  const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const readDeviceSettings = settings.getSettings.pipe(
    Effect.map((value) => ({
      enabled: value.enableDevices,
      agentAccessEnabled: value.agentDeviceAccess,
    })),
    Effect.mapError(
      () => new DeviceOperationError({ operation: "settings", reason: "settings_failed" }),
    ),
  );
  const initialSettings = yield* readDeviceSettings.pipe(
    Effect.orElseSucceed(() => ({ enabled: false, agentAccessEnabled: false })),
  );

  // Claims a previous run left. A file that can't be read is kept as it is and treated as none.
  const loaded = yield* fs.readFileString(claimsPath).pipe(
    Effect.flatMap(decodeClaimsFile),
    Effect.catch(() =>
      Effect.succeed({
        claims: [] as ReadonlyArray<DeviceClaim>,
        pendingReleases: [] as ReadonlyArray<string>,
      }),
    ),
  );
  // What claims.json holds. Changed only once the file says the same, so a
  // failed write never leaves memory and disk telling different stories.
  let claims: ReadonlyMap<string, DeviceClaim> = new Map(
    loaded.claims.map((claim) => [claim.agentSession, claim]),
  );
  let pendingReleases: ReadonlySet<string> = new Set(loaded.pendingReleases);
  const claimsLock = yield* Semaphore.make(1);
  const saveClaims = (update: {
    readonly claims?: ReadonlyMap<string, DeviceClaim>;
    readonly pendingReleases?: ReadonlySet<string>;
  }) =>
    Effect.gen(function* () {
      const nextClaims = update.claims ?? claims;
      const nextPending = update.pendingReleases ?? pendingReleases;
      const contents = yield* encodeClaimsFile({
        version: 1,
        claims: [...nextClaims.values()],
        pendingReleases: [...nextPending],
      });
      yield* writeFileStringAtomically({ filePath: claimsPath, contents }).pipe(services);
      claims = nextClaims;
      pendingReleases = nextPending;
    }).pipe(
      Effect.mapError(
        () => new DeviceOperationError({ operation: "save claim", reason: "settings_failed" }),
      ),
    );
  /** Changes the claims under their lock, from the latest ones. */
  const changeClaims = (
    change: (current: {
      readonly claims: ReadonlyMap<string, DeviceClaim>;
      readonly pendingReleases: ReadonlySet<string>;
    }) => {
      readonly claims?: ReadonlyMap<string, DeviceClaim>;
      readonly pendingReleases?: ReadonlySet<string>;
    },
  ) => claimsLock.withPermit(Effect.suspend(() => saveClaims(change({ claims, pendingReleases }))));

  /**
   * Ends every agent-device session on the pending list that the daemon now
   * confirms. A session the daemon would not close stays listed, so the next
   * close, agent tools starting, or the next server tries again.
   */
  const retryPendingReleases = Effect.suspend(() => {
    const names = [...pendingReleases];
    if (names.length === 0) return Effect.void;
    return Effect.forEach(
      names,
      (name) => host.releaseAgentSession(name).pipe(Effect.map((done) => (done ? name : null))),
      { concurrency: 4 },
    ).pipe(
      Effect.flatMap((results) => {
        const done = new Set(results.filter((name): name is string => name !== null));
        if (done.size === 0) return Effect.void;
        return changeClaims((current) => ({
          pendingReleases: new Set([...current.pendingReleases].filter((name) => !done.has(name))),
        }));
      }),
      Effect.catch((error) =>
        Effect.logWarning("Could not save device claims", { detail: error.message }),
      ),
    );
  });

  const toSession = ({ agentSession: _agentSession, ...session }: DeviceClaim): DeviceSession =>
    session;

  const initialSummary = yield* host.summary;
  // Every state is a whole snapshot, so a subscriber that stops reading needs
  // only the newest: older ones slide out instead of piling up in memory.
  const statePubSub = yield* PubSub.sliding<DeviceServiceState>(2);
  const stateRef = yield* SynchronizedRef.make<DeviceServiceState>({
    enabled: initialSettings.enabled,
    agentAccessEnabled: initialSettings.agentAccessEnabled,
    hostStatus: initialSettings.enabled ? "idle" : "disabled",
    platforms: initialSummary.platforms,
    incompletePlatforms: [],
    ...(initialSummary.tools ? { tools: initialSummary.tools } : {}),
    ...(initialSummary.toolInspectionError
      ? { toolInspectionError: initialSummary.toolInspectionError }
      : {}),
    hubInstalled: initialSummary.hubInstalled,
    agentDeviceInstalled: initialSummary.agentDeviceInstalled,
    devices: [],
    sessions: [...claims.values()].map(toSession),
    bootingDevices: [],
    revision: 0,
  });
  const lifecycleLock = yield* Semaphore.make(1);
  const launcherLock = yield* Semaphore.make(1);

  const publish = (update: (state: DeviceServiceState) => DeviceServiceState) =>
    SynchronizedRef.modifyEffect(stateRef, (state) => {
      const next = { ...update(state), revision: state.revision + 1 };
      return PubSub.publish(statePubSub, next).pipe(Effect.as([next, next] as const));
    }).pipe(Effect.uninterruptible);

  const currentState = SynchronizedRef.get(stateRef);

  const publishSummary = host.summary.pipe(
    Effect.flatMap((summary) =>
      publish((state) => {
        const { tools: _tools, toolInspectionError: _error, ...rest } = state;
        return {
          ...rest,
          platforms: summary.platforms,
          hubInstalled: summary.hubInstalled,
          agentDeviceInstalled: summary.agentDeviceInstalled,
          ...(summary.tools ? { tools: summary.tools } : {}),
          ...(summary.toolInspectionError
            ? { toolInspectionError: summary.toolInspectionError }
            : {}),
        };
      }),
    ),
  );

  const setHostStatus = (status: DeviceServiceState["hostStatus"], detail?: string) =>
    publish((state) => {
      const { hostStatusDetail: _detail, ...rest } = state;
      return { ...rest, hostStatus: status, ...(detail ? { hostStatusDetail: detail } : {}) };
    });

  const requireEnabled = Effect.gen(function* () {
    if (!(yield* readDeviceSettings).enabled) {
      return yield* new DeviceHostUnavailableError({
        reason: "Devices are off. Turn on Use devices in Settings → Devices first.",
      });
    }
  });

  /**
   * Runs `work` once in the service's own scope and lets any number of
   * callers wait on it. A caller that goes away (a Device tab closed during
   * the first install) stops waiting; the install and start carry on, so the
   * hub never stays half-started with its status stuck on "installing".
   */
  const shared = <A>(work: Effect.Effect<A, DeviceError>) =>
    Effect.gen(function* () {
      const slot = yield* SynchronizedRef.make<Fiber.Fiber<A, DeviceError> | null>(null);
      return SynchronizedRef.modifyEffect(slot, (running) =>
        running !== null
          ? Effect.succeed([running, running] as const)
          : work.pipe(
              Effect.ensuring(SynchronizedRef.set(slot, null)),
              Effect.forkIn(scope),
              Effect.map((fiber) => [fiber, fiber] as const),
            ),
      ).pipe(Effect.flatMap(Fiber.join));
    });

  const readiness = yield* shared(
    Effect.gen(function* () {
      yield* requireEnabled;
      const ready = yield* host
        .ensureReady((phase, detail) => setHostStatus(phase, detail).pipe(Effect.asVoid))
        .pipe(
          Effect.tapError((error) => setHostStatus("failed", error.message)),
          Effect.mapError(hostUnavailable),
        );
      const { hostStatus } = yield* currentState;
      if (hostStatus !== "ready") {
        // The first listing and "ready" go out together; a failed listing still leaves the hub ready.
        yield* refresh(ready, { markReady: true }).pipe(Effect.catch(() => setHostStatus("ready")));
        yield* publishSummary;
      }
      return ready;
    }).pipe(lifecycleLock.withPermit, Effect.withSpan("DeviceService.readiness")),
  );

  const agentReadiness = yield* shared(
    Effect.gen(function* () {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) {
        return yield* new DeviceHostUnavailableError({
          reason:
            "Agents can't use devices on this computer. Ask the user to turn on Use devices and Agents can use devices in Settings → Devices.",
        });
      }
      const wasReady = (yield* currentState).hostStatus === "ready";
      const ready = yield* host
        .ensureAgentReady((phase, detail) => setHostStatus(phase, detail).pipe(Effect.asVoid))
        .pipe(
          Effect.tapError((error) =>
            wasReady
              ? host.current.pipe(
                  Effect.flatMap((hub) =>
                    hub !== null ? setHostStatus("ready") : setHostStatus("failed", error.message),
                  ),
                )
              : setHostStatus("failed", error.message),
          ),
          Effect.mapError(hostUnavailable),
        );
      yield* setHostStatus("ready");
      yield* publishSummary;
      yield* retryPendingReleases;
      return ready;
    }).pipe(lifecycleLock.withPermit, Effect.withSpan("DeviceService.agentReadiness")),
  );

  /**
   * Lists the devices and publishes them. With `markReady`, the hub's "ready"
   * goes out in the same state as the listing, so a client never sees a ready
   * hub with no devices while the first listing is still on its way.
   */
  const refresh = Effect.fn("DeviceService.refresh")(function* (
    ready: DeviceHost.DeviceHostReady,
    options?: { readonly markReady?: boolean },
  ) {
    const { devices, detail, incompletePlatforms } = yield* ready.devices.list;
    if (!(yield* readDeviceSettings).enabled) return yield* currentState;
    return yield* publish((state) => {
      const { hostStatusDetail: _detail, ...rest } = state;
      return {
        ...rest,
        ...(options?.markReady ? { hostStatus: "ready" as const } : {}),
        ...(detail ? { hostStatusDetail: detail } : {}),
        incompletePlatforms: [...incompletePlatforms],
        // A platform that could not be listed keeps its last known devices.
        devices: [
          ...state.devices.filter((device) => incompletePlatforms.includes(device.platform)),
          ...devices.filter((device) => !incompletePlatforms.includes(device.platform)),
        ],
      };
    });
  });

  const list: DeviceServiceShape["list"] = (input) =>
    Effect.gen(function* () {
      if (!(yield* readDeviceSettings).enabled) return yield* currentState;
      if (input.refresh !== true) return yield* currentState;
      const platforms = (yield* host.summary).platforms;
      if (!platforms.some((platform) => platform.available)) {
        yield* publishSummary;
        return yield* currentState;
      }
      const ready = yield* readiness;
      return yield* refresh(ready);
    }).pipe(Effect.withSpan("DeviceService.list"));

  const ensurePlatform = Effect.fn("DeviceService.ensurePlatform")(function* (
    platform: DevicePlatform,
  ) {
    const availability = yield* host.platformAvailability(platform);
    if (!availability.available) {
      return yield* new DevicePlatformUnavailableError({
        platform,
        reason: availability.reason ?? "This platform's tools are missing.",
      });
    }
  });

  const findDevice = (state: DeviceServiceState, deviceId: string) =>
    state.devices.find((device) => device.id === deviceId);

  /** serve-emu encodes emulator video with ffmpeg's libx264; without it there is nothing to show. */
  const requireAndroidVideo = Effect.fn("DeviceService.requireAndroidVideo")(function* (
    ready: DeviceHost.DeviceHostReady,
  ) {
    const encoders = yield* ready.run(ready.nodePath, [
      "-e",
      `const { spawnSync } = require("node:child_process");
const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
  stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
});
process.exitCode = result.error ? 1 : (result.status ?? 1);`,
    ]);
    if (encoders.code !== 0) {
      return yield* new DevicePlatformUnavailableError({
        platform: "android",
        reason:
          "Android emulator video needs ffmpeg with the libx264 encoder. Install it on this computer's PATH (or set SERVE_EMU_FFMPEG), restart Threadlines, then open the emulator again.",
      });
    }
    if (!/^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(`${encoders.stdout}\n${encoders.stderr}`)) {
      return yield* new DevicePlatformUnavailableError({
        platform: "android",
        reason:
          "Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264, restart Threadlines, then open the emulator again.",
      });
    }
  });

  /** Records the claim, then publishes the session: a claim is on disk before anyone sees it open. */
  /**
   * How many times each thread has been released (archived, moved, deleted).
   * An open notes the count when it starts and records nothing if it changed,
   * so a thread put away while its device was still booting keeps no claim.
   */
  const releaseCounts = new Map<ThreadId, number>();

  const recordSession = (session: DeviceSession, releasesAtStart: number) =>
    Effect.gen(function* () {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled) {
        return yield* new DeviceHostUnavailableError({
          reason: "Devices were turned off while the device was opening.",
        });
      }
      if (session.openedBy === "agent" && !deviceSettings.agentAccessEnabled) {
        return yield* new DeviceHostUnavailableError({
          reason: "Agent device access was turned off while the device was opening.",
        });
      }
      if ((releaseCounts.get(session.threadId) ?? 0) !== releasesAtStart) {
        return yield* new DeviceHostUnavailableError({
          reason: "The thread was put away while the device was opening.",
        });
      }
      const agentSession = agentDeviceSession(session.threadId, session.deviceId);
      yield* changeClaims((current) => ({
        claims: new Map([...current.claims, [agentSession, { ...session, agentSession }]]),
      }));
      yield* publish((state) => ({
        ...state,
        sessions: [
          ...state.sessions.filter((existing) => !sameSession(existing, session)),
          session,
        ],
      }));
    }).pipe(lifecycleLock.withPermit);

  const openInternal = (
    input: DeviceOpenInput,
    openedBy: "user" | "agent",
    skipInitialRefresh = false,
  ) =>
    Effect.gen(function* () {
      const startedNanos = yield* Clock.monotonicTimeNanos;
      const elapsedMs = Clock.monotonicTimeNanos.pipe(
        Effect.map((now) => Math.max(0, Math.round(Number(now - startedNanos) / 1_000_000))),
      );
      const recordAnalytics = (event: string, properties: Readonly<Record<string, unknown>>) =>
        Option.isSome(analytics) ? analytics.value.record(event, properties) : Effect.void;

      return yield* Effect.gen(function* () {
        const releasesAtStart = releaseCounts.get(input.threadId) ?? 0;
        yield* ensurePlatform(input.platform);
        const ready = yield* readiness;
        let state = yield* currentState;
        let device = skipInitialRefresh ? findDevice(state, input.deviceId) : undefined;
        if (!device) {
          state = yield* refresh(ready);
          device = findDevice(state, input.deviceId);
        }
        if (!device) return yield* new DeviceNotFoundError({ deviceId: input.deviceId });
        if (device.platform === "android" && !device.physical) yield* requireAndroidVideo(ready);
        let bootedNow = false;
        if (!device.booted && input.boot !== false) {
          const booting = { ...device, threadId: input.threadId };
          yield* publish((current) => ({
            ...current,
            bootingDevices: [
              ...current.bootingDevices.filter((entry) => entry.id !== booting.id),
              booting,
            ],
          }));
          const bootedId = yield* ready.devices.boot(device).pipe(
            Effect.ensuring(
              publish((current) => ({
                ...current,
                bootingDevices: current.bootingDevices.filter((entry) => entry.id !== booting.id),
              })),
            ),
          );
          bootedNow = true;
          state = yield* refresh(ready);
          // Retained entries predate the boot, so only a complete listing confirms the booted device.
          device = state.incompletePlatforms.includes(device.platform)
            ? undefined
            : (findDevice(state, bootedId) ?? findDevice(state, device.id));
          if (!device) return yield* new DeviceNotFoundError({ deviceId: input.deviceId });
        } else if (device.booted) {
          yield* ready.devices.attach(device);
        }
        const opened = device;
        const earlier = (yield* currentState).sessions.find(
          (session) => session.deviceId === opened.id && session.bootedByThreadlines,
        );
        const session: DeviceSession = {
          threadId: input.threadId,
          deviceId: opened.id,
          platform: opened.platform,
          openedAt: DateTime.formatIso(yield* DateTime.now),
          bootedByThreadlines: bootedNow || earlier !== undefined,
          openedBy,
        };
        yield* recordSession(session, releasesAtStart);
        yield* recordAnalytics("device.session.opened", {
          devicePlatform: opened.platform,
          openedBy,
          bootedNow,
          physical: opened.physical,
          durationMs: yield* elapsedMs,
        });
        return session;
      }).pipe(
        Effect.tapError((error) =>
          Effect.flatMap(elapsedMs, (durationMs) =>
            recordAnalytics("device.session.open_failed", {
              devicePlatform: input.platform,
              openedBy,
              errorKind: error._tag,
              durationMs,
            }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("DeviceService.open"));

  const open: DeviceServiceShape["open"] = (input, openedBy = "user") =>
    openInternal(input, openedBy, false);

  /** Removes launchers whose session is gone. Under the launcher lock, so binding never races it. */
  const pruneLaunchers = launcherLock.withPermit(
    Effect.gen(function* () {
      const { sessions } = yield* currentState;
      const live = new Set(
        sessions.map((session) => agentDeviceLauncherKey(session.threadId, session.deviceId)),
      );
      yield* pruneAgentDeviceLaunchers({ stateDir, live }).pipe(services);
    }),
  );

  /**
   * Ends sessions: drops their claims and queues their agent-device sessions on
   * `pendingReleases` in one disk write, then updates state, prunes launchers,
   * and tries to release them on the daemon.
   */
  const endSessions = (ending: ReadonlyArray<DeviceSession>) =>
    Effect.gen(function* () {
      if (ending.length === 0) return;
      const names = ending.map((session) => agentDeviceSession(session.threadId, session.deviceId));
      // The claims go first, and as one write: a session reported closed is closed on disk too.
      // Their agent-device sessions wait on the pending list until the daemon confirms them.
      yield* changeClaims((current) => ({
        claims: new Map([...current.claims].filter(([name]) => !names.includes(name))),
        pendingReleases: new Set([...current.pendingReleases, ...names]),
      }));
      yield* publish((state) => ({
        ...state,
        sessions: state.sessions.filter(
          (session) => !ending.some((ended) => sameSession(ended, session)),
        ),
      }));
      yield* pruneLaunchers;
      yield* retryPendingReleases;
    });

  const shutdownDevice = Effect.fn("DeviceService.shutdownDevice")(function* (
    ready: DeviceHost.DeviceHostReady,
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) {
    yield* ready.devices.shutdown({ id: deviceId, platform });
    yield* publish((state) => ({
      ...state,
      devices: state.devices.map((device) =>
        device.id === deviceId ? { ...device, booted: false } : device,
      ),
    }));
  });

  const refreshQuietly = (ready: DeviceHost.DeviceHostReady) =>
    refresh(ready).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Device listing unavailable after shutdown", { cause }),
      ),
    );

  const close: DeviceServiceShape["close"] = (input) =>
    Effect.gen(function* () {
      const { sessions } = yield* currentState;
      const closing = sessions.filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      if (!input.shutdown) {
        yield* lifecycleLock.withPermit(endSessions(closing));
        return;
      }
      // Powering off ends every thread's session on those devices, before the power-off,
      // while their agent-device sessions can still quit the app.
      const ending = sessions.filter((session) =>
        closing.some((closed) => closed.deviceId === session.deviceId),
      );
      yield* lifecycleLock.withPermit(endSessions(ending));
      const ready = yield* readiness;
      for (const session of closing) {
        yield* shutdownDevice(ready, session.deviceId, session.platform);
      }
      if (closing.length > 0) yield* refreshQuietly(ready);
    }).pipe(Effect.withSpan("DeviceService.close"));

  const shutdown: DeviceServiceShape["shutdown"] = (input) =>
    Effect.gen(function* () {
      const { sessions } = yield* currentState;
      yield* lifecycleLock.withPermit(
        endSessions(sessions.filter((session) => session.deviceId === input.deviceId)),
      );
      const ready = yield* readiness;
      yield* shutdownDevice(ready, input.deviceId, input.platform);
      yield* refreshQuietly(ready);
    }).pipe(Effect.withSpan("DeviceService.shutdown"));

  const resolveDevice = Effect.fn("DeviceService.resolveDevice")(function* (deviceId: DeviceId) {
    const ready = yield* readiness;
    const device =
      findDevice(yield* currentState, deviceId) ?? findDevice(yield* refresh(ready), deviceId);
    if (!device) return yield* new DeviceNotFoundError({ deviceId });
    return { ready, device };
  });

  const detail: DeviceServiceShape["detail"] = (input) =>
    Effect.gen(function* () {
      const { ready, device } = yield* resolveDevice(input.deviceId);
      const read = yield* readDeviceDetail(ready, device.platform, device.id);
      return {
        deviceId: device.id,
        settings: read.settings,
        foregroundApp: read.foregroundApp,
        readAt: DateTime.formatIso(yield* DateTime.now),
      };
    }).pipe(Effect.withSpan("DeviceService.detail"));

  const action: DeviceServiceShape["action"] = (input) =>
    Effect.gen(function* () {
      const { ready, device } = yield* resolveDevice(input.deviceId);
      yield* runDeviceAction(ready, device.platform, input);
      return yield* detail({ deviceId: device.id });
    }).pipe(Effect.withSpan("DeviceService.action"));

  const screenshot: DeviceServiceShape["screenshot"] = (deviceId) =>
    Effect.gen(function* () {
      const { ready, device } = yield* resolveDevice(deviceId);
      const bytes = yield* ready.devices.screenshot(device);
      const extracted = extractPng(bytes);
      if (extracted === undefined) {
        return yield* new DeviceOperationError({
          operation: "screenshot",
          reason: "hub_rejected",
          detail: `The device hub returned ${bytes.length} bytes without a complete PNG.`,
        });
      }
      return { device, ...extracted };
    }).pipe(Effect.withSpan("DeviceService.screenshot"));

  const agentOpen: DeviceServiceShape["agentOpen"] = (input) =>
    Effect.gen(function* () {
      // Consent and agent tools first, before anything boots or a session is recorded.
      const agentReady = yield* agentReadiness;
      const session = yield* openInternal(input, "agent", input.alreadyListed === true);
      const device = findDevice(yield* currentState, session.deviceId);
      if (!device) return yield* new DeviceNotFoundError({ deviceId: session.deviceId });
      const configPath = agentDeviceConfigPath(path, stateDir);
      const agentSession = agentDeviceSession(session.threadId, session.deviceId);
      const targetArgs = [
        ...agentTargetArgs(device),
        "--config",
        configPath,
        "--session",
        agentSession,
      ];
      const command = yield* launcherLock.withPermit(
        Effect.gen(function* () {
          const deviceSettings = yield* readDeviceSettings;
          if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) {
            return Option.none<string>();
          }
          const { sessions } = yield* currentState;
          // Closed while it opened: no launcher for a session that is gone.
          if (!sessions.some((live) => sameSession(live, session))) return Option.none<string>();
          yield* writeAgentDeviceConfig(configPath, agentReady.agentDevice).pipe(
            services,
            Effect.mapError(
              () =>
                new DeviceOperationError({
                  operation: "configure agent",
                  reason: "settings_failed",
                }),
            ),
          );
          return Option.some(
            yield* bindAgentDeviceLauncher({
              stateDir,
              threadId: session.threadId,
              deviceId: session.deviceId,
              node: agentReady.nodePath,
              entryPath: agentReady.agentDevice.entryPath,
              targetArgs,
            }).pipe(
              services,
              Effect.mapError(
                () =>
                  new DeviceOperationError({
                    operation: "prepare agent-device",
                    reason: "settings_failed",
                  }),
              ),
            ),
          );
        }),
      );
      if (Option.isNone(command)) {
        return yield* new DeviceHostUnavailableError({
          reason:
            "The device was closed or agent access was turned off while it was opening. Call device_open again only if you still need it.",
        });
      }
      return { device, session, command: command.value, agentSession };
    }).pipe(Effect.withSpan("DeviceService.agentOpen"));

  const sessionsForThread: DeviceServiceShape["sessionsForThread"] = (threadId) =>
    currentState.pipe(
      Effect.map((state) => state.sessions.filter((session) => session.threadId === threadId)),
    );

  const releaseThread: DeviceServiceShape["releaseThread"] = (threadId) =>
    Effect.sync(() => releaseCounts.set(threadId, (releaseCounts.get(threadId) ?? 0) + 1)).pipe(
      Effect.andThen(sessionsForThread(threadId)),
      Effect.flatMap((sessions) => lifecycleLock.withPermit(endSessions(sessions))),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not release a thread's devices", { threadId, cause }),
      ),
    );

  const updateTool: DeviceServiceShape["updateTool"] = (tool) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const deviceSettings = yield* readDeviceSettings;
      if (tool === "agent" && !deviceSettings.agentAccessEnabled) {
        return yield* new DeviceHostUnavailableError({
          reason: "Agent tools install only once Agents can use devices is on.",
        });
      }
      yield* host.updateTool(tool).pipe(
        Effect.mapError(
          (error) =>
            new DeviceOperationError({
              operation: "update device tool",
              reason: "command_failed",
              detail: error.message,
            }),
        ),
      );
      return yield* publishSummary;
    }).pipe(lifecycleLock.withPermit, Effect.withSpan("DeviceService.updateTool"));

  /**
   * Agent access off: every agent-device session is ended, every launcher and
   * the daemon config they read are removed, then the daemon stops. A daemon
   * that would not stop is reported, never assumed gone.
   */
  const withdrawAgentAccess = Effect.gen(function* () {
    yield* changeClaims((current) => ({
      pendingReleases: new Set([...current.pendingReleases, ...current.claims.keys()]),
    })).pipe(Effect.ignore);
    yield* retryPendingReleases;
    yield* launcherLock.withPermit(
      Effect.gen(function* () {
        yield* pruneAgentDeviceLaunchers({ stateDir, live: new Set() }).pipe(services);
        yield* fs
          .remove(agentDeviceConfigPath(path, stateDir), { force: true })
          .pipe(Effect.ignore);
      }),
    );
    const stopped = yield* host.stopAgent;
    if (stopped) {
      yield* retryPendingReleases;
    } else {
      yield* setHostStatus(
        (yield* currentState).hostStatus,
        `Agent tools did not stop. Their logs are in ${path.join(deviceStateDir(path, stateDir), "agent-device")}; restarting Threadlines stops them.`,
      );
    }
  });

  /** "Use devices" off stops the hub and daemon (devices keep running); agent access off stops the daemon. */
  const applySettings = (next: {
    readonly enabled: boolean;
    readonly agentAccessEnabled: boolean;
  }) =>
    Effect.gen(function* () {
      const previous = yield* currentState;
      if (
        previous.enabled === next.enabled &&
        previous.agentAccessEnabled === next.agentAccessEnabled
      ) {
        return;
      }
      yield* publish((state) => {
        const { hostStatusDetail: _detail, ...rest } = state;
        return {
          ...rest,
          enabled: next.enabled,
          agentAccessEnabled: next.agentAccessEnabled,
          hostStatus: next.enabled
            ? state.hostStatus === "disabled"
              ? "idle"
              : state.hostStatus
            : "disabled",
          ...(next.enabled && state.hostStatusDetail
            ? { hostStatusDetail: state.hostStatusDetail }
            : {}),
          devices: next.enabled ? state.devices : [],
          sessions: next.enabled ? state.sessions : [],
          bootingDevices: next.enabled ? state.bootingDevices : [],
        };
      });
      // Published first, then stopped: the agent tools check this state on every
      // call, so they refuse from the moment the switch turns off, not after the
      // daemon or hub has finished stopping.
      if (!next.enabled) {
        yield* lifecycleLock.withPermit(
          Effect.gen(function* () {
            const activeClaims = [...claims.values()].map(toSession);
            yield* endSessions(activeClaims).pipe(Effect.ignore);
            yield* launcherLock.withPermit(
              Effect.gen(function* () {
                yield* pruneAgentDeviceLaunchers({ stateDir, live: new Set() }).pipe(services);
                yield* fs
                  .remove(agentDeviceConfigPath(path, stateDir), { force: true })
                  .pipe(Effect.ignore);
              }),
            );
            yield* host.stop;
            yield* retryPendingReleases;
          }),
        );
      } else if (!next.agentAccessEnabled && previous.agentAccessEnabled) {
        yield* lifecycleLock.withPermit(withdrawAgentAccess);
      }
      // Agent access turned on: fetch agent-device now, in the background, so the
      // first device_open is quick. Nothing starts until an agent asks.
      if (next.enabled && next.agentAccessEnabled && !previous.agentAccessEnabled) {
        yield* host.updateTool("agent").pipe(
          Effect.andThen(publishSummary),
          Effect.catch((error) =>
            Effect.logWarning("Could not install agent tools", { detail: error.message }),
          ),
          Effect.forkIn(scope),
        );
      }
    });

  yield* settings.streamChanges.pipe(
    Stream.map((value) => ({
      enabled: value.enableDevices,
      agentAccessEnabled: value.agentDeviceAccess,
    })),
    // One change that fails (a claims write, say) must not end the watcher.
    Stream.runForEach((next) =>
      applySettings(next).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not apply device settings", { cause }),
        ),
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Device settings watcher stopped", { cause })),
    Effect.forkIn(scope),
  );

  // Launchers for sessions that no longer exist (the claims file is the record),
  // and agent-device sessions an earlier run could not end.
  yield* pruneLaunchers.pipe(Effect.ignore);
  yield* retryPendingReleases.pipe(Effect.forkIn(scope));

  // Stop the hub and daemon with the server. Devices keep running.
  yield* Effect.addFinalizer(() => host.stop);

  return DeviceService.of({
    state: currentState,
    stream: Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so no change is lost.
        const subscription = yield* PubSub.subscribe(statePubSub);
        const initial = yield* currentState;
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((state) => state.revision > initial.revision),
          ),
        );
      }),
    ),
    list,
    updateTool,
    open,
    close,
    shutdown,
    detail,
    action,
    screenshot,
    agentOpen,
    sessionsForThread,
    currentHub: host.current.pipe(Effect.map((ready) => ready?.hub ?? null)),
    releaseThread,
  });
});

export const layer = Layer.effect(DeviceService, make).pipe(Layer.provide(LocalDeviceHost.layer));
