/**
 * Family tabs (docs/design/lead-chat.md, "Family tabs"): a thread that
 * started other threads, and each thread it started, show one row of tabs
 * under the chat header. Which threads are on the row is the sidebar's own
 * family rule (`liveFamilyOf`); how the row lays them out is decided here,
 * as data, so the component only draws it.
 */
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { ScopedThreadRef } from "@threadlines/contracts";

import type { SidebarThreadSummary } from "../../types";

import {
  familyParentKeyOf,
  type InboxFamilyEntry,
  type InboxRemoteChild,
  inboxStatusWord,
  isChildThreadNeedingYou,
  isNeedsUserStatus,
  liveFamilyOf,
} from "../Sidebar.logic";
import { shortFamilyTitles } from "../familyTitles.logic";

/** One tab on the row. */
export interface FamilyTab {
  /** The thread's scoped key (or the remote child's key). */
  readonly key: string;
  /** What a click opens; null for a child this app has no thread for. */
  readonly threadRef: ScopedThreadRef | null;
  /**
   * A child on a computer this app can't see that a click opens read through
   * the link instead (`/linked/...`, LinkedThreadView); null otherwise.
   */
  readonly linkedRef: ScopedThreadRef | null;
  readonly kind: "parent" | "child";
  readonly title: string;
  /**
   * What the tab itself shows: the title, less a topic it shares with other
   * threads on the row (`shortFamilyTitles`, the sidebar's rule too). The tooltip keeps the title.
   */
  readonly shortTitle: string;
  /** The parent is its project's lead chat: its tab is the flag and "Lead". */
  readonly lead: boolean;
  /** A child's status dot class and word; null for the parent or a quiet child. */
  readonly dotClass: string | null;
  readonly statusWord: string | null;
  /** Wrapped and still in the family: a check instead of a dot. */
  readonly done: boolean;
  /** Waiting on the user (what makes "+N" amber when it is hidden). */
  readonly needsYou: boolean;
  /** The computer it runs on when the app can't see that computer. */
  readonly computerLabel: string | null;
  /** Where the sidebar files it, for the menu's Wrap up or Reopen; null where it has none. */
  readonly inbox: { readonly isDone: boolean; readonly canMarkDone: boolean } | null;
}

/** The row for the open thread's family, or null when it has none. */
export interface FamilyTabs {
  /** The parent's key: the row belongs to the family, never to the open thread. */
  readonly familyKey: string;
  readonly tabs: readonly FamilyTab[];
  readonly openKey: string;
}

/** What the row reads about each thread, filed the way the sidebar files it. */
export interface FamilyTabEntry extends InboxFamilyEntry {
  readonly thread: SidebarThreadSummary;
  readonly isLead?: boolean | undefined;
  /** Whether its row offers Wrap up (InboxEntry.canMarkDone). */
  readonly canMarkDone?: boolean | undefined;
}

/**
 * The open thread's family as tabs: on a parent with at least one member, and
 * on each member while its parent is live. The parent first, then its
 * threads in the order the sidebar draws them. Null for a thread with no
 * family, a child the user made its own, or one whose parent is wrapped.
 *
 * The open thread may also be a child on a computer this app can't see, read
 * through the link: `parentKey` then names the parent that holds it.
 * `canReadLinked` says whether a parent's computer reads such children for
 * this app (its `linkedThreadRead` capability).
 */
export function familyTabsOf<E extends FamilyTabEntry>(input: {
  readonly openKey: string;
  readonly parentKey?: string | undefined;
  readonly entries: readonly E[];
  readonly remoteChildrenOf: (parent: E) => readonly InboxRemoteChild[];
  readonly canReadLinked: (parent: E) => boolean;
  readonly now: string;
}): FamilyTabs | null {
  const byKey = new Map(input.entries.map((entry) => [entry.threadKey, entry] as const));
  const open = byKey.get(input.openKey);
  const parentKey =
    open !== undefined ? (familyParentKeyOf(open.thread) ?? open.threadKey) : input.parentKey;
  if (parentKey === undefined) return null;
  const parent = byKey.get(parentKey);
  if (parent === undefined) return null;
  const family = liveFamilyOf({
    parent,
    children: input.entries.filter(
      (entry) =>
        entry.threadKey !== parent.threadKey && familyParentKeyOf(entry.thread) === parentKey,
    ),
    remoteChildren: input.remoteChildrenOf(parent),
    activeThreadKey: input.openKey,
    now: input.now,
  });
  if (family === null) return null;
  // The open child must be one of them (it always is while its parent is live).
  if (
    parent.threadKey !== input.openKey &&
    !family.children.some((child) => child.threadKey === input.openKey) &&
    !family.remoteChildren.some((child) => child.threadKey === input.openKey)
  ) {
    return null;
  }
  const readsLinked = input.canReadLinked(parent);
  const childTab = (child: E): FamilyTab => ({
    key: child.threadKey,
    threadRef: scopeThreadRef(child.thread.environmentId, child.thread.id),
    linkedRef: null,
    kind: "child",
    title: child.thread.title,
    shortTitle: child.thread.title,
    lead: false,
    dotClass: child.isDone ? null : (child.status?.dotClass ?? null),
    statusWord: child.isDone ? null : inboxStatusWord(child.status),
    done: child.isDone,
    needsYou: !child.isDone && isNeedsUserStatus(child.status),
    computerLabel: null,
    inbox: { isDone: child.isDone, canMarkDone: child.canMarkDone === true },
  });
  const remoteTab = (child: InboxRemoteChild): FamilyTab => ({
    key: child.threadKey,
    threadRef: null,
    linkedRef: readsLinked ? linkedRefOf(child) : null,
    kind: "child",
    title: child.title,
    shortTitle: child.title,
    lead: false,
    dotClass: child.isDone ? null : (child.status?.dotClass ?? null),
    statusWord: child.isDone ? null : inboxStatusWord(child.status),
    done: child.isDone,
    needsYou: isChildThreadNeedingYou(child),
    computerLabel: child.computerLabel,
    inbox: null,
  });
  const children = [...family.children.map(childTab), ...family.remoteChildren.map(remoteTab)];
  const shortTitles = shortFamilyTitles(children.map((tab) => tab.title));
  return {
    familyKey: parent.threadKey,
    openKey: input.openKey,
    tabs: [
      {
        key: parent.threadKey,
        threadRef: scopeThreadRef(parent.thread.environmentId, parent.thread.id),
        linkedRef: null,
        kind: "parent",
        title: parent.thread.title,
        shortTitle: parent.thread.title,
        lead: parent.isLead === true,
        dotClass: null,
        statusWord: null,
        done: false,
        needsYou: !parent.isDone && isNeedsUserStatus(parent.status),
        computerLabel: null,
        inbox: { isDone: parent.isDone, canMarkDone: parent.canMarkDone === true },
      },
      ...children.map((tab, index) => ({ ...tab, shortTitle: shortTitles[index]! })),
    ],
  };
}

