/**
 * The seam between the device service and the machine (docs/design/devices.md).
 * One implementation, LocalDeviceHost: a Threadlines server has one device
 * host, its own machine. A Mac linked in Fleet shows its devices through its
 * own server.
 */
import type {
  DeviceBootError,
  DeviceHostUnavailableError,
  DeviceOperationError,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceSummary,
  DeviceToolVersions,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Something went wrong starting or running the device tools; `step` says where. */
export class DeviceHostError extends Schema.TaggedError<DeviceHostError>()("DeviceHostError", {
  step: Schema.String,
  /** Words the user can act on, when there are some. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? `Device support failed while ${this.step}.`;
  }
}

/** The running hub: where it listens and the session token it printed. Never leaves the server. */
export interface DeviceHubEndpoint {
  readonly origin: string;
  readonly token: string;
}

/** The running agent-device daemon, read from its own `daemon.json`. */
export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /** The agent-device CLI that talks to it. */
  readonly entryPath: string;
}

/** Discovery and lifecycle for the devices a ready host can run. */
export interface DeviceOperations {
  readonly list: Effect.Effect<
    {
      readonly devices: ReadonlyArray<DeviceSummary>;
      readonly detail: string | undefined;
      /** Platforms that could not be listed; their last known devices stay listed. */
      readonly incompletePlatforms: ReadonlyArray<DevicePlatform>;
    },
    DeviceOperationError
  >;
  /**
   * Boots the device and prepares its stream. Android AVDs change id when they
   * boot (AVD name to emulator serial), so the returned id is authoritative.
   */
  readonly boot: (
    device: DeviceSummary,
  ) => Effect.Effect<string, DeviceOperationError | DeviceBootError | DeviceHostUnavailableError>;
  /** Prepares the stream of a device that is already booted. */
  readonly attach: (device: DeviceSummary) => Effect.Effect<void, DeviceOperationError>;
  readonly shutdown: (device: {
    readonly id: string;
    readonly platform: DevicePlatform;
  }) => Effect.Effect<void, DeviceOperationError>;
  readonly screenshot: (device: DeviceSummary) => Effect.Effect<Uint8Array, DeviceOperationError>;
}

export interface DeviceRunResult {
  readonly stdout: string;
  readonly stderr: string;
  /** 124 on timeout, 127 when it could not start. */
  readonly code: number;
}

export interface DeviceHostReady {
  /** The Node.js the tools run on (Threadlines' managed one). */
  readonly nodePath: string;
  readonly hub: DeviceHubEndpoint;
  readonly devices: DeviceOperations;
  /** Runs a command with the Android SDK on PATH. Never fails: see `code`. */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly timeoutMs?: number;
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    },
  ) => Effect.Effect<DeviceRunResult>;
  /** serve-sim's helper binaries, for the Tools drawer. Null where the install lacks one. */
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
  /**
   * Ends an agent-device session on the running daemon. Present only while
   * the daemon runs; cleanup never starts a daemon or a device.
   */
  readonly releaseAgentSession?: (session: string) => Effect.Effect<void, DeviceOperationError>;
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  readonly agentDevice: AgentDeviceEndpoint;
}

export interface DeviceHostSummary {
  readonly platforms: ReadonlyArray<DevicePlatformAvailability>;
  readonly hubInstalled: boolean;
  readonly agentDeviceInstalled: boolean;
  readonly tools: DeviceToolVersions | undefined;
  readonly toolInspectionError: string | undefined;
}

export type DeviceHostPhase = "installing" | "starting";

export class DeviceHost extends Context.Service<
  DeviceHost,
  {
    readonly summary: Effect.Effect<DeviceHostSummary>;
    readonly platformAvailability: (
      platform: DevicePlatform,
    ) => Effect.Effect<DevicePlatformAvailability>;
    /** Installs (when missing) and starts the hub. */
    readonly ensureReady: (
      onPhase: (phase: DeviceHostPhase, detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<DeviceHostReady, DeviceHostError>;
    /** As `ensureReady`, and installs and starts the agent-device daemon too. */
    readonly ensureAgentReady: (
      onPhase: (phase: DeviceHostPhase, detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<DeviceHostAgentReady, DeviceHostError>;
    /** Installs the pinned version of a tool; restarts it if it was running. */
    readonly updateTool: (tool: "hub" | "agent") => Effect.Effect<void, DeviceHostError>;
    /** The running hub, without starting anything. */
    readonly current: Effect.Effect<DeviceHostReady | null>;
    /**
     * Ends an agent-device session on whatever daemon runs for this state
     * folder, this server's or one an earlier run left. Never starts one.
     * True when the session is gone (closed now, already released, or no
     * daemon runs: a daemon that is gone took its sessions with it); false when
     * a live daemon did not confirm the close, so the caller keeps its claim
     * and can try again.
     */
    readonly releaseAgentSession: (session: string) => Effect.Effect<boolean>;
    /** Stops the agent-device daemon through its own CLI. */
    readonly stopAgent: Effect.Effect<void>;
    /** Stops the hub and the daemon. Simulators and emulators keep running; the user owns those. */
    readonly stop: Effect.Effect<void>;
  }
>()("@threadlines/server/device/DeviceHost") {}
