/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderExternalThreadListInput,
  ProviderExternalThreadListResult,
  ProviderExternalThreadSnapshot,
  ProviderStartReviewInput,
  ProviderStartReviewResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderRealtimeAppendAudioInput,
  ProviderRealtimeListVoicesResult,
  ProviderRealtimeOutputModality,
  ProviderSubagentInputRequest,
  ProviderSubagentInputResult,
  ProviderCommandOutputResult,
  McpAppToolResult,
  ProviderSubagentTranscriptInput,
  ProviderSubagentTranscriptResult,
  ProviderSteerTurnInput,
  MessageId,
  ModelSelection,
  RuntimeThreadGoalSnapshot,
  ThreadGoalStatus,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
  RuntimeTaskId,
} from "@threadlines/contracts";
import type { McpResourceContent, McpToolUi } from "@threadlines/shared/mcpApps";
import type {
  OrchestrationWorkflowRun,
  WorkflowCommandLocation,
  WorkflowReadRunFileResult,
  WorkflowRunFileKind,
  WorkflowSaveCommandResult,
} from "@threadlines/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";
export type ProviderManualContextCompactionMode = "supported" | "unsupported";
export type ProviderActiveTurnSteeringMode = "supported" | "unsupported";
export type ProviderReviewStartMode = "supported" | "unsupported";
export type ProviderThreadGoalsMode = "supported" | "unsupported";
export type ProviderNativeThreadForkMode = "supported" | "unsupported";
export type ProviderRealtimeVoiceMode = "supported" | "unsupported";

/** Partial goal update: omitted fields keep their provider-side values. */
export interface ProviderSetThreadGoalInput {
  readonly threadId: ThreadId;
  readonly objective?: string;
  readonly status?: ThreadGoalStatus;
  readonly tokenBudget?: number | null;
  /** Who asked: the user, or Threadlines itself (pausing a goal before it
   *  stops a session). Codex records only the user's edits in the model's
   *  history. */
  readonly origin: "user" | "automatic";
  /** The model the goal's work should run on, for providers that start that
   *  work as a turn of their own (Claude). */
  readonly modelSelection?: ModelSelection;
}

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;

  /**
   * Declares whether this adapter can ask the provider to compact context on demand.
   */
  readonly manualContextCompaction?: ProviderManualContextCompactionMode;

  /**
   * Declares whether this adapter can add user input to the active running turn.
   */
  readonly activeTurnSteering?: ProviderActiveTurnSteeringMode;

  /**
   * Declares whether this adapter can start native provider code reviews.
   */
  readonly reviewStart?: ProviderReviewStartMode;

  /**
   * Declares whether this adapter supports long-horizon thread goals
   * (Codex and Claude goal mode).
   */
  readonly threadGoals?: ProviderThreadGoalsMode;

  /**
   * The provider keeps a session's own queued work in a server of its own,
   * past the runtime (OpenCode): stopping the runtime doesn't end what it
   * left, so outside work's mark clears only at a quiet fresh start
   * (`quietResume`), never at a stop.
   */
  readonly sessionOutlivesRuntime?: boolean;

  /**
   * Declares whether a supported goal can be paused and resumed. Absent means
   * it can. Claude's goals cannot: they survive a stopped session as they are.
   */
  readonly threadGoalPause?: ProviderThreadGoalsMode;

  /**
   * Declares whether this adapter can open a session as a provider-side fork
   * of another thread's history (`ProviderSessionStartInput.forkFrom`).
   */
  readonly nativeThreadFork?: ProviderNativeThreadForkMode;

  /** Declares support for Codex-style thread realtime voice sessions. */
  readonly realtimeVoice?: ProviderRealtimeVoiceMode;

  /**
   * Whether `rollbackThread` rewinds the provider's own conversation. `none`
   * (most ACP agents) trims only Threadlines' turn list: the agent still
   * remembers the reverted turns, and a revert says so. Default `native`. A
   * rollback's own `conversationRolledBack` overrides it, for an agent that
   * can rewind only to the turns it knows the positions of (Grok).
   */
  readonly conversationRollback?: "native" | "none";

  /**
   * Whether a session may be started before its first message, while the user
   * is still typing (`ProviderService.startEarlySession`). Only for drivers
   * whose start sends nothing to a model, saves nothing in the provider's own
   * lists, and can't stop on a question. Absent: never started early.
   */
  readonly earlySessionStart?: "supported" | "unsupported";
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
  /**
   * From `rollbackThread`: whether the provider's own conversation forgot the
   * turns this time. Absent: as `capabilities.conversationRollback` says.
   */
  readonly conversationRolledBack?: boolean;
}

