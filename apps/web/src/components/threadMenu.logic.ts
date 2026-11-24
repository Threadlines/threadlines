import type { ContextMenuItem, ThreadId } from "@threadlines/contracts";
import { type FamilyMember, isStillGoing, stopReachOf } from "@threadlines/shared/childThreads";

import { LEAD_MENU_SUBLABEL, leadMenuLabel, type LeadMenuState } from "../leadChat";
import type { SidebarThreadSummary } from "../types";
import { stillGoingInputOfSummary } from "./Sidebar.logic";

/** Everything a thread's menu can do. Every surface that offers it offers the same. */
export type ThreadMenuAction =
  | "rename"
  | "pin"
  | "unpin"
  | "mark-unread"
  | "wrap-up"
  | "reopen"
  | "move-up"
  | "move-down"
  | "make-lead"
  | "stop-lead"
  | "separate"
  | "attach"
  | "stop-children"
  | "move"
  | "copy-path"
  | "copy-thread-id"
  | "archive"
  | "delete";

/** What the menu needs to know about one thread. */
export interface ThreadMenuFacts {
  readonly pinned: boolean;
  /** Where the inbox files it; null for a thread the inbox doesn't list (a general chat). */
  readonly inbox: { readonly isDone: boolean; readonly canMarkDone: boolean } | null;
  /** A child thread still attached to the thread that started it. */
  readonly attachedChild: boolean;
  /** A separated child whose parent could take it back; `refusal` says why it can't now. */
  readonly putBack: { readonly parentTitle: string; readonly refusal: string | null } | null;
  /**
   * Threads its Stop would stop (`countThreadsToStop`): one that only checks
   * back, one started without report back, and one on a linked computer included.
   */
  readonly stopCount: number;
  readonly moveOffered: boolean;
  /** Its agent is mid-turn: archiving waits until it stops. */
  readonly running: boolean;
  /** What it can do about its project's lead chat; null where that isn't offered. */
  readonly lead?: LeadMenuState | null;
  /** A row of the inbox's custom order, and where it can go; null anywhere else. */
  readonly customOrder?: {
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
  } | null;
}

/**
 * How many threads "Stop N working threads" and the family row's Stop button
 * stop: what an id-less `thread.children.stop` on `thread` targets.
 * - Every thread its Stop reaches on this computer that is still going, by
 *   the server's own walk (`stopReachOf`) and test (`isStillGoing`), threads
 *   started without report back that the user hasn't written in included.
 * - Each child on a linked computer it has a request open with: that request
 *   is settled and the child stopped there.
 * - Each child started here that is still being set up, with no thread yet.
 * `threads` is every thread the app holds.
 */
export function countThreadsToStop(
  threads: Iterable<SidebarThreadSummary>,
  thread: Pick<
    SidebarThreadSummary,
    "environmentId" | "id" | "remoteChildren" | "localChildStarts"
  >,
  now: string,
): number {
  const members: FamilyMember[] = [];
  const summaries = new Map<ThreadId, SidebarThreadSummary>();
  for (const candidate of threads) {
    if (candidate.environmentId !== thread.environmentId) continue;
    summaries.set(candidate.id, candidate);
    members.push({
      id: candidate.id,
      parentThreadId: candidate.parentThreadId ?? null,
      attachedToParent: candidate.attachedToParent ?? false,
      stopsWithParent: candidate.stopsWithParent,
      createdAt: candidate.createdAt,
    });
  }
  const here = stopReachOf(members, thread.id).filter((member) => {
    const summary = summaries.get(member.thread.id);
    return summary !== undefined && isStillGoing(stillGoingInputOfSummary(summary, now));
  }).length;
  // Absent `followed` is an older server's: it says nothing, so the request is taken as open.
  const linked = (thread.remoteChildren ?? []).filter((child) => child.followed !== false).length;
  const settingUp = (thread.localChildStarts ?? []).filter(
    (start) => !summaries.has(start.childThreadId),
  ).length;
  return here + linked + settingUp;
}

/**
 * Whether the thread's agent is mid-turn, from its session: the menu greys out
 * Archive then, and a swipe doesn't offer it.
 */
export function isThreadTurnRunning(
  session: { readonly status: string; readonly activeTurnId?: unknown } | null | undefined,
): boolean {
  return session?.status === "running" && session.activeTurnId != null;
}

