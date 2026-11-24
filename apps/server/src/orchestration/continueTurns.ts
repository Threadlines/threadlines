import type {
  MessageId,
  MessageTrigger,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  ThreadParticipantId,
} from "@threadlines/contracts";
import {
  activeParticipants,
  sessionSlotParticipantId,
} from "@threadlines/shared/threadParticipants";
import { isTurnAside } from "@threadlines/shared/transcriptRevert";

/**
 * Turns Threadlines starts by itself so an agent picks up work something
 * outside it stopped: a usage limit ("Continue at reset", decider.ts) or a
 * server restart (`thread.restart.continue`).
 */

/** What the agent reads when a restart cut its turn off, sent as a user message. */
export const RESTART_CONTINUE_MESSAGE =
  "Threadlines restarted while you were working, so your last turn stopped partway. Continue where you left off. Something you started may have finished or may still be running: check before you repeat anything that changes files or state, and if you can't tell, say so instead of repeating it.";

/** A restart that cuts off this many restart continues in a row, each newer than the window, ends the chain. */
export const RESTART_CONTINUE_CHAIN_LIMIT = 3;
export const RESTART_CONTINUE_CHAIN_WINDOW_MS = 5 * 60 * 1000;

const RESTART_STOPPED_DETAIL =
  "Threadlines restarted while this turn was in progress, so its agent session is gone. Send a message to continue.";
const RESTART_LOOP_DETAIL =
  "Threadlines restarted again each time this turn picked back up, so it stopped trying. Send a message to continue.";

/**
 * The user message the session's latest turn started with: the newest one
 * addressed to the agent holding the slot. A request that agent sent another
 * agent meanwhile is addressed to that one.
 */
export function turnStartingMessage(
  thread: OrchestrationThread,
  session: OrchestrationSession,
): OrchestrationMessage | undefined {
  return latestTurnStartFor(thread, sessionSlotParticipantId(session));
}

/** The newest user message that started a turn for `participantId` (null: the thread's own agent). */
/** The message the newest turn for `participantId` was asked for with. */
export function latestTurnStartFor(
  thread: OrchestrationThread,
  participantId: ThreadParticipantId | null,
): OrchestrationMessage | undefined {
  return thread.messages.findLast(
    (message) =>
      message.role === "user" &&
      !isTurnAside(message) &&
      (message.participantId ?? null) === participantId,
  );
}

/**
 * The user asked for this turn: they typed it, moved it to another account,
 * or it is a continue Threadlines sent for a turn they asked for. A scheduled
 * run's, another thread's, an outside agent's or a room agent's message is none
 * of these: continuing it would not finish the run or answer the request.
 */
export function userAskedForTurn(message: OrchestrationMessage): boolean {
  return message.composer !== undefined || message.trigger !== undefined;
}

/**
 * A "continue where you left off" Threadlines sent by itself (a usage limit
 * reset, or a restart). The user's own message overtakes one still on its way
 * to the agent, which is then marked not sent.
 */
export function isContinueTrigger(trigger: MessageTrigger | undefined): boolean {
  return trigger === "usageLimitReset" || trigger === "serverRestart";
}

export type RestartContinueVerdict =
  | { readonly kind: "continue"; readonly participantId: ThreadParticipantId | null }
  | { readonly kind: "note"; readonly detail: string }
  | { readonly kind: "movedOn" };

/**
 * What to do with a turn the previous server process was running when it
 * stopped. Continue it when the setting is on, the turn had reached its agent,
 * the user asked for it, nothing in it waits on the user, and restarts have
 * not cut off its continues `RESTART_CONTINUE_CHAIN_LIMIT` times within the
 * window. Otherwise the thread gets the note that the restart stopped it.
 * `movedOn`: a turn started (or failed to) since the restart left the session
 * interrupted, which startup's reaper may since have marked stopped; the user
 * already sent something, so neither applies.
 */
export function restartContinueVerdict(
  thread: OrchestrationThread,
  input: {
    readonly turnStarted: boolean;
    /** The agent that was working: startup's reaper may since have cleared it from the session. */
    readonly participantId: ThreadParticipantId | null;
    /** An approval or a question was open when the server stopped. */
    readonly waitingOnUser: boolean;
    readonly settingOn: boolean;
    readonly now: string;
    /**
     * The message the cut turn was started with, when known: null for a turn
     * the provider started. A continue is judged by that turn, never by the
     * newest message.
     */
    readonly turnMessageId?: MessageId | null | undefined;
  },
): RestartContinueVerdict {
  const stopped = { kind: "note", detail: RESTART_STOPPED_DETAIL } as const;
  const session = thread.session;
  if (session === null || (session.status !== "interrupted" && session.status !== "stopped")) {
    return { kind: "movedOn" };
  }
  if (
    !input.settingOn ||
    !input.turnStarted ||
    thread.archivedAt !== null ||
    (thread.move ?? null) !== null ||
    // A goal runs its own turns; resuming its session can take it up again.
    thread.goal?.status === "active" ||
    input.waitingOnUser
  ) {
    return stopped;
  }
  const participantId = input.participantId;
  if (
    participantId !== null &&
    !activeParticipants(thread).some((entry) => entry.id === participantId)
  ) {
    return stopped;
  }
  const startedBy =
    input.turnMessageId === undefined
      ? latestTurnStartFor(thread, participantId)
      : input.turnMessageId === null
        ? undefined
        : thread.messages.find((message) => message.id === input.turnMessageId);
  if (startedBy === undefined || !userAskedForTurn(startedBy)) {
    return stopped;
  }
  if (restartContinuesInARow(thread, participantId, input.now) >= RESTART_CONTINUE_CHAIN_LIMIT) {
    return { kind: "note", detail: RESTART_LOOP_DETAIL };
  }
  return { kind: "continue", participantId };
}

/** The newest turn starts for `participantId` that are restart continues sent within the window. */
function restartContinuesInARow(
  thread: OrchestrationThread,
  participantId: ThreadParticipantId | null,
  now: string,
): number {
  const since = Date.parse(now) - RESTART_CONTINUE_CHAIN_WINDOW_MS;
  let count = 0;
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (
      message.role !== "user" ||
      isTurnAside(message) ||
      (message.participantId ?? null) !== participantId
    ) {
      continue;
    }
    if (message.trigger !== "serverRestart" || Date.parse(message.createdAt) < since) {
      break;
    }
    count += 1;
  }
  return count;
}