export interface ProviderRollbackThreadOptions {
  /**
   * Provider-native file rewind target. For providers that checkpoint files at
   * user-message boundaries, this is the first user message being removed by
   * the rollback.
   */
  readonly targetUserMessageId?: MessageId;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;
  /**
   * `sendTurn` and `steerTurn` send their input's `deviceNote` their own way.
   * Absent: the provider service puts the note in front of `input` before the
   * adapter sees it (`withDeviceNoteInFront`).
   */
  readonly sendsDeviceNote?: true;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /** Discover root conversations stored by this provider outside Threadlines. */
  readonly listExternalThreads?: (
    input: ProviderExternalThreadListInput,
  ) => Effect.Effect<ProviderExternalThreadListResult, TError>;

  /** Read and compatibility-check one external conversation before import. */
  readonly readExternalThread?: (input: {
    readonly providerThreadId: string;
    readonly expectedCwd: string;
  }) => Effect.Effect<ProviderExternalThreadSnapshot, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Add user input to the active provider turn.
   *
   * Unsupported adapters should omit this method and leave
   * `capabilities.activeTurnSteering` unset or `"unsupported"`.
   */
  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Start a native provider review against an active provider session.
   */
  readonly startReview?: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderStartReviewResult, TError>;

  /**
   * Interrupt an active turn. One call must stop everything: input steered
   * into the turn that the provider has not consumed yet is discarded, not
   * started as a new turn. The turn settles as `interrupted`, never as a
   * failure or runtime error, even when the provider reports the stop in
   * error form.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  readonly realtimeStart?: (
    threadId: ThreadId,
    options?: { readonly outputModality?: ProviderRealtimeOutputModality },
  ) => Effect.Effect<void, TError>;
  readonly realtimeStop?: (threadId: ThreadId) => Effect.Effect<void, TError>;
  readonly realtimeAppendAudio?: (
    input: ProviderRealtimeAppendAudioInput,
  ) => Effect.Effect<void, TError>;
  readonly realtimeListVoices?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderRealtimeListVoicesResult, TError>;

  /**
   * Ask the provider to summarize older context for an active session.
   *
   * Unsupported adapters should omit this method and leave
   * `capabilities.manualContextCompaction` unset or `"unsupported"`.
   */
  readonly compactContext?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * The user moved on to another agent while background commands this
   * session started are still running: stop counting them as work the agent
   * is waiting on, the same as when the user's next message starts a new
   * turn. Background agents keep counting. Drivers without background
   * commands omit it.
   */
  readonly releaseBackgroundCommands?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Stops one background task (an agent, a workflow, a command) this session
   * started, leaving the session and its other tasks running. Resolves to
   * false when the session has no such task. The task's end comes back as the
   * usual `task.completed`. Drivers that set `stoppable` on `task.started`
   * implement it; others omit it.
   */
  readonly stopBackgroundTask?: (
    threadId: ThreadId,
    taskId: RuntimeTaskId,
  ) => Effect.Effect<boolean, TError>;

  /**
   * Plugins or skills changed outside the sessions, from Settings. Drivers whose live sessions do
   * not notice such changes on their own apply them, no later than each session's next turn.
   * Drivers whose runtime watches for changes itself omit it.
   */
  readonly noteExtensionsChanged?: () => Effect.Effect<void>;

  /**
   * Attach or update a long-horizon goal on the thread's provider session.
   * Optional; must be present when `capabilities.threadGoals` is
   * `"supported"`. Returns the provider's authoritative goal state.
   */
  readonly setThreadGoal?: (
    input: ProviderSetThreadGoalInput,
  ) => Effect.Effect<RuntimeThreadGoalSnapshot, TError>;

