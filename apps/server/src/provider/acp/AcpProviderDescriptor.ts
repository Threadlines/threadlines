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
  ChatAttachment,
  ModelCapabilities,
  ProviderDriverKind,
  ProviderFailureCategory,
  ProviderInteractionMode,
  ProviderOptionSelection,
  ProviderRuntimeEvent,
  ProviderSubagentTranscriptEntry,
  ProviderUserInputAnswers,
  RuntimeMode,
  RuntimeUsageLimit,
  ServerProvider,
  ServerProviderDetection,
  ServerProviderModel,
  ServerProviderSkill,
  ThreadId,
  TurnId,
  UsageTokenTotals,
  UserInputQuestion,
} from "@threadlines/contracts";
import type { HttpClient } from "effect/http";
import type * as Duration from "effect/Duration";
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
import type { AcpAttachmentDelivery } from "./AcpPromptAttachments.ts";
import type { AcpPlanUpdate, AcpToolCallReport, AcpToolCallState } from "./AcpRuntimeModel.ts";
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

/** An ACP form elicitation request (`elicitation/create` or `session/elicitation`). */
export interface AcpElicitationFormRequest {
  readonly sessionId?: string;
  readonly mode?: string | null;
  readonly message: string;
  readonly requestedSchema?: {
    readonly type?: string | null;
    readonly title?: string | null;
    readonly description?: string | null;
    readonly properties?: Readonly<Record<string, unknown>> | null;
    readonly required?: ReadonlyArray<string> | null;
  } | null;
}

export type AcpElicitationFormResponse =
  | {
      readonly action: "accept";
      readonly content: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>;
    }
  | { readonly action: "decline" | "cancel" };

/**
 * An ACP form elicitation recognized as questions for the user (Antigravity's
 * `ask_question`, pairing `qN` choices with `qN_other` free-text fields).
 */
export interface AcpElicitationQuestions {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly responseForAnswers: (answers: ProviderUserInputAnswers) => AcpElicitationFormResponse;
}

/**
 * Plan mode for agents that plan through a prompt command and a plan file
 * rather than an ACP session mode (Antigravity's `/plan`).
 */
export interface AcpPromptPlanMode {
  /** Prepended to the turn's text in plan mode, e.g. `/plan `. */
  readonly promptPrefix: string;
  /**
   * Whether this tool call writes the plan file of the session `sessionId`
   * (the session asking; `undefined` when that isn't this one, and then
   * nothing is). Such writes are approved without asking (they never touch
   * the workspace) and are not shown as tool calls: the plan card stands for
   * them.
   */
  readonly isPlanFile: (toolCall: AcpToolCallState, sessionId: string | undefined) => boolean;
  /** The plan's markdown, when this plan-file write carries it. */
  readonly planMarkdown: (toolCall: AcpToolCallState) => string | undefined;
}

