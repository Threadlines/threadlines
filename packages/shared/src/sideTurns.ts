/**
 * A thread's live side answers: room agents answering read-only while another
 * agent holds the thread (docs/design/rooms-slice-2.md). A thread runs up to
 * MAX_LIVE_SIDE_TURNS at once, one per agent, oldest first.
 *
 * The thread carries them as `sideTurns`, and as `sideTurn` (the first) for
 * clients older than the list. Everything reads them through `liveSideTurns`,
 * which also understands an older server's lone `sideTurn`, and writes them
 * through `withSideTurns`, so the two fields never disagree.
 */
import {
  MAX_LIVE_SIDE_TURNS,
  type OrchestrationSideTurn,
  type RoomAgentRequestId,
  type SideTurnId,
  type ThreadParticipantId,
} from "@threadlines/contracts";

export interface SideTurnFields {
  readonly sideTurns?: ReadonlyArray<OrchestrationSideTurn> | undefined;
  readonly sideTurn?: OrchestrationSideTurn | null | undefined;
}

const NONE: ReadonlyArray<OrchestrationSideTurn> = [];

/** The live side answers, oldest first. */
export function liveSideTurns(thread: SideTurnFields): ReadonlyArray<OrchestrationSideTurn> {
  if (thread.sideTurns !== undefined) return thread.sideTurns;
  return thread.sideTurn ? [thread.sideTurn] : NONE;
}

/** The live side answer with this id, if it is still live. */
export const liveSideTurn = (
  thread: SideTurnFields,
  sideTurnId: SideTurnId,
): OrchestrationSideTurn | undefined =>
  liveSideTurns(thread).find((sideTurn) => sideTurn.sideTurnId === sideTurnId);

/** The live side answer for a room request, if it is still live. */
export const liveSideTurnForRequest = (
  thread: SideTurnFields,
  requestId: RoomAgentRequestId,
): OrchestrationSideTurn | undefined =>
  liveSideTurns(thread).find((sideTurn) => sideTurn.requestId === requestId);

/** Whether an agent (null: the thread's own) is answering on the side. */
export const isAnsweringOnTheSide = (
  thread: SideTurnFields,
  participantId: ThreadParticipantId | null,
): boolean => liveSideTurns(thread).some((sideTurn) => sideTurn.participantId === participantId);

/** Whether any side answer is live. */
export const hasLiveSideTurn = (thread: SideTurnFields): boolean =>
  liveSideTurns(thread).length > 0;

/** Both fields for a new list: what a projection writes. */
export const withSideTurns = (
  sideTurns: ReadonlyArray<OrchestrationSideTurn>,
): {
  readonly sideTurns: ReadonlyArray<OrchestrationSideTurn>;
  readonly sideTurn: OrchestrationSideTurn | null;
} => ({ sideTurns, sideTurn: sideTurns[0] ?? null });

/**
 * Both fields for a thread read back from storage: none at all when nothing
 * is live, so a quiet thread's shell carries neither.
 */
export const liveSideTurnFields = (
  sideTurns: ReadonlyArray<OrchestrationSideTurn> | null | undefined,
): ReturnType<typeof withSideTurns> | Record<string, never> =>
  sideTurns !== null && sideTurns !== undefined && sideTurns.length > 0
    ? withSideTurns(sideTurns)
    : {};

/**
 * Why another side answer by this agent can't start now, or null. The decider,
 * the room tools and the composer all ask this, so they refuse alike.
 */
export function sideTurnStartRefusal(
  thread: SideTurnFields,
  participantId: ThreadParticipantId | null,
): string | null {
  if (isAnsweringOnTheSide(thread, participantId)) {
    return "That agent is already answering on the side. Wait for it to finish.";
  }
  if (liveSideTurns(thread).length >= MAX_LIVE_SIDE_TURNS) {
    return `${MAX_LIVE_SIDE_TURNS} agents are already answering on the side. Wait for one to finish.`;
  }
  return null;
}
