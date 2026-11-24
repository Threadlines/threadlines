/**
 * A family when it moves (docs/design/fleet.md, Part 3f, (g)), on the
 * computer it leaves: which threads move in it, which of them owns a folder
 * several work in (only the owner sends its files; the others share the
 * folder that owner's move makes there), and what a member's manifest says
 * of its family. Pure: ThreadMoves reads the threads and asks these.
 */
import type {
  EnvironmentId,
  OrchestrationThread,
  PeerMoveFamily,
  PeerMoveLinkLineage,
  PeerMoveStartedElsewhere,
  PeerMoveStartedThere,
  ThreadMoveFamily,
  ThreadMoveFamilyId,
} from "@threadlines/contracts";
import { PEER_MOVE_FAMILY_MAX_STAYED, PEER_MOVE_MAX_STARTED_THERE } from "@threadlines/contracts";

import { checkoutOf, type ThreadMoveView } from "../orchestration/threadMoveDecisions.ts";

/** The threads here that move in `familyId`: each whose queued move or move names it. */
export const familyMembersOf = (
  threads: ReadonlyArray<OrchestrationThread>,
  familyId: ThreadMoveFamilyId,
): ReadonlyArray<OrchestrationThread> =>
  threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      (thread.pendingMove?.family?.id === familyId || thread.move?.family?.id === familyId),
  );

/**
 * The member that owns a folder several members work in, and so sends its
 * files: the one whose worktree it is (no guest marker), else the parent,
 * else the oldest. Every member decides this alike, from the same members.
 */
export function checkoutOwnerOf(
  group: ReadonlyArray<OrchestrationThread>,
): OrchestrationThread | undefined {
  const owners = group.filter((thread) => (thread.worktreeOrigin ?? null) === null);
  const pool = owners.length > 0 ? owners : group;
  const parent = pool.find(
    (thread) => (thread.pendingMove?.family ?? thread.move?.family)?.parentThreadId === undefined,
  );
  if (parent !== undefined) return parent;
  return pool.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  )[0];
}

/**
 * What `thread`'s manifest says of its family: the family's id, its parent
 * and the parent's turn that started it (a child), the member whose folder
 * it shares there (one that doesn't own the folder it works in), and, on the
 * parent, the children that stay here, the ones its agent started on other
 * computers (they stay there), and the waits its move's stop ended. The ones
 * on `targetEnvironmentId` aren't named: that computer names them from its
 * own records, as threads already there.
 */
export function familyManifestOf(
  view: Pick<ThreadMoveView, "projects" | "threads">,
  thread: OrchestrationThread,
  family: ThreadMoveFamily,
  targetEnvironmentId: EnvironmentId,
): PeerMoveFamily {
  const members = familyMembersOf(view.threads, family.id);
  const memberIds = new Set<string>(members.map((member) => member.id));
  const checkout = checkoutOf(view, thread);
  const group = members.filter((member) => checkoutOf(view, member) === checkout);
  const owner = checkout === null ? undefined : checkoutOwnerOf(group);
  const isParent = family.parentThreadId === undefined;
  const stayed = isParent
    ? view.threads
        .filter(
          (child) =>
            child.parentThreadId === thread.id &&
            child.attachedToParent &&
            child.deletedAt === null &&
            child.archivedAt === null &&
            !memberIds.has(child.id),
        )
        .slice(0, PEER_MOVE_FAMILY_MAX_STAYED)
        .map((child) => ({ title: child.title }))
    : [];
  const remoteStayed = isParent ? startedElsewhereOf(thread, targetEnvironmentId) : [];
  const stopped = thread.move?.interrupted?.childRequestsStopped;
  return {
    id: family.id,
    ...(family.parentThreadId !== undefined ? { parentThreadId: family.parentThreadId } : {}),
    ...(family.parentThreadId !== undefined && thread.parentTurnId !== null
      ? { parentTurnId: thread.parentTurnId }
      : {}),
    ...(owner !== undefined && owner.id !== thread.id ? { sharesCheckoutOf: owner.id } : {}),
    ...(stayed.length > 0 ? { stayed } : {}),
    ...(remoteStayed.length > 0 ? { remoteStayed } : {}),
    ...(isParent && stopped !== undefined ? { childRequestsStopped: stopped } : {}),
  };
}

