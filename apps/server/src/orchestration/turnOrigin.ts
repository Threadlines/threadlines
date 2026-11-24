import type {
  OrchestrationMessage,
  OrchestrationThread,
  ProviderTurnOrigin,
  ThreadMessageOrigin,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { isAttachedChild } from "@threadlines/shared/childThreads";

import { isContinueTrigger } from "./continueTurns.ts";
import { isOutsideMarked } from "./outsideTurns.ts";

/**
 * Who the message that starts a turn came from (ProviderTurnOrigin), read
 * from the marks the message and its turn already carry. A person's message
 * is one a client app sent for its user: the server stamps the device it came
 * from (`sentFrom`) and the composer marks what they typed (`composer`). A
 * message with no mark is one the server wrote, so it never counts as a
 * person's. A user's own script on the app's sign-in also gets a device
 * stamp, and counts as a person.
 */
export function turnMessageOrigin(input: {
  readonly message: Pick<
    OrchestrationMessage,
    "fromAgent" | "fromThread" | "fromOutside" | "composer" | "sentFrom" | "trigger"
  >;
  /** The turn start's own marks (`thread.turn-start-requested`), when it has them. */
  readonly fromThread?: unknown;
  readonly fromOutside?: unknown;
  readonly scheduledTaskId?: unknown;
  /** A side answer another agent in the room asked for. */
  readonly askedByAgent?: boolean;
}): ProviderTurnOrigin {
  const { message } = input;
  if (input.fromOutside !== undefined || message.fromOutside !== undefined) return "outside_agent";
  if (input.fromThread !== undefined || message.fromThread !== undefined) return "other_thread";
  if (input.askedByAgent === true || message.fromAgent !== undefined) return "room_agent";
  if (input.scheduledTaskId !== undefined) return "task";
  // Moving the thread to another account is the user's choice from the
  // limit notice, though Threadlines wrote the words.
  if (
    message.composer !== undefined ||
    message.sentFrom !== undefined ||
    message.trigger === "accountSwitch"
  ) {
    return "person";
  }
  return "automatic";
}

/**
 * Whether a completed turn's reply will wait for a person in the composer, so
 * Codex or Antigravity should sample a next-message suggestion.
 *
 * A person's own message always qualifies. On a top-level user thread (not an
 * attached child, remote child, scheduled run, outside-agent thread, or an
 * agent answering a hand-off), turns that finish back to the user also qualify:
 * a child thread's report waking its parent (such as a Lead chat), a room
 * hand-off or review reply returning control to the agent, or an automatic
 * continue after a server restart or usage-limit reset.
 */
export function shouldSuggestNextMessage(input: {
  readonly origin: ProviderTurnOrigin;
  readonly message: Pick<
    OrchestrationMessage,
    "fromThread" | "fromAgent" | "requestKind" | "trigger"
  >;
  readonly fromThread?: ThreadMessageOrigin | undefined;
  readonly participantId?: ThreadParticipantId | null | undefined;
  readonly thread: Pick<
    OrchestrationThread,
    | "parentThreadId"
    | "attachedToParent"
    | "remoteOrigin"
    | "scheduledRun"
    | "outsideOrigin"
    | "outsideWork"
    | "agentRequests"
  >;
}): boolean {
  if (input.origin === "person") return true;

  const targetParticipantId = input.participantId ?? null;
  if (
    isAttachedChild(input.thread) ||
    (input.thread.remoteOrigin ?? null) !== null ||
    (input.thread.scheduledRun ?? null) !== null ||
    (input.thread.outsideOrigin ?? null) !== null ||
    isOutsideMarked(input.thread, targetParticipantId)
  ) {
    return false;
  }

  const answeringHandOff = input.thread.agentRequests.open.some(
    (request) =>
      request.kind === "hand_off" && (request.to.participantId ?? null) === targetParticipantId,
  );
  if (answeringHandOff) return false;

  const effectiveFromThread = input.fromThread ?? input.message.fromThread;
  if (effectiveFromThread?.kind === "report") return true;
  if (input.message.fromAgent !== undefined && input.message.requestKind === "reply") return true;
  if (input.origin === "automatic" && isContinueTrigger(input.message.trigger)) return true;

  return false;
}
