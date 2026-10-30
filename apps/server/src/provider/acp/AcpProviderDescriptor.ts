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
  ProviderFailureCategory,
  ProviderInteractionMode,
  ProviderOptionSelection,
  ProviderRuntimeEvent,
  ProviderUserInputAnswers,
  RuntimeMode,
  ServerProvider,
  ServerProviderDetection,
  ServerProviderModel,
  ThreadId,
  TurnId,
  UserInputQuestion,
} from "@threadlines/contracts";
import type { HttpClient } from "effect/http";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandDefinition,
} from "../providerMaintenance.ts";
import type { UsageLedgerProvider } from "../../usage/usageLedger.ts";
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

/**
 * A runtime event an extension derives from the agent's own messages: its
 * background tasks and subagents. The adapter stamps it and names the thread.
 */
export type AcpExtensionRuntimeEvent = ProviderRuntimeEvent extends infer Event
  ? Event extends {
      readonly type:
        | "task.started"
        | "task.progress"
        | "task.completed"
        | "task.snapshot.updated"
        | "subagent.metadata.updated";
    }
    ? Omit<Event, "eventId" | "createdAt" | "provider" | "threadId" | "raw">
    : never
  : never;

/** How the agent says a turn ended, from its own notices. */
export interface AcpTurnOutcome {
  readonly state: "completed" | "failed" | "cancelled";
  readonly stopReason?: string;
  /** The agent's own words for a failure, shown instead of a bare RPC error. */
  readonly errorMessage?: string;
  /** Why it failed, when the agent's stop reason says so in a structured way. */
  readonly failureCategory?: ProviderFailureCategory;
}

/** Runtime hooks handed to a vendor's extension registration. */
export interface AcpExtensionContext {
  readonly threadId: ThreadId;
  readonly acp: AcpSessionRuntimeShape;
  /** This session's id once it has opened; updates for other ids are a subagent's. */
  readonly sessionId: () => string | undefined;
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
  readonly emitRuntimeEvent: (input: {
    readonly method: string;
    readonly payload: unknown;
    readonly event: AcpExtensionRuntimeEvent;
  }) => Effect.Effect<void>;
  /**
   * The agent started a turn of its own (see `agentTurns`): it opens where
   * this notice falls among the updates, rather than on its first output.
   * Call it from the notification handler that saw the start, once per turn:
   * each call ends the reply streamed so far. Nothing opens while a turn runs.
   */
  readonly beginAgentTurn: (input: {
    readonly method: string;
    readonly payload: unknown;
  }) => Effect.Effect<void>;
  /**
   * The agent's own turn ended: it closes where this notice falls among the
   * updates. Call it from the notification handler that saw the end.
   */
  readonly endAgentTurn: (input: {
    readonly method: string;
    readonly payload: unknown;
    readonly outcome: AcpTurnOutcome;
  }) => Effect.Effect<void>;
  /** How the running prompt ended, by the agent's notice; a failed prompt shows its words. */
  readonly reportPromptOutcome: (outcome: AcpTurnOutcome) => Effect.Effect<void>;
}

