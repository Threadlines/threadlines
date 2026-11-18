/**
 * A family when it moves (docs/design/fleet.md, Part 3f, (g)), on the
 * computer it leaves: which threads move in it, which of them owns a folder
 * several work in (only the owner sends its files; the others share the
 * folder that owner's move makes there), and what a member's manifest says
 * of its family. Pure: ThreadMoves reads the threads and asks these.
 */
import type {
  OrchestrationThread,
  PeerMoveFamily,
  ThreadMoveFamily,
  ThreadMoveFamilyId,
} from "@threadlines/contracts";
import { PEER_MOVE_FAMILY_MAX_STAYED } from "@threadlines/contracts";

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
 * computers (they stay there), and the waits its move's stop ended.
 */
export function familyManifestOf(
  view: Pick<ThreadMoveView, "projects" | "threads">,
  thread: OrchestrationThread,
  family: ThreadMoveFamily,
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
  const remoteStayed = isParent
    ? (thread.childRequests.remoteChildren ?? [])
        .slice(0, PEER_MOVE_FAMILY_MAX_STAYED)
        .map((child) => ({ label: child.label, title: child.title }))
    : [];
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
