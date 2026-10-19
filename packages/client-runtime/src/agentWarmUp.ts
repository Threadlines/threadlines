import type {
  ModelSelection,
  OrchestrationWarmUpTurnInput,
  RuntimeMode,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";

/**
 * When the composer asks the server to start a thread's stopped agent while
 * the user types (docs/early-agent-start.md). The composer waits for a pause
 * in typing, then sends what `nextAgentWarmUp` returns, if anything.
 */

/** Typing pauses this long before a warm-up goes out. */
export const AGENT_WARM_UP_DEBOUNCE_MS = 400;

/**
 * The same warm-up again only after this long, while the user keeps typing.
 * The server stops an unused early agent 3 minutes after the last one.
 */
export const AGENT_WARM_UP_RENEW_MS = 60_000;

export interface AgentWarmUpInput {
  /** Settings → Threads → Start agents while you type. */
  readonly enabled: boolean;
  readonly threadId: ThreadId | null;
  /** The thread exists on the server (a new thread's draft doesn't yet). */
  readonly serverThreadExists: boolean;
  readonly hasText: boolean;
  /** A turn is running or starting: the message will steer or wait instead. */
  readonly turnActive: boolean;
  /** The room agent the message goes to; null for the thread's own agent. */
  readonly participantId: ThreadParticipantId | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface AgentWarmUpSent {
  readonly key: string;
  readonly atMs: number;
}

const warmUpKey = (target: OrchestrationWarmUpTurnInput) =>
  [
    target.threadId,
    target.participantId ?? "",
    target.modelSelection.instanceId,
    target.modelSelection.model,
    target.runtimeMode,
  ].join("\u0000");

/**
 * The warm-up to send now, or null: none applies, or the same one went out
 * less than `AGENT_WARM_UP_RENEW_MS` ago. A different target (agent, model,
 * access level, room recipient) goes out at once.
 */
export function nextAgentWarmUp(
  input: AgentWarmUpInput,
  lastSent: AgentWarmUpSent | null,
  nowMs: number,
): { readonly request: OrchestrationWarmUpTurnInput; readonly sent: AgentWarmUpSent } | null {
  if (
    !input.enabled ||
    input.threadId === null ||
    !input.serverThreadExists ||
    !input.hasText ||
    input.turnActive
  ) {
    return null;
  }
  const request: OrchestrationWarmUpTurnInput = {
    threadId: input.threadId,
    participantId: input.participantId,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
  };
  const key = warmUpKey(request);
  if (lastSent !== null && lastSent.key === key && nowMs - lastSent.atMs < AGENT_WARM_UP_RENEW_MS) {
    return null;
  }
  return { request, sent: { key, atMs: nowMs } };
}