  /**
   * Read the provider's authoritative goal state without mutating it.
   * Optional; must be present when `capabilities.threadGoals` is `"supported"`.
   */
  readonly getThreadGoal?: (
    threadId: ThreadId,
  ) => Effect.Effect<RuntimeThreadGoalSnapshot | null, TError>;

  /**
   * Detach the thread's goal. Optional; see `setThreadGoal`.
   */
  readonly clearThreadGoal?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
    options?: ProviderRollbackThreadOptions,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Permanently delete the provider-native transcript/thread when supported.
   *
   * Adapters that do not expose a provider-side delete operation should leave
   * this undefined; ProviderService falls back to stopping their runtime
   * session while still clearing Threadlines' persisted runtime binding.
   */
  readonly deleteThread?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * A workflow run's files, from the folders the run itself named: its
   * script, its result, one agent's transcript, and saving the script as a
   * command. Needs no live session, so a run stays readable after a restart
   * or a switch to another provider. Drivers without workflow runs omit it.
   */
  readonly workflowRuns?: {
    readonly readRunFile: (input: {
      readonly run: OrchestrationWorkflowRun;
      readonly file: WorkflowRunFileKind;
    }) => Effect.Effect<WorkflowReadRunFileResult, TError>;
    readonly readAgentTranscript: (input: {
      readonly run: OrchestrationWorkflowRun;
      readonly agentId: string;
      /** The thread's checkout, for showing paths relative to it. */
      readonly cwd?: string;
      readonly limit?: number;
      readonly offset?: number;
      readonly fromEnd?: boolean;
    }) => Effect.Effect<ProviderSubagentTranscriptResult, TError>;
    readonly saveCommand: (input: {
      readonly run: OrchestrationWorkflowRun;
      readonly location: WorkflowCommandLocation;
      /** The thread's checkout: a project command goes in its repository. */
      readonly cwd: string;
      readonly overwrite: boolean;
      readonly dryRun: boolean;
    }) => Effect.Effect<WorkflowSaveCommandResult, TError>;
  };

  /**
   * Read a spawned subagent's nested transcript for on-demand display.
   * Optional: drivers without provider-side subagent transcripts omit it.
   */
  readonly readSubagentTranscript?: (
    threadId: ThreadId,
    input: ProviderSubagentTranscriptInput,
  ) => Effect.Effect<ProviderSubagentTranscriptResult, TError>;

  /**
   * What a command the session is running now has printed so far, by the
   * tool call that started it. Optional: drivers whose output already
   * streams as `command_output` deltas omit it. Answers `unavailable` for a
   * tool call the session doesn't know, so another session can be asked.
   */
  readonly readCommandOutput?: (
    threadId: ThreadId,
    toolCallId: string,
  ) => Effect.Effect<ProviderCommandOutputResult, TError>;

  /**
   * MCP Apps (docs/mcp-apps.md), through the session's own MCP client and
   * with no model turn. Optional: providers whose runtime cannot reach its
   * MCP servers outside a turn omit them.
   *
   * - `readMcpResource`: a server's `ui://` resource, as `resources/read`
   *   returns its contents.
   * - `callMcpTool`: a tool on a server, with no approval prompt (the caller
   *   has already decided it may run).
   * - `readMcpToolUi`: a tool's app metadata as its server declares it now;
   *   null for a tool that declares none, undefined when the runtime cannot
   *   say.
   */
  readonly readMcpResource?: (
    threadId: ThreadId,
    input: { readonly server: string; readonly uri: string },
  ) => Effect.Effect<ReadonlyArray<McpResourceContent>, TError>;
  readonly callMcpTool?: (
    threadId: ThreadId,
    input: {
      readonly server: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
  ) => Effect.Effect<McpAppToolResult, TError>;
  readonly readMcpToolUi?: (
    threadId: ThreadId,
    input: { readonly server: string; readonly tool: string },
  ) => Effect.Effect<McpToolUi | null | undefined, TError>;

  /**
   * Send a user message straight to a spawned subagent, starting a turn on
   * its own thread. Optional: only providers whose runtime accepts direct
   * input to a child (Codex) implement it.
   */
  readonly sendSubagentInput?: (
    threadId: ThreadId,
    input: ProviderSubagentInputRequest,
  ) => Effect.Effect<ProviderSubagentInputResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