/**
 * The thread a child on a computer this app can't see would be read as
 * through the link: one that has a thread there. A start with no thread yet,
 * a child being set up here, and one whose link is gone have nothing to read.
 */
export function linkedRefOf(child: InboxRemoteChild): ScopedThreadRef | null {
  return child.threadId === null || child.phase === "setting_up" || child.unlinked === true
    ? null
    : scopeThreadRef(child.environmentId, child.threadId);
}

/** Whether two rows draw the same: the row skips a redraw when nothing it shows changed. */
export function sameFamilyTabs(left: FamilyTabs | null, right: FamilyTabs | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.familyKey === right.familyKey &&
    left.openKey === right.openKey &&
    left.tabs.length === right.tabs.length &&
    left.tabs.every((tab, index) => {
      const other = right.tabs[index]!;
      return (
        tab.key === other.key &&
        (tab.linkedRef === null) === (other.linkedRef === null) &&
        tab.title === other.title &&
        tab.shortTitle === other.shortTitle &&
        tab.lead === other.lead &&
        tab.dotClass === other.dotClass &&
        tab.statusWord === other.statusWord &&
        tab.done === other.done &&
        tab.needsYou === other.needsYou &&
        tab.computerLabel === other.computerLabel &&
        tab.inbox?.isDone === other.inbox?.isDone &&
        tab.inbox?.canMarkDone === other.inbox?.canMarkDone
      );
    })
  );
}

/** The narrowest a tab with a long title gets before the rest move behind "+N". */
export const FAMILY_TAB_MIN_WIDTH_PX = 96;

/**
 * Which tabs fit the row, in order, and which go behind "+N". Each tab can
 * shrink to its floor (`floorPx`: its own width when that is under
 * {@link FAMILY_TAB_MIN_WIDTH_PX}, so a short title costs only what it takes;
 * the lead's whole width, since it never shrinks), with `gapPx` between tabs.
 * Past that, the tabs after the last one that fits move behind the menu,
 * which takes `overflowPx` itself. The parent's tab and the open thread's are
 * always on the row, even where the row is too narrow for both.
 */
export function fitFamilyTabs(input: {
  readonly tabs: readonly FamilyTab[];
  readonly openKey: string;
  readonly rowPx: number;
  readonly overflowPx: number;
  readonly gapPx: number;
  readonly floorPx: (tab: FamilyTab) => number;
}): { readonly shown: readonly FamilyTab[]; readonly hidden: readonly FamilyTab[] } {
  const all = input.tabs;
  const widthOf = (tabs: readonly FamilyTab[]) =>
    tabs.reduce((sum, tab) => sum + input.floorPx(tab), 0) +
    input.gapPx * Math.max(0, tabs.length - 1);
  if (widthOf(all) <= input.rowPx) return { shown: all, hidden: [] };
  const kept = all.filter((tab, index) => index === 0 || tab.key === input.openKey);
  const keys = new Set(kept.map((tab) => tab.key));
  const budget = input.rowPx - input.overflowPx - input.gapPx;
  let used = widthOf(kept);
  for (const tab of all) {
    if (keys.has(tab.key)) continue;
    const cost = input.gapPx + input.floorPx(tab);
    if (used + cost > budget) break;
    keys.add(tab.key);
    used += cost;
  }
  return {
    shown: all.filter((tab) => keys.has(tab.key)),
    hidden: all.filter((tab) => !keys.has(tab.key)),
  };
}
