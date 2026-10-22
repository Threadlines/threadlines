import type { ContextMenuItem } from "@threadlines/contracts";

/** Everything a thread's menu can do. Every surface that offers it offers the same. */
export type ThreadMenuAction =
  | "rename"
  | "pin"
  | "unpin"
  | "mark-unread"
  | "wrap-up"
  | "reopen"
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
  /** Threads it started that are still at work. */
  readonly workingChildCount: number;
  readonly moveOffered: boolean;
  /** Its agent is mid-turn: archiving waits until it stops. */
  readonly running: boolean;
}

/** The first item of a group carries the divider above it. */
const asGroup = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
): ContextMenuItem<T>[] =>
  items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item));

/**
 * A thread's menu, in groups: the thread itself (rename, pin, unread, and
 * wrap up or reopen where the inbox lists it), its family, moving it,
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
  if (facts.workingChildCount > 0) {
    family.push({
      id: "stop-children",
      label: `Stop ${facts.workingChildCount} working ${facts.workingChildCount === 1 ? "thread" : "threads"}`,
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