/** The first item of a group carries the divider above it. */
const asGroup = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
): ContextMenuItem<T>[] =>
  items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item));

/**
 * A thread's menu, in groups: the thread itself (rename, pin, unread, and
 * wrap up or reopen where the inbox lists it), its place in the inbox's custom
 * order, its family, moving it,
 * copying, and filing it away for good (archive, delete).
 */
export function describeThreadMenu(facts: ThreadMenuFacts): ContextMenuItem<ThreadMenuAction>[] {
  const items: ContextMenuItem<ThreadMenuAction>[] = [
    { id: "rename", label: "Rename" },
    facts.pinned ? { id: "unpin", label: "Unpin" } : { id: "pin", label: "Pin" },
    { id: "mark-unread", label: "Mark unread" },
  ];
  if (facts.inbox?.isDone) {
    items.push({ id: "reopen", label: "Reopen" });
  } else if (facts.inbox?.canMarkDone) {
    items.push({ id: "wrap-up", label: "Wrap up" });
  }
  if (facts.customOrder) {
    items.push(
      ...asGroup<ThreadMenuAction>([
        { id: "move-up", label: "Move up", disabled: !facts.customOrder.canMoveUp },
        { id: "move-down", label: "Move down", disabled: !facts.customOrder.canMoveDown },
      ]),
    );
  }

  if (facts.lead) {
    items.push(
      ...asGroup<ThreadMenuAction>([
        {
          // Make and stop are separate actions, as pin and unpin are: a menu
          // left open while another client changes the lead does what it says.
          id: facts.lead.kind === "stop" ? "stop-lead" : "make-lead",
          label: leadMenuLabel(facts.lead),
          // What a lead is, said where the user first meets the idea.
          ...(facts.lead.kind === "make" && facts.lead.refusal === null
            ? { sublabel: LEAD_MENU_SUBLABEL }
            : {}),
          disabled: facts.lead.kind === "make" && facts.lead.refusal !== null,
        },
      ]),
    );
  }

  const family: ContextMenuItem<ThreadMenuAction>[] = [];
  if (facts.attachedChild) {
    family.push({ id: "separate", label: "Make it its own thread" });
  }
  if (facts.putBack !== null) {
    const { parentTitle, refusal } = facts.putBack;
    family.push({
      id: "attach",
      label:
        refusal === null
          ? `Put back under ${parentTitle}`
          : `Put back under ${parentTitle}: ${refusal.charAt(0).toLowerCase()}${refusal.slice(1).replace(/\.$/, "")}`,
      disabled: refusal !== null,
    });
  }
  if (facts.stopCount > 0) {
    family.push({
      id: "stop-children",
      label: `Stop ${facts.stopCount} working ${facts.stopCount === 1 ? "thread" : "threads"}`,
    });
  }
  items.push(...asGroup(family));

  if (facts.moveOffered) {
    items.push(...asGroup([{ id: "move", label: "Move to another computer" }]));
  }
  items.push(
    ...asGroup([
      { id: "copy-path", label: "Copy path" },
      { id: "copy-thread-id", label: "Copy thread ID" },
    ]),
    ...asGroup([
      { id: "archive", label: "Archive", disabled: facts.running },
      { id: "delete", label: "Delete", destructive: true },
    ]),
  );
  return items;
}

/** What a menu over several selected threads can do. */
export type ThreadSelectionMenuAction =
  | "mark-unread"
  | "pin"
  | "unpin"
  | "wrap-up"
  | "archive"
  | "delete";

/**
 * The menu over several selected threads: unread, pin and wrap up together,
 * then archive and delete. Pin pins every one not pinned yet (Unpin when all
 * are); a thread already wrapped up, or one still running, is left as it is.
 */
export function describeThreadSelectionMenu(selection: {
  readonly count: number;
  readonly allPinned: boolean;
}): ContextMenuItem<ThreadSelectionMenuAction>[] {
  const { count } = selection;
  return [
    { id: "mark-unread", label: `Mark unread (${count})` },
    selection.allPinned
      ? { id: "unpin", label: `Unpin (${count})` }
      : { id: "pin", label: `Pin (${count})` },
    { id: "wrap-up", label: `Wrap up (${count})` },
    ...asGroup([
      { id: "archive", label: `Archive (${count})` },
      { id: "delete", label: `Delete (${count})`, destructive: true },
    ]),
  ];
}
