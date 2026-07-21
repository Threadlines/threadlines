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
  ProviderStartReviewInput,
  ProviderStartReviewResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderRealtimeAppendAudioInput,
  ProviderRealtimeListVoicesResult,
  ProviderRealtimeOutputModality,
  ProviderSubagentTranscriptInput,
  ProviderSubagentTranscriptResult,
  ProviderSteerTurnInput,
  MessageId,
  RuntimeThreadGoalSnapshot,
  ThreadGoalStatus,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
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
   * (Codex goal mode).
   */
  readonly threadGoals?: ProviderThreadGoalsMode;

  /**
   * Declares whether this adapter can open a session as a provider-side fork
   * of another thread's history (`ProviderSessionStartInput.forkFrom`).
   */
  readonly nativeThreadFork?: ProviderNativeThreadForkMode;

  /** Declares support for Codex-style thread realtime voice sessions. */
  readonly realtimeVoice?: ProviderRealtimeVoiceMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
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
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

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
   * Interrupt an active turn.
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
   * Read a spawned subagent's nested transcript for on-demand display.
   * Optional: drivers without provider-side subagent transcripts omit it.
   */
  readonly readSubagentTranscript?: (
    threadId: ThreadId,
    input: ProviderSubagentTranscriptInput,
  ) => Effect.Effect<ProviderSubagentTranscriptResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
