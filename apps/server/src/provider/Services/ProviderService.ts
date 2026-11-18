/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderRealtimeAppendAudioInput,
  ProviderRealtimeListVoicesInput,
  ProviderRealtimeListVoicesResult,
  ProviderRealtimeStartInput,
  ProviderRealtimeStopInput,
  ProviderInstanceId,
  MessageId,
  ModelSelection,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderExternalThreadListInput,
  ProviderExternalThreadListResult,
  ProviderExternalThreadSnapshot,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStartReviewInput,
  ProviderStartReviewResult,
  ProviderSteerTurnInput,
  ProviderStopSessionInput,
  RuntimeThreadGoalSnapshot,
  ThreadGoalStatus,
  ThreadId,
  ProviderSubagentInputRequest,
  ProviderSubagentInputResult,
  ProviderCommandOutputInput,
  ProviderCommandOutputResult,
  ProviderSubagentTranscriptInput,
  ProviderSubagentTranscriptResult,
  ProviderTurnStartResult,
  OrchestrationWorkflowRun,
  WorkflowCommandLocation,
  WorkflowReadRunFileResult,
  WorkflowRunFileKind,
  WorkflowSaveCommandResult,
  RuntimeTaskId,
  RuntimeMode,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderAdapterError, ProviderServiceError } from "../Errors.ts";
import type {
  NativeSessionExport,
  NativeSessionImportInput,
  NativeSessionImportResult,
} from "../nativeSession.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
  ProviderStopConfirmation,
} from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
/** One agent's running session, as `agentSession` finds it. */
export interface ProviderAgentSession {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  /** The session key to address the adapter with. */
  readonly sessionKey: ThreadId;
  /** The provider's own id for the session's conversation, when it has one. */
  readonly providerThreadId: string | null;
}