/** How an agent's own slash commands reach the composer; see `agentCommands`. */
export interface AcpAgentCommands {
  /**
   * Commands Threadlines does itself, left out of the list: plan mode is
   * Threadlines' `/plan`, a sign-in belongs in Settings. A user who types
   * one still sends it.
   */
  readonly hidden: ReadonlySet<string>;
  /**
   * The agent runs a skill when a message starts with `/<skill name>`, so the
   * skills `listSkills` finds join the `/` list too (`ServerProvider.slashSkills`).
   */
  readonly slashSkills: boolean;
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

/**
 * Why a prompt the agent answered as finished, or refused with an error,
 * really failed (Antigravity ends a turn normally on an upstream error).
 */
export interface AcpPromptFailure {
  /** The words the chat shows. */
  readonly errorMessage: string;
  readonly failureCategory?: ProviderFailureCategory;
  /** A plan's usage limit stopped the turn: when it resets, for the usage-limit notice. */
  readonly usageLimit?: RuntimeUsageLimit;
  /**
   * The agent can no longer continue this session (Antigravity's saved
   * thinking lost its signature). The session is stopped after the turn, and
   * the next message starts a new one seeded with the thread's history.
   */
  readonly sessionLost?: boolean;
}

/**
 * Reads how a prompt really ended (`AcpTurnMachineOptions.outcome`). `watch`
 * runs as each prompt goes out (it may note where the agent's own records
 * stand) and returns the check run when that prompt answers or fails.
 */
export interface AcpPromptOutcome {
  /** `model`: the picker slug the turn runs on, when known. */
  readonly watch: (
    sessionId: string,
    model: string | undefined,
  ) => Effect.Effect<AcpPromptOutcomeWatch>;
}

export interface AcpPromptOutcomeWatch {
  readonly check: (
    answer:
      | { readonly response: EffectAcpSchema.PromptResponse }
      /** What `session/prompt` failed with, usually an `AcpRequestError`. */
      | { readonly error: unknown },
  ) => Effect.Effect<AcpPromptFailure | undefined>;
}

/**
 * What a tool call the agent goes on with after its prompt answers is: a
 * command it awaits, a timer it set, or subagents it launched (a batch
 * counts each). `undefined` for one that ends with the prompt.
 */
export type AcpWorkAfterPrompt =
  | { readonly kind: "command" | "timer" }
  | { readonly kind: "subagents"; readonly count: number };

/**
 * An agent whose turns run on the turn machine (`AcpTurnMachine`,
 * Antigravity 1.5.10+): it answers its prompt while work it started goes on
 * and replies by itself when that work ends, so the turn stays open, working
 * and stoppable, until the work and the replies it wakes are done. Only for
 * an agent that sends `usage_update` after each model call: that update is
 * how a reply it started by itself is known to end. With `subagents`, the
 * hold on launched subagents follows the agent's records of them.
 */
export interface AcpTurnMachineOptions {
  readonly workAfterPrompt: (toolCall: AcpToolCallState) => AcpWorkAfterPrompt | undefined;
  /**
   * A message sent mid-turn goes as another `session/prompt`, which steers
   * the turn. Off, it waits for the turn to end, as for any agent.
   */
  readonly steer: boolean;
  /**
   * How long the turn waits without a word from the agent while only
   * commands and subagents hold it; past it, the turn ends. A timer the
   * agent set holds it with no limit (a timer is silent until it fires).
   */
  readonly silentLimit: Duration.Duration;
  /**
   * How long a reply the agent started by itself (or a wake a finished
   * command owes) may go without output before it counts as ended when its
   * closing `usage_update` never comes (default 2 minutes).
   */
  readonly replyQuietLimit?: Duration.Duration;
  /** How a prompt really ended, where the agent's answer can hide a failure. */
  readonly outcome?: AcpPromptOutcome;
}

/** A subagent a tool call launched, as the launch named it. */
export interface AcpSubagentLaunch {
  readonly role: string;
  readonly prompt: string;
}

/** What became of a launched subagent, by the agent's own records. */
export interface AcpSubagentState {
  /** `reported`: it sent the agent its report; `killed`: the agent stopped it. */
  readonly state: "working" | "reported" | "killed";
  /** Its report, when it has sent one. */
  readonly report?: string;
}

/**
 * Subagents an agent launches with a tool call that returns at once and
 * reports no end for (Antigravity's `invoke_subagent`): only the agent's own
 * records say which child a call started, whether it is done, and what it
 * did. With it, each launch shows as a subagent (`AcpSubagentRoster`), and
 * on the turn machine a launch holds the turn while its child is at work.
 */
export interface AcpSubagents {
  /** The subagents this tool call launches; `undefined` for any other call. */
  readonly launches: (toolCall: AcpToolCallState) => ReadonlyArray<AcpSubagentLaunch> | undefined;
  /**
   * The state of each launching call's child, by call id. A call the records
   * don't tie to its child is left out; `complete` is false when some record
   * didn't read, so a child left out may only be unreadable. `undefined`
   * when the records can't be read at all.
   */
  readonly states: (input: {
    readonly sessionId: string;
    readonly launchCallIds: ReadonlyArray<string>;
  }) => Effect.Effect<
    | {
        readonly byLaunch: ReadonlyMap<string, AcpSubagentState>;
        readonly complete: boolean;
      }
    | undefined
  >;
  /**
   * The child a launching call started and its steps, or `undefined` when
   * the records don't say which child it started.
   */
  readonly transcript: (input: {
    readonly sessionId: string;
    readonly launchCallId: string;
  }) => Effect.Effect<
    | {
        readonly childId: string;
        readonly launch: AcpSubagentLaunch;
        readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
        /** Only the transcript's end was read. */
        readonly truncated: boolean;
      }
    | undefined
  >;
  /** What the subagent view says when `transcript` finds nothing. */
  readonly unrecordedMessage: string;
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

/** What a descriptor's `sideRuntime` hook is handed. */
export interface AcpSideRuntimeInput<Settings extends AcpProviderSettings> {
  readonly settings: Settings;
  /** The thread's checkout, which the side runtime reads. */
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** `review` is an independent review: also no project instructions or memory. */
  readonly kind: "ask" | "review";
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

/** A locked-down agent process for a room's side answer. */
export interface AcpSideRuntime {
  /** Replaces the descriptor's `spawn` for this process. */
  readonly spawn: AcpSpawnInput;
  /**
   * How the agent's approval requests are answered, never by the user.
   * `decline`: each is turned down once. `approve-once`: each is allowed once,
   * for an agent whose own kernel sandbox (checked by `verifyStarted`) is
   * what keeps it read-only, and that ends its whole turn on a declined step.
   */
  readonly approvals: "decline" | "approve-once";
  /**
   * Run once the agent has started its session. Fails when the agent did not
   * come up locked down, and the side answer is then refused.
   */
  readonly verifyStarted: Effect.Effect<void, EffectAcpErrors.AcpError>;
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
   * Where `install` puts the agent's command (every name it links). A copy
   * found at one of these that cannot start is reinstalled by running
   * `install` again; a copy anywhere else is not the installer's to replace.
   * Leave out on platforms where the location is not known.
   */
  readonly installerBinaries?: (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => ReadonlyArray<string>;
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
  /**
   * How this agent runs a room's side answer or review (docs/design/
   * rooms-slice-2.md): read-only, never asking the user, with nothing from the
   * user's or the project's settings loaded. Absent: the agent never answers
   * on the side. Fails when it cannot promise that here; whatever it sets up
   * lives in the scope and is torn down with the process. The generic core
   * adds the rest: only the room's read tools, every approval and question
   * declined, no mode changes, and a fresh start (never a fork).
   */
  readonly sideRuntime?: (
    input: AcpSideRuntimeInput<Settings>,
  ) => Effect.Effect<AcpSideRuntime, EffectAcpErrors.AcpError, Scope.Scope>;
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
  /** Turns run on the turn machine (`AcpTurnMachineOptions`); `steer` and `agentTurns` don't apply. */
  readonly turnMachine?: AcpTurnMachineOptions;
  /** Subagents launched by a tool call, read from the agent's own records. */
  readonly subagents?: AcpSubagents;
  /**
   * Where the Usage page counts this agent's turns when it keeps no usage on
   * disk. Only for an agent whose turn `usage` is known to be the turn's own:
   * ACP doesn't say whether it is that or a running total, and agents differ
   * (Copilot's is a running total), so community agents have none. Unset for
   * an agent whose own files the usage scan reads (Grok), and for one that
   * reports no turn usage (Cursor).
   */
  readonly usageLedger?: { readonly provider: UsageLedgerProvider };
  /**
   * The agent's own reading of a prompt's `usage`, where the generic one
   * (`acpTurnUsageTotals`, which takes input to include cached reads, as fx's
   * does) would miscount it. Antigravity leaves cached reads out of input.
   */
  readonly turnUsageTotals?: (
    usage: EffectAcpSchema.Usage | null | undefined,
  ) => UsageTokenTotals | null;
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
   * For an agent with no `conversationHistory`: a revert stops what the
   * session runs and ends it (`conversationRollback: "new-session"`), and
   * ProviderService forgets the saved conversation, so the next message
   * opens a new one seeded with the turns kept (Antigravity). Without it the
   * agent remembers them, and the revert says so.
   */
  readonly rollbackByNewSession?: boolean;
  /**
   * The agent's slash commands (ACP `available_commands_update`) reach the
   * composer's `/` list for the session's thread, as live state on the
   * provider status (`AcpAdapterOptions.onSessionCommands`), and a typed
   * `/name` the session lists goes as the agent's own command. Absent: the
   * list is ignored, as for agents whose lists were never checked here.
   */
  readonly agentCommands?: AcpAgentCommands;
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
    /** The modes the session offers; empty when it lists none. */
    readonly availableModeIds: ReadonlyArray<string>;
  }) => string | undefined;
  /**
   * Checks the agent's `initialize` answer before a session opens, e.g. that
   * it is a version Threadlines can run. A failure stops the start and its
   * message is what the user sees.
   */
  readonly verifyAgent?: (
    settings: Settings,
    response: EffectAcpSchema.InitializeResponse,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
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
   * Recognizes an agent's own question form inside an ACP form elicitation
   * (Antigravity's `ask_question`) so it renders as a single question card
   * instead of a raw form. Anything else falls back to the generic form UI.
   */
  readonly classifyElicitationForm?: (
    request: AcpElicitationFormRequest,
  ) => AcpElicitationQuestions | undefined;
  /**
   * The agent accepts `type: "http"` MCP servers in `session/new` /
   * `session/resume` / `session/load` even though its `initialize` answer
   * omits `agentCapabilities.mcpCapabilities.http` (Antigravity 1.5,
   * google-antigravity/antigravity-cli#1604).
   */
  readonly assumeHttpMcp?: boolean;
  /**
   * Called after an ephemeral probe, sign-in verification, or text-generation
   * session has closed and its process has exited, so the descriptor can clean
   * up throwaway conversation records the agent wrote to its profile.
   */
  readonly onEphemeralSessionClosed?: (sessionId: string) => Effect.Effect<void>;
  /**
   * A permission option whose "always" outlives the session (Grok's
   * `always-allow` saves a grant for the whole project). Never offered or
   * chosen; "Accept for session" then appears only for a real session grant.
   */
  readonly isLastingPermissionOption?: (option: EffectAcpSchema.PermissionOption) => boolean;
  /**
   * Offers "Always allow this session" client-side when a permission request
   * includes `allow_once` without `allow_always` (e.g. Antigravity's `agy acp`).
   * Grants live in memory on the open session and answer matching subsequent
   * requests with `allow_once`, never persisting rules on disk.
   */
  readonly clientSessionApprovals?: boolean;
  /** A risk the agent attached to a permission option, shown with the approval. */
  readonly permissionOptionWarning?: (
    option: EffectAcpSchema.PermissionOption,
  ) => string | undefined;
  /**
   * Rewrites each session update before the core reads it: the runtime
   * events (and so what is stored and shown) carry only what this returns.
   * The opt-in protocol log still records the wire as it came. Antigravity
   * bounds its tool text and leaves out inline images here.
   */
  readonly normalizeSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  /**
   * Rewrites each tool call after its updates are merged, for a call the
   * agent describes as something it isn't (Antigravity runs MCP tools it
   * left out of its context through a command, `call_mcp_tool`). Given the
   * report that just arrived, so it can tell what that report positively
   * says from what earlier ones did. Also applied to a permission request's
   * call, where it may change what the request shows but never its kind.
   */
  readonly normalizeToolCall?: (
    toolCall: AcpToolCallState,
    report: AcpToolCallReport,
  ) => AcpToolCallState;
  /**
   * How each attachment reaches this agent (`AcpPromptAttachments`), given
   * what its `initialize` answer says it reads. Absent, or `undefined` for an
   * attachment: an image goes inline and any other file as a note naming its
   * staged path, as for every ACP agent.
   */
  readonly attachmentDelivery?: (
    attachment: ChatAttachment,
    promptCapabilities: EffectAcpSchema.PromptCapabilities | null | undefined,
  ) => AcpAttachmentDelivery | undefined;
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
  /**
   * Folds out-of-band state (e.g. a background usage read that finished while
   * model discovery was still running) into a freshly checked snapshot inside
   * the same atomic commit. Must be cheap and never throw.
   */
  readonly reconcileSnapshot?: (previous: ServerProvider, next: ServerProvider) => ServerProvider;
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
   * The skills the agent loads, read from disk for the provider snapshot
   * (ACP has no call that lists them before a session). Asked for on each
   * status check of an installed agent; must never fail.
   */
  readonly listSkills?: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<ReadonlyArray<ServerProviderSkill>>;
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
   * Probes every model's own options inside the single discovery (or sign-in
   * verification) session, for an agent that starts slowly and switches models
   * in milliseconds (Antigravity's per-model `thought_level`). Unlike
   * `listModelOptions`, this runs during initial discovery rather than opening
   * a second background probe session.
   */
  readonly discoverModelOptions?: (
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