export interface AcpProviderExtensions {
  /** Raw-event source tag, e.g. `acp.cursor.extension`. */
  readonly source: `acp.${string}.extension`;
  /** Registers `handleExtRequest` / `handleExtNotification` handlers before `start()`. */
  readonly register: (
    context: AcpExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/**
 * An agent's rewind and fork, by its own numbering of the prompts it was
 * sent (see `AcpProviderDescriptor.conversationHistory`).
 */
export interface AcpConversationHistory {
  /**
   * Where the prompt a turn sent sits in the agent's history, asked as the
   * turn ends (`position` is `undefined` when the agent can't say for sure),
   * and the newest position the agent lists now.
   */
  readonly promptPosition: (input: {
    readonly acp: AcpSessionRuntimeShape;
    readonly sessionId: string;
    /** The prompt's text as sent, context preamble and all. */
    readonly promptText: string;
    /** Positions up to this one were listed before the prompt went out. */
    readonly after: number | undefined;
  }) => Effect.Effect<
    { readonly position: number | undefined; readonly newest: number | undefined },
    EffectAcpErrors.AcpError
  >;
  /** Forgets the prompt at this position and everything after it. */
  readonly rewind: (input: {
    readonly acp: AcpSessionRuntimeShape;
    readonly sessionId: string;
    readonly position: number;
  }) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * Copies a stored session's conversation into a new session, before any
   * session is open on the process; resolves the copy's id.
   */
  readonly fork: (input: {
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    readonly sessionId: string;
    /** The folder the source session ran in, where the agent keeps it. */
    readonly sourceCwd: string;
    readonly cwd: string;
    /** Copies the prompts up to and including this position; every one when absent. */
    readonly throughPosition: number | undefined;
  }) => Effect.Effect<string, EffectAcpErrors.AcpError>;
}

/** What an agent process is started for. A chat session carries its thread's runtime mode. */
export interface AcpLaunch {
  readonly runtimeMode?: RuntimeMode;
}

/** What a descriptor's `detect` hook is handed. */
export interface AcpDetectionInput<Settings extends AcpProviderSettings> {
  readonly settings: Settings;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The default: a binary looked up on disk the way spawning finds it. */
  readonly detectBinary: (binaryPath: string) => ServerProviderDetection;
}

/** One catalog model with the options it offers, as an agent lists them. */
export interface AcpModelOptions {
  readonly slug: string;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
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
    launch?: AcpLaunch,
  ) => AcpSpawnInput | Effect.Effect<AcpSpawnInput, EffectAcpErrors.AcpError, Scope.Scope>;
  /** `_meta` sent with `initialize` (Grok asks a GUI client to say what it is). */
  readonly initializeMeta?: Readonly<Record<string, unknown>>;
  /** `_meta` sent with `session/cancel`. */
  readonly cancelMeta?: Readonly<Record<string, unknown>>;
  /** `_meta` for one turn's `session/prompt` (Grok echoes a `promptId` on its updates). */
  readonly promptMeta?: (turnId: TurnId) => Readonly<Record<string, unknown>>;
  /**
   * The agent starts turns of its own between prompts, waking when its
   * background work finishes. Its output then is live: it opens a turn
   * instead of being dropped as replayed history. The extension ends the
   * turn (`endAgentTurn`); a sent message or a long quiet ends it too.
   */
  readonly agentTurns?: boolean;
  /**
   * The key threads resume across instances by: instances that keep one
   * conversation store share it (Grok accounts linking `sessions`). Defaults
   * to one key per instance.
   */
  readonly continuationKey?: (settings: Settings, environment: NodeJS.ProcessEnv) => string;
  /**
   * Adds a message to the running turn (Grok's `_x.ai/interject`). With it a
   * message sent mid-turn steers the turn instead of waiting for it.
   */
  readonly steer?: (input: {
    readonly acp: AcpSessionRuntimeShape;
    readonly sessionId: string;
    /** Every text block of `content`: the message and any file's note. */
    readonly text: string;
    readonly content: ReadonlyArray<EffectAcpSchema.ContentBlock>;
  }) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * Where the Usage page counts this agent's turns when it keeps no usage on
   * disk. Only for an agent whose turn `usage` is known to be the turn's own:
   * ACP doesn't say whether it is that or a running total, and agents differ
   * (Copilot's is a running total), so community agents have none. Unset for
   * an agent whose own files the usage scan reads (Grok), and for one that
   * reports no turn usage (Cursor, and Antigravity, whose `usage_update`
   * carries a bare total).
   */
  readonly usageLedger?: { readonly provider: UsageLedgerProvider };
  /**
   * The context fill an agent reports on its own updates rather than with
   * ACP's `usage_update` (Grok's `_meta.totalTokens`), and its window size.
   */
  readonly contextUsage?: {
    readonly usedTokens: (notification: EffectAcpSchema.SessionNotification) => number | undefined;
    readonly windowTokens?: (
      setup:
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ) => number | undefined;
  };
  /**
   * The agent's own conversation history, so a revert makes it forget the
   * reverted turns and a fork copies its conversation (Grok's `_x.ai/rewind/*`
   * and `_x.ai/session/fork`). Files stay Threadlines' to restore. Without it
   * a revert trims only Threadlines' turn list, and the agent remembers.
   */
  readonly conversationHistory?: AcpConversationHistory;
  /**
   * The `session/set_mode` mode for a turn's interaction mode, for an agent
   * that switches modes without listing them (Grok: `plan`, `default`).
   * Sent before every turn; the agent takes a repeat as a no-op.
   */
  readonly sessionModeForTurn?: (
    interactionMode: ProviderInteractionMode | undefined,
  ) => string | undefined;
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
  /**
   * `"native"` for agents Threadlines has never been tested with (the ACP
   * registry's), which it drives through their own controls instead of
   * guessing:
   * - the agent's mode is never changed from the runtime mode. Its mode
   *   options show with the other options, for the user to pick. (Mapping by
   *   name can land on a mode that never asks.) Permission requests are still
   *   answered by runtime mode;
   * - mode and model go through whichever API the agent offers: config
   *   options, else `session/set_mode` / `session/set_model`;
   * - an agent with no model choice gets one "Default" model that is never
   *   sent to it.
   * Default `"mapped"`: today's behaviour.
   */
  readonly sessionControls?: "mapped" | "native";
  /**
   * The agent refused a session or a turn with ACP's `auth_required`
   * (-32000). Lets a driver whose sign-in state is only known from such
   * answers mark the instance signed out at once.
   */
  readonly onAuthRequired?: (settings: Settings) => Effect.Effect<void>;
  readonly classifyPermissionRequest?: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => AcpPermissionQuestion | undefined;
  /**
   * A permission option whose "always" outlives the session (Grok's
   * `always-allow` saves a grant for the whole project). Never offered or
   * chosen; "Accept for session" then appears only for a real session grant.
   */
  readonly isLastingPermissionOption?: (option: EffectAcpSchema.PermissionOption) => boolean;
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
  /**
   * The same, read at each launch: for agents whose method is only known
   * once a sign-in has completed. Wins over `authMethodId`.
   */
  readonly resolveAuthMethodId?: () => string | undefined;
  /**
   * How long `authenticate` may take outside a sign-in flow. An agent that
   * starts a browser sign-in there would otherwise hang the launch; past the
   * limit the launch fails as `auth_required`.
   */
  readonly authenticateTimeoutMs?: number;
  /**
   * Fields this agent adds to every snapshot of its instance, read when the
   * snapshot is built. Must be cheap and never throw.
   */
  readonly snapshotExtras?: () => Partial<Pick<ServerProvider, "community">>;
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
   * probes each model's capabilities in the background: fx by switching
   * through its catalog, Cursor by listing it (`listModelOptions`). When
   * false the current session's options apply to every catalog entry.
   */
  readonly modelCapabilitiesVaryByModel?: boolean;
  /**
   * Every model's own options, read without switching the session's model,
   * or `undefined` when the agent answered in a shape this doesn't know. For
   * an agent that keeps a model switch beyond the session (Cursor saves it as
   * the user's CLI default): the capability probe reads this instead of
   * switching through the catalog, and probes no further when it fails.
   */
  readonly listModelOptions?: (
    acp: AcpSessionRuntimeShape,
  ) => Effect.Effect<ReadonlyArray<AcpModelOptions> | undefined, EffectAcpErrors.AcpError>;
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