export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Starts a session before its first message, while the user types
   * (docs/early-agent-start.md). Reserves at once and starts in the
   * background, so it never holds up the caller. It isn't the thread's until something uses
   * it (`adoptEarlySession`, or any turn, goal, review or voice call): until
   * then its events should be ignored, and it stops on its own once the
   * typing stops. Answers what happened instead when it doesn't start: the
   * driver doesn't allow it, one is already waiting (renewed), another start
   * holds the key (busy), the limit is reached, or this checkout's starts did
   * something on their own.
   */
  readonly startEarlySession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput & { readonly providerInstanceId: ProviderInstanceId },
  ) => Effect.Effect<
    "started" | "renewed" | "busy" | "limit" | "blocked" | "unsupported",
    ProviderServiceError
  >;

  /**
   * Makes the key's early session the thread's, waiting for one still
   * starting. Returns it as it started, when there was one.
   */
  readonly adoptEarlySession: (threadId: ThreadId) => Effect.Effect<ProviderSession | undefined>;

  /** True while the key's runtime is an early session nobody has used. */
  readonly isEarlySession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * The instance an early start for the key is still starting, if one is:
   * whoever adopts the session meanwhile waits for that start.
   */
  readonly earlyStartInFlight: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderInstanceId | undefined>;

  /**
   * An early session started work or asked the user something on its own:
   * stop it, and start no more early in that checkout on that instance.
   */
  readonly abandonEarlySession: (input: {
    readonly threadId: ThreadId;
    readonly reason: "turn_started" | "asked_user";
  }) => Effect.Effect<void>;

  readonly listExternalThreads: (
    input: ProviderExternalThreadListInput,
  ) => Effect.Effect<ProviderExternalThreadListResult, ProviderServiceError>;

  readonly readExternalThread: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThreadId: string;
    readonly expectedCwd: string;
  }) => Effect.Effect<ProviderExternalThreadSnapshot, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Add user input to a running provider turn.
   */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Start a native provider review on an active provider session.
   */
  readonly startReview: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderStartReviewResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly realtimeStart?: (
    input: ProviderRealtimeStartInput,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly realtimeStop?: (
    input: ProviderRealtimeStopInput,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly realtimeAppendAudio?: (
    input: ProviderRealtimeAppendAudioInput,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly realtimeListVoices?: (
    input: ProviderRealtimeListVoicesInput,
  ) => Effect.Effect<ProviderRealtimeListVoicesResult, ProviderServiceError>;

  /**
   * Stop counting a live session's background commands as work it is
   * waiting on (see ProviderAdapter.releaseBackgroundCommands). Does nothing
   * when the session is not running or its driver has no such commands.
   */
  readonly releaseBackgroundCommands: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop one background task in a live session (see
   * ProviderAdapter.stopBackgroundTask). False when the session is not
   * running, its driver can't stop one task, or it has no such task.
   */
  readonly stopBackgroundTask: (input: {
    readonly threadId: ThreadId;
    readonly taskId: RuntimeTaskId;
  }) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * A workflow run's files (see ProviderAdapter.workflowRuns), read through
   * the provider instance that ran it. Works with no session running.
   */
  readonly readWorkflowRunFile: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly run: OrchestrationWorkflowRun;
    readonly file: WorkflowRunFileKind;
  }) => Effect.Effect<WorkflowReadRunFileResult, ProviderServiceError>;
  readonly readWorkflowAgentTranscript: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly run: OrchestrationWorkflowRun;
    readonly agentId: string;
    readonly cwd?: string;
    readonly limit?: number;
    readonly offset?: number;
    readonly fromEnd?: boolean;
  }) => Effect.Effect<ProviderSubagentTranscriptResult, ProviderServiceError>;
  readonly saveWorkflowCommand: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly run: OrchestrationWorkflowRun;
    readonly location: WorkflowCommandLocation;
    readonly cwd: string;
    readonly overwrite: boolean;
    readonly dryRun: boolean;
  }) => Effect.Effect<WorkflowSaveCommandResult, ProviderServiceError>;

  /**
   * One provider instance's plugins or skills changed from Settings; tells its live sessions (see
   * ProviderAdapter.noteExtensionsChanged). Does nothing for drivers that notice on their own.
   */
  readonly noteExtensionsChanged: (input: {
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<void>;

  /**
   * The native conversation one session key continues: its provider instance
   * and the provider's own thread or session id. From the live runtime when
   * there is one, else from the persisted binding. Null when there is none.
   */
  readonly readConversation: (input: { readonly threadId: ThreadId }) => Effect.Effect<{
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThreadId: string;
  } | null>;

  /**
   * Ask the active provider session to compact its context.
   */
  readonly compactContext: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Attach or update a long-horizon goal on the thread's provider session.
   * Fields other than `threadId` are partial; omitted ones keep their
   * provider-side values. Returns the provider's authoritative goal state.
   */
  readonly setThreadGoal: (input: {
    readonly threadId: ThreadId;
    readonly objective?: string;
    readonly status?: ThreadGoalStatus;
    readonly tokenBudget?: number | null;
    /** The model the goal's work runs on, where the provider starts that
     *  work itself (Claude). */
    readonly modelSelection?: ModelSelection;
    /** What the agent reads ahead of the goal's work (a lead chat's role).
     *  See `ProviderSetThreadGoalInput.context`. */
    readonly context?: string;
    /** Who asked; the user when absent. See `ProviderSetThreadGoalInput.origin`. */
    readonly origin?: "user" | "automatic";
  }) => Effect.Effect<RuntimeThreadGoalSnapshot, ProviderServiceError>;

  /**
   * The goal the thread's live provider session holds, as the provider says
   * it; null when it holds none, or there is no live goal-capable session.
   * Never recovers a cold session.
   */
  readonly getThreadGoal: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<RuntimeThreadGoalSnapshot | null, ProviderServiceError>;

  /**
   * Pause an active goal before stopping its live provider session.
   * Never recovers a cold session. Returns the authoritative provider state
   * (still active where goals cannot pause), or null when there is no live
   * goal-capable session.
   */
  readonly pauseThreadGoalForStop: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<RuntimeThreadGoalSnapshot | null, ProviderServiceError>;

  /**
   * Detach the thread's goal.
   */
  readonly clearThreadGoal: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Ends every runtime of a thread and proves it gone, before the thread
   * moves to another computer (docs/design/fleet.md, Part 3b, "The
   * barrier"): each session whose key belongs to the thread (its own agent,
   * room agents, side answers, early starts) is stopped, then every driver
   * confirms its processes, and what they started, exited. `unconfirmed`
   * when any can't be proven, with why. It doesn't fence the thread: the
   * caller must already have stopped new sessions (ThreadSessionAdmission).
   */
  readonly quiesceThread: (threadId: ThreadId) => Effect.Effect<ProviderStopConfirmation>;

  /**
   * The thread's own agent session, to carry with the thread to another
   * computer (docs/design/fleet.md, Part 3d): read from its saved binding
   * through the driver that wrote it. Null when the thread has none, or its
   * driver can't carry one. Read while the thread is quiesced and fenced,
   * so its files no longer change.
   */
  readonly exportNativeSession: (threadId: ThreadId) => Effect.Effect<NativeSessionExport | null>;

  /**
   * Writes a session another computer carried into `instanceId`'s own home
   * (its driver's `importNativeSession`). Refused when the instance's driver
   * can't take one.
   */
  readonly importNativeSession: (
    input: NativeSessionImportInput & { readonly instanceId: ProviderInstanceId },
  ) => Effect.Effect<NativeSessionImportResult>;

  /**
   * Binds a thread to an imported session: its next start on `instanceId`
   * resumes `cursor`. No runtime starts now.
   */
  readonly adoptNativeSession: (input: {
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly cursor: unknown;
    readonly runtimeMode: RuntimeMode;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Takes back the binding `adoptNativeSession` wrote for a thread whose move
   * didn't land here: the thread never came to exist, so its binding goes.
   */
  readonly forgetNativeSession: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Ends the thread's own agent session and forgets its resume cursor, so the
   * next start opens a new conversation: a carried session that can't be
   * used here (docs/design/fleet.md, Part 3d).
   */
  readonly dropResumeCursor: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   * `conversationRolledBack` is false when the provider cannot forget turns
   * (see `ProviderAdapterCapabilities.conversationRollback`).
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
    readonly targetUserMessageId?: MessageId;
  }) => Effect.Effect<{ readonly conversationRolledBack: boolean }, ProviderServiceError>;

  /**
   * Read a spawned subagent's nested transcript for on-demand display.
   * Fails cleanly when the routed driver has no transcript support.
   */
  readonly readSubagentTranscript: (
    input: ProviderSubagentTranscriptInput,
  ) => Effect.Effect<ProviderSubagentTranscriptResult, ProviderServiceError>;

  /**
   * What a command one of the thread's agents is running now has printed
   * (see the adapter's `readCommandOutput`). Never starts a session; answers
   * `unavailable` when no live one can read it.
   */
  readonly readCommandOutput: (
    input: ProviderCommandOutputInput,
  ) => Effect.Effect<ProviderCommandOutputResult, ProviderServiceError>;

  /**
   * The running session of one agent of a thread, by its session key, for an
   * operation that must reach exactly that agent's runtime (an MCP app card
   * calling the MCP server its agent used, docs/mcp-apps.md). `recover`
   * starts the session again from its binding; otherwise a session that is
   * not running answers null, as does one bound to another provider instance
   * than `providerInstanceId`.
   */
  readonly agentSession: (input: {
    readonly sessionKey: ThreadId;
    readonly providerInstanceId: ProviderInstanceId | null;
    readonly recover: boolean;
  }) => Effect.Effect<ProviderAgentSession | null, ProviderServiceError>;

  /** Send a user message straight to a spawned subagent (see the adapter's
   *  `sendSubagentInput`). */
  readonly sendSubagentInput: (
    input: ProviderSubagentInputRequest,
  ) => Effect.Effect<ProviderSubagentInputResult, ProviderServiceError>;

  /**
   * Delete provider-owned runtime state for a thread.
   *
   * Providers with native transcript deletion should remove that transcript;
   * unsupported providers stop any active runtime and clear the persisted
   * binding so deleted Threadlines threads are not recovered later.
   */
  readonly deleteThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "threadlines/provider/Services/ProviderService",
) {}
