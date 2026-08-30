/**
 * AcpProviderDescriptor — everything that differs between two ACP agents.
 *
 * The generic ACP driver (`AcpProviderDriver`) owns process lifecycle,
 * session/turn plumbing, permission routing, model discovery, snapshots and
 * text generation. A vendor contributes only this descriptor: how to spawn
 * the binary, how to probe it, and any protocol extensions it speaks.
 * Adding an ACP provider means writing one descriptor, not one driver.
 *
 * @module provider/acp/AcpProviderDescriptor
 */
import type {
  ModelCapabilities,
  ProviderDriverKind,
  ProviderOptionSelection,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  UserInputQuestion,
} from "@threadlines/contracts";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandDefinition,
} from "../providerMaintenance.ts";
import type { ProviderProbeResult, ServerProviderPresentation } from "../providerSnapshot.ts";
import type { AcpPlanUpdate } from "./AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape, AcpSpawnInput } from "./AcpSessionRuntime.ts";

/** Settings fields every ACP provider config must carry. */
export interface AcpProviderSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<string>;
}

export interface AcpProviderProbeOutcome extends ProviderProbeResult {
  /**
   * Skip ACP model discovery even though the binary responded — used for
   * version/channel gates where opening a session would only produce a
   * confusing secondary error.
   */
  readonly skipModelDiscovery?: boolean;
}

export interface AcpConfigUpdate {
  readonly configId: string;
  readonly value: string | boolean;
}

/**
 * Two-way mapping between ACP `configOptions` and Threadlines model option
 * descriptors. The generic mapping (see `AcpProviderModels`) mirrors every
 * non-model option one-to-one; vendors with bespoke option ids override it.
 */
export interface AcpModelOptionMapping {
  readonly capabilitiesFromConfigOptions: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => ModelCapabilities;
  readonly configUpdatesFromSelections: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  ) => ReadonlyArray<AcpConfigUpdate>;
}

/** Runtime hooks handed to a vendor's extension registration. */
export interface AcpExtensionContext {
  readonly threadId: ThreadId;
  readonly acp: AcpSessionRuntimeShape;
  readonly activeTurnId: () => TurnId | undefined;
  readonly logNative: (method: string, payload: unknown) => Effect.Effect<void>;
  /** Opens a user-input request and waits for the answer. */
  readonly requestUserInput: (input: {
    readonly method: string;
    readonly payload: unknown;
    readonly questions: ReadonlyArray<UserInputQuestion>;
  }) => Effect.Effect<ProviderUserInputAnswers>;
  readonly emitProposedPlan: (input: {
    readonly method: string;
    readonly payload: unknown;
    readonly planMarkdown: string;
  }) => Effect.Effect<void>;
  readonly emitPlanUpdate: (input: {
    readonly method: string;
    readonly payload: unknown;
    readonly plan: AcpPlanUpdate;
  }) => Effect.Effect<void>;
}

export interface AcpProviderExtensions {
  /** Raw-event source tag, e.g. `acp.cursor.extension`. */
  readonly source: `acp.${string}.extension`;
  /** Registers `handleExtRequest` / `handleExtNotification` handlers before `start()`. */
  readonly register: (
    context: AcpExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export interface AcpProviderDescriptor<Settings extends AcpProviderSettings> {
  readonly driverKind: ProviderDriverKind;
  readonly presentation: ServerProviderPresentation;
  readonly settingsSchema: Schema.Codec<Settings, unknown>;
  readonly defaultSettings: () => Settings;
  readonly maintenance: ProviderMaintenanceCapabilities;
  /**
   * One-click install per platform, offered only while the binary does not
   * resolve on PATH. Platforms without an entry fall back to the vendor's
   * install guide.
   */
  readonly install?: Partial<Record<NodeJS.Platform, ProviderMaintenanceCommandDefinition>>;
  readonly spawn: (
    settings: Settings,
    cwd: string,
    environment?: NodeJS.ProcessEnv,
  ) => AcpSpawnInput;
  /**
   * Whether a bare `binaryPath` should be resolved to an absolute host path
   * before spawning (default true). Descriptors that run the binary inside
   * another environment (fx inside WSL) keep the bare name.
   */
  readonly resolveBinaryOnHost?: (platform: NodeJS.Platform) => boolean;
  /**
   * The `cwd` sent in `session/new` / `session/load`, when it differs from
   * the host path the process is spawned in (fx inside WSL sees `/mnt/c/…`).
   */
  readonly resolveSessionCwd?: (cwd: string) => string;
  /** Auth method to call after `initialize`; omit for agents that log in outside ACP. */
  readonly authMethodId?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  /** Message shown when the binary cannot be spawned. */
  readonly notInstalledMessage: string;
  /**
   * CLI-level health check (installed, version, auth). Runs before any ACP
   * session is opened; discovery only follows when it does not report
   * `unauthenticated` or `skipModelDiscovery`.
   */
  readonly probe: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<
    AcpProviderProbeOutcome,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;
  /**
   * How long one ACP model-discovery session may take. Defaults to 15s;
   * agents that boot a VM first (fx inside WSL) need more.
   */
  readonly modelDiscoveryTimeoutMs?: number;
  readonly modelOptions?: AcpModelOptionMapping;
  /**
   * When true the option set changes with the selected model, so the driver
   * probes each model's capabilities in the background (Cursor). When false
   * the current session's options apply to every catalog entry (fx).
   */
  readonly modelCapabilitiesVaryByModel?: boolean;
  /** Normalizes an app-side model slug into the agent's config value. */
  readonly resolveModelId?: (model: string | null | undefined) => string | undefined;
  readonly extensions?: AcpProviderExtensions;
}