/** The threads a member's history may name as family (ThreadImportMessage.fromThread). */
export const familyThreadIdsOf = (
  threads: ReadonlyArray<OrchestrationThread>,
  family: ThreadMoveFamily,
): ReadonlySet<string> =>
  new Set<string>(familyMembersOf(threads, family.id).map((member) => member.id));

/**
 * What `thread`'s manifest says of the link its work came over, moving alone
 * to `targetEnvironmentId` (docs/design/fleet.md, Part 3f, (h)), or nothing:
 *
 * - a thread another computer's agent started, going back to that computer:
 *   `home`, naming the thread there that started it, and the thread there
 *   it moved over from, when it did (that computer may not have heard yet
 *   that its move landed);
 * - a child moving without its parent: `remoteParent`, naming the parent,
 *   unless the parent is gone, frozen for its own move or moved away (then it
 *   lands as a thread of its own there). A parent whose move is only queued
 *   waits for this one, and if it moves later, this one is its child there.
 *
 * The other computer trusts neither beyond its own link and records.
 */
export function linkLineageOf(
  threads: ReadonlyArray<OrchestrationThread>,
  thread: OrchestrationThread,
  targetEnvironmentId: EnvironmentId,
): PeerMoveLinkLineage | undefined {
  const origin = thread.remoteOrigin ?? null;
  if (origin !== null) {
    if (origin.environmentId !== targetEnvironmentId) return undefined;
    const from = thread.movedFrom ?? null;
    return {
      home: {
        parentThreadId: origin.threadId,
        ...(from !== null && from.environmentId === targetEnvironmentId
          ? { fromThreadId: from.threadId }
          : {}),
      },
    };
  }
  if (thread.parentThreadId === null || !thread.attachedToParent) return undefined;
  if ((thread.move ?? thread.pendingMove)?.family !== undefined) return undefined;
  // A parent whose own move is queued waits for this one (threadMoveRefusals),
  // so it is still here when this lands; one frozen or moved away isn't.
  const parent = threads.find((entry) => entry.id === thread.parentThreadId);
  if (parent === undefined || parent.deletedAt !== null || (parent.move ?? null) !== null) {
    return undefined;
  }
  return { remoteParent: { threadId: parent.id, title: parent.title } };
}

/**
 * The threads `thread`'s agent started on computers other than
 * `targetEnvironmentId`, which stay there when it moves (docs/design/fleet.md,
 * Part 3f, (g)): a family's `remoteStayed`, or a lone parent's
 * `startedElsewhere`, for the "Moved here" line there.
 */
export function startedElsewhereOf(
  thread: Pick<OrchestrationThread, "childRequests">,
  targetEnvironmentId: EnvironmentId,
): Array<PeerMoveStartedElsewhere> {
  return (thread.childRequests.remoteChildren ?? [])
    .filter((child) => child.environmentId !== targetEnvironmentId)
    .slice(0, PEER_MOVE_FAMILY_MAX_STAYED)
    .map((child) => ({ label: child.label, title: child.title }));
}

/**
 * The threads `thread`'s agent started on `targetEnvironmentId`, as its
 * records here hold them, for a move there (docs/design/fleet.md, Part 3f,
 * (g)): each with the user's Wrap up or Reopen given here. That computer
 * takes back as the thread's children only those its own records also name.
 */
export function startedThereOf(
  thread: Pick<OrchestrationThread, "childRequests">,
  targetEnvironmentId: EnvironmentId,
): ReadonlyArray<PeerMoveStartedThere> {
  return (thread.childRequests.remoteChildren ?? [])
    .filter((child) => child.environmentId === targetEnvironmentId)
    .slice(0, PEER_MOVE_MAX_STARTED_THERE)
    .map((child) => ({
      threadId: child.threadId,
      ...(child.override !== undefined ? { override: child.override } : {}),
    }));
}
