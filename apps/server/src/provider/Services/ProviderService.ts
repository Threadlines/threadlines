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
  ProviderSubagentTranscriptInput,
  ProviderSubagentTranscriptResult,
  ProviderTurnStartResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

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
  }) => Effect.Effect<RuntimeThreadGoalSnapshot, ProviderServiceError>;

  /**
   * Pause an active goal before stopping its live provider session.
   * Never recovers a cold session. Returns the authoritative provider state,
   * or null when there is no live goal-capable session.
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
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
    readonly targetUserMessageId?: MessageId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Read a spawned subagent's nested transcript for on-demand display.
   * Fails cleanly when the routed driver has no transcript support.
   */
  readonly readSubagentTranscript: (
    input: ProviderSubagentTranscriptInput,
  ) => Effect.Effect<ProviderSubagentTranscriptResult, ProviderServiceError>;

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
