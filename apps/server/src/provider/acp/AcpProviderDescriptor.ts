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
  ProviderInteractionMode,
  ProviderOptionSelection,
  ProviderUserInputAnswers,
  RuntimeMode,
  ServerProviderDetection,
  ServerProviderModel,
  ThreadId,
  TurnId,
  UserInputQuestion,
} from "@threadlines/contracts";
import type { HttpClient } from "effect/unstable/http";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandDefinition,
} from "../providerMaintenance.ts";
import type { ProviderProbeResult, ServerProviderPresentation } from "../providerSnapshot.ts";
import type { AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";
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
  /**
   * A catalog the probe already knows (cached from the last session), used
   * instead of discovery for agents that are too costly to start on every
   * status check.
   */
  readonly models?: ReadonlyArray<ServerProviderModel>;
}

/**
 * A permission request that is really a question for the user (Antigravity
 * asks through `session/request_permission` with one option per answer).
 * Never auto-approved, whatever the runtime mode.
 */
export interface AcpPermissionQuestion {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  /** The option to select for the user's answers; `undefined` cancels. */
  readonly optionIdForAnswers: (answers: ProviderUserInputAnswers) => string | undefined;
}

/**
 * Plan mode for agents that plan through a prompt command and a plan file
 * rather than an ACP session mode (Antigravity's `/plan`).
 */
export interface AcpPromptPlanMode {
  /** Prepended to the turn's text in plan mode, e.g. `/plan `. */
  readonly promptPrefix: string;
  /**
   * Whether this tool call writes the agent's own plan file. Such writes are
   * approved without asking (they never touch the workspace) and are not
   * shown as tool calls: the plan card stands for them.
   */
  readonly isPlanFile: (toolCall: AcpToolCallState) => boolean;
  /** The plan's markdown, when this plan-file write carries it. */
  readonly planMarkdown: (toolCall: AcpToolCallState) => string | undefined;
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

/** What a descriptor's `detect` hook is handed. */
export interface AcpDetectionInput<Settings extends AcpProviderSettings> {
  readonly settings: Settings;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The default: a binary looked up on disk the way spawning finds it. */
  readonly detectBinary: (binaryPath: string) => ServerProviderDetection;
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
  /**
   * How to start one agent process. An Effect may set up per-process state
   * (a private temp dir) that is torn down with the process's scope.
   */
  readonly spawn: (
    settings: Settings,
    cwd: string,
    environment?: NodeJS.ProcessEnv,
  ) => AcpSpawnInput | Effect.Effect<AcpSpawnInput, EffectAcpErrors.AcpError, Scope.Scope>;
  /**
   * The sign-in URL when an agent prints one on stderr. Outside a sign-in
   * flow such a line fails the process at once instead of waiting on a
   * browser nobody opened.
   */
  readonly signInUrlFromStderr?: (line: string) => string | undefined;
  /**
   * The agent mode for a runtime/interaction mode, for agents whose modes the
   * alias matching cannot place (Antigravity's `yolo`, `auto_edit`).
   */
  readonly agentModeFor?: (input: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode | undefined;
  }) => string | undefined;
  readonly classifyPermissionRequest?: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => AcpPermissionQuestion | undefined;
  /** A risk the agent attached to a permission option, shown with the approval. */
  readonly permissionOptionWarning?: (
    option: EffectAcpSchema.PermissionOption,
  ) => string | undefined;
  /** Text the agent appends when a prompt is cancelled; dropped from the reply. */
  readonly cancellationNotice?: string;
  readonly planMode?: AcpPromptPlanMode;
  /** Edit tool calls carry exact ACP `diff` content, trusted as file-change evidence. */
  readonly diffEvidence?: boolean;
  /**
   * Run text generation in a fresh temp directory: workspace hooks and
   * settings can act before a denied tool call would stop them.
   */
  readonly isolateTextGeneration?: boolean;
  /** Called with each session's catalog options, e.g. to cache the model list. */
  readonly onSessionConfigOptions?: (
    settings: Settings,
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
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
  /**
   * Whether the agent process can reach Threadlines' own `127.0.0.1`
   * endpoints, which the browser panel tools are served from (default true).
   * fx inside WSL's default NAT network sees its own loopback, not the
   * Windows host's.
   */
  readonly reachesHostLoopback?: (platform: NodeJS.Platform) => boolean;
  /** Auth method to call after `initialize`; omit for agents that log in outside ACP. */
  readonly authMethodId?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  /** Message shown when the binary cannot be spawned. */
  readonly notInstalledMessage: string;
  /**
   * Looks for the agent while it is turned off, reading the filesystem only:
   * no process, network or VM may start. Defaults to
   * `detectBinary(settings.binaryPath)`. Agents that are not a host binary
   * (a managed runtime, a CLI inside WSL) say what they can see instead.
   */
  readonly detect?: (input: AcpDetectionInput<Settings>) => Effect.Effect<ServerProviderDetection>;
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
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
  >;
  /**
   * How long one ACP model-discovery session may take. Defaults to 15s;
   * agents that boot a VM first (fx inside WSL) need more.
   */
  readonly modelDiscoveryTimeoutMs?: number;
  readonly modelOptions?: AcpModelOptionMapping;
  /**
   * Optional catalog garnish applied after discovery — pricing chips,
   * context windows. Must never fail; unknown slugs pass through.
   */
  readonly enrichDiscoveredModels?: (
    models: ReadonlyArray<ServerProviderModel>,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<ReadonlyArray<ServerProviderModel>, never, HttpClient.HttpClient>;
  /**
   * When true the option set changes with the selected model, so the driver
   * probes each model's capabilities in the background (Cursor, fx). When
   * false the current session's options apply to every catalog entry.
   */
  readonly modelCapabilitiesVaryByModel?: boolean;
  /**
   * Sessions the background capability probe splits the catalog across
   * (default 4). Agents that start slowly but switch models in milliseconds
   * (fx through WSL) are fastest with one.
   */
  readonly modelCapabilityProbeSessions?: number;
  /**
   * Normalizes an app-side model slug into the agent's config value. With a
   * context, the selection's options and the session's live options are
   * known (Antigravity folds effort into the model id).
   */
  readonly resolveModelId?: (
    model: string | null | undefined,
    context?: {
      readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    },
  ) => string | undefined;
  /**
   * Install and update actions that change with what is installed (a
   * managed runtime), read before each status check. Overrides
   * `maintenance` and `install`.
   */
  readonly resolveMaintenance?: (
    settings: Settings,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly extensions?: AcpProviderExtensions;
}
