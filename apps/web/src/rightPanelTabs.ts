/**
 * The right sidebar's tab model.
 *
 * The sidebar is one browser-style panel with a tab strip: Changes, Diff and
 * Agents are surfaces you open into it, each at most once. Two things have to
 * agree about it — the route that renders the panel and the chat header that
 * toggles it — so the state lives here rather than in either of them.
 *
 * Split of authority:
 *
 * - The URL owns the ACTIVE tab, mapped onto the params that already existed
 *   (`sourceControl=1`, `diff=1`, `agents=1`). Deep links keep working and an
 *   explicit `0` still means closed.
 * - This module owns what the URL cannot say: which tabs are in the strip,
 *   whether the sidebar is showing at all (it can be open on the launcher with
 *   no tab active), and what the Diff tab points at while another tab is
 *   active. Session-scoped per thread, like the panel memory it replaces: a
 *   fresh launch starts from the settings default again.
 */
import type { TurnId } from "@threadlines/contracts";
import { useCallback, useSyncExternalStore } from "react";

import {
  type DiffRouteSearch,
  closeRightPanelSearchParams,
  stripRightPanelSearchParams,
} from "./diffRouteSearch";

/** A surface the sidebar can open, and the key its active state is filed under
 *  in the URL. */
export type RightPanelTab = "sourceControl" | "diff" | "agents";

/** Strip order, launcher order and `+` menu order are all this one order. */
export const RIGHT_PANEL_TAB_ORDER: ReadonlyArray<RightPanelTab> = [
  "sourceControl",
  "diff",
  "agents",
];

export interface RightPanelSurface {
  readonly id: RightPanelTab;
  readonly label: string;
  /** One line, for the launcher tiles. */
  readonly description: string;
}

export const RIGHT_PANEL_SURFACES: Readonly<Record<RightPanelTab, RightPanelSurface>> = {
  sourceControl: {
    id: "sourceControl",
    label: "Changes",
    description: "Working tree changes on this thread's branch.",
  },
  diff: {
    id: "diff",
    label: "Diff",
    description: "Review this thread's diff.",
  },
  agents: {
    id: "agents",
    label: "Agents",
    description: "Subagents and background runs on this thread.",
  },
};

/**
 * Which surfaces a thread has at all. General Chats have no repository, so
 * they offer Agents alone; drafts have no turn yet, so they offer the two git
 * surfaces and no Agents. Unavailable surfaces are absent everywhere — strip,
 * launcher, `+` menu — and a deep link to one is ignored.
 */
export function availableRightPanelTabs(input: {
  readonly isGeneralChat: boolean;
  readonly isDraft: boolean;
}): ReadonlyArray<RightPanelTab> {
  if (input.isGeneralChat) {
    return input.isDraft ? [] : ["agents"];
  }
  if (input.isDraft) {
    return ["sourceControl", "diff"];
  }
  return RIGHT_PANEL_TAB_ORDER;
}

/** What the Diff tab is pointed at, as the search params that express it. */
export interface RightPanelDiffTarget {
  readonly diffMode?: "workingTree" | undefined;
  readonly diffTurnId?: TurnId | undefined;
  readonly diffFilePath?: string | undefined;
}

export function rightPanelDiffTargetsEqual(
  left: RightPanelDiffTarget | null,
  right: RightPanelDiffTarget | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.diffMode === right.diffMode &&
    left.diffTurnId === right.diffTurnId &&
    left.diffFilePath === right.diffFilePath
  );
}

export interface RightPanelTabsState {
  /** Whether the sidebar chrome is on screen. True with no tabs open is the
   *  launcher; the header's panel button is what turns this off. */
  readonly visible: boolean;
  readonly openTabs: ReadonlyArray<RightPanelTab>;
  /** Only meaningful while `visible`; kept through a hide so showing the
   *  sidebar again lands on the tab it was left on. */
  readonly activeTab: RightPanelTab | null;
  readonly diffTarget: RightPanelDiffTarget | null;
  /**
   * The URL's active tab as of the last change this module already accounted
   * for. Every mutation records the value the navigation it asks its caller to
   * perform is about to produce, which is what lets `reconcileRightPanelTabs`
   * tell "the URL changed because we changed it" from "something else changed
   * the URL" — the two need opposite handling when both look like `closed`.
   */
  readonly acknowledgedUrlTab: RightPanelTab | null;
}

export const EMPTY_RIGHT_PANEL_TABS_STATE: RightPanelTabsState = {
  visible: false,
  openTabs: [],
  activeTab: null,
  diffTarget: null,
  acknowledgedUrlTab: null,
};

function orderedTabs(tabs: Iterable<RightPanelTab>): ReadonlyArray<RightPanelTab> {
  const wanted = new Set(tabs);
  return RIGHT_PANEL_TAB_ORDER.filter((tab) => wanted.has(tab));
}

/** Open-or-focus: tabs are singletons, so this never duplicates one. */
export function focusRightPanelTabState(
  state: RightPanelTabsState,
  tab: RightPanelTab,
): RightPanelTabsState {
  return {
    ...state,
    visible: true,
    openTabs: orderedTabs([...state.openTabs, tab]),
    activeTab: tab,
    acknowledgedUrlTab: tab,
  };
}

/** Open-or-retarget the single Diff tab. */
export function retargetRightPanelDiffState(
  state: RightPanelTabsState,
  target: RightPanelDiffTarget | null,
): RightPanelTabsState {
  return { ...focusRightPanelTabState(state, "diff"), diffTarget: target };
}

/**
 * Closing a tab from the strip. The sidebar itself stays showing: emptying the
 * strip lands on the launcher rather than dismissing the sidebar.
 */
export function closeRightPanelTabState(
  state: RightPanelTabsState,
  tab: RightPanelTab,
): RightPanelTabsState {
  const index = state.openTabs.indexOf(tab);
  const openTabs = state.openTabs.filter((candidate) => candidate !== tab);
  // A closed Diff tab forgets what it pointed at, so reopening it from the
  // launcher or the `+` menu is the thread's working tree again.
  const diffTarget = tab === "diff" ? null : state.diffTarget;
  if (tab !== state.activeTab) {
    return { ...state, openTabs, diffTarget };
  }
  // The neighbour to the right, else the one to the left, else the launcher.
  const activeTab = openTabs[index] ?? openTabs[index - 1] ?? null;
  return {
    ...state,
    openTabs,
    activeTab,
    diffTarget,
    visible: true,
    acknowledgedUrlTab: activeTab,
  };
}

/** The header's panel button, showing the sidebar. Lands on the tab the thread
 *  was left on, or the launcher when the strip is empty. */
export function showRightPanelState(
  state: RightPanelTabsState,
  availableTabs: ReadonlyArray<RightPanelTab>,
): RightPanelTabsState {
  const openTabs = orderedTabs(state.openTabs.filter((tab) => availableTabs.includes(tab)));
  const activeTab =
    state.activeTab && openTabs.includes(state.activeTab) ? state.activeTab : (openTabs[0] ?? null);
  return { ...state, visible: true, openTabs, activeTab, acknowledgedUrlTab: activeTab };
}

/** The header's panel button, hiding the sidebar. The strip is remembered. */
export function hideRightPanelState(state: RightPanelTabsState): RightPanelTabsState {
  return { ...state, visible: false, acknowledgedUrlTab: null };
}

/** The active tab a route search names, if any. */
export function activeRightPanelTabFromSearch(search: DiffRouteSearch): RightPanelTab | null {
  if (search.diff === "1") {
    return "diff";
  }
  if (search.agents === "1") {
    return "agents";
  }
  if (search.sourceControl === "1") {
    return "sourceControl";
  }
  return null;
}

/** An explicit "closed" in the URL, as opposed to merely carrying no panel
 *  state (which leaves the default and the thread's memory to decide). */
export function isRightPanelClosedInSearch(search: DiffRouteSearch): boolean {
  if (activeRightPanelTabFromSearch(search) !== null) {
    return false;
  }
  return search.sourceControl === "0" || search.agents === "0";
}

/**
 * The search params that make `tab` the active one. A null tab is the launcher,
 * which the URL expresses as closed — the sidebar being on screen with no tab
 * open is strip state, not a location.
 */
export function rightPanelTabSearchParams<T extends Record<string, unknown>>(
  params: T,
  tab: RightPanelTab | null,
  diffTarget?: RightPanelDiffTarget | null,
) {
  if (tab === null) {
    return closeRightPanelSearchParams(params);
  }
  const rest = stripRightPanelSearchParams(params);
  if (tab === "diff") {
    return {
      ...rest,
      diff: "1" as const,
      ...(diffTarget?.diffMode ? { diffMode: diffTarget.diffMode } : {}),
      ...(diffTarget?.diffTurnId ? { diffTurnId: diffTarget.diffTurnId } : {}),
      ...(diffTarget?.diffFilePath ? { diffFilePath: diffTarget.diffFilePath } : {}),
    };
  }
  // The tab that is not active is written as an explicit `0`, not merely
  // stripped: otherwise the default-open setting reclaims the sidebar behind
  // the tab the user just picked.
  return {
    ...rest,
    sourceControl: tab === "sourceControl" ? ("1" as const) : ("0" as const),
    agents: tab === "agents" ? ("1" as const) : ("0" as const),
  };
}

export function rightPanelDiffTargetFromSearch(search: DiffRouteSearch): RightPanelDiffTarget {
  return {
    ...(search.diffMode ? { diffMode: search.diffMode } : {}),
    ...(search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
    ...(search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
  };
}

export interface RightPanelReconcileInput {
  readonly urlActiveTab: RightPanelTab | null;
  readonly urlClosed: boolean;
  readonly urlDiffTarget: RightPanelDiffTarget;
  readonly availableTabs: ReadonlyArray<RightPanelTab>;
  /** Whether a thread with no state at all should open on Changes (the
   *  default-open setting, already gated to wide layouts by the caller). */
  readonly defaultVisible: boolean;
}

/**
 * Folds the URL into the remembered strip. Returns `previous` unchanged when
 * there is nothing to do, so callers can commit only on a real change.
 */
export function reconcileRightPanelTabsState(
  previous: RightPanelTabsState | undefined,
  input: RightPanelReconcileInput,
): RightPanelTabsState {
  const { availableTabs, defaultVisible, urlClosed, urlDiffTarget } = input;
  const urlActiveTab =
    input.urlActiveTab && availableTabs.includes(input.urlActiveTab) ? input.urlActiveTab : null;

  if (!previous) {
    // A deep link opens the sidebar with just the linked tab in the strip.
    if (urlActiveTab) {
      return {
        visible: true,
        openTabs: [urlActiveTab],
        activeTab: urlActiveTab,
        diffTarget: urlActiveTab === "diff" ? urlDiffTarget : null,
        acknowledgedUrlTab: urlActiveTab,
      };
    }
    if (!urlClosed && defaultVisible && availableTabs.includes("sourceControl")) {
      return {
        visible: true,
        openTabs: ["sourceControl"],
        activeTab: "sourceControl",
        diffTarget: null,
        acknowledgedUrlTab: null,
      };
    }
    return EMPTY_RIGHT_PANEL_TABS_STATE;
  }

  if (urlActiveTab !== previous.acknowledgedUrlTab) {
    if (urlActiveTab) {
      const focused = focusRightPanelTabState(previous, urlActiveTab);
      return urlActiveTab === "diff" ? { ...focused, diffTarget: urlDiffTarget } : focused;
    }
    // Someone else closed the sidebar (the command palette, a sheet auto-hide).
    if (urlClosed) {
      return { ...previous, visible: false, acknowledgedUrlTab: null };
    }
    // Panel params merely absent: leave the strip alone.
    return { ...previous, acknowledgedUrlTab: null };
  }

  // The diff panel retargets itself as you scroll and as you pick turns, so the
  // remembered target has to follow the URL while Diff is the active tab.
  if (
    urlActiveTab === "diff" &&
    !rightPanelDiffTargetsEqual(previous.diffTarget, urlDiffTarget)
  ) {
    return { ...previous, diffTarget: urlDiffTarget };
  }

  return previous;
}

const stateByThreadKey = new Map<string, RightPanelTabsState>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readState(threadKey: string | null): RightPanelTabsState {
  if (!threadKey) {
    return EMPTY_RIGHT_PANEL_TABS_STATE;
  }
  return stateByThreadKey.get(threadKey) ?? EMPTY_RIGHT_PANEL_TABS_STATE;
}

function write(threadKey: string, next: RightPanelTabsState, deferNotify: boolean): void {
  if (stateByThreadKey.get(threadKey) === next) {
    return;
  }
  stateByThreadKey.set(threadKey, next);
  if (deferNotify) {
    // The reconcile pass runs during render; notifying synchronously from there
    // would update subscribers mid-render.
    queueMicrotask(notify);
    return;
  }
  notify();
}

function mutate(
  threadKey: string | null,
  update: (state: RightPanelTabsState) => RightPanelTabsState,
): RightPanelTabsState {
  const current = readState(threadKey);
  const next = update(current);
  if (threadKey) {
    write(threadKey, next, false);
  }
  return next;
}

/**
 * Reads the URL into the thread's remembered strip and returns what to render.
 * Exactly one caller per thread should do this — the route that renders the
 * sidebar — and everyone else should read `useRightPanelTabs`.
 *
 * The commit happens during render on purpose: the chat header renders inside
 * the route and reads the same store, so deferring it would leave the header's
 * panel button a frame out of step with the panel beside it.
 */
export function reconcileRightPanelTabs(
  threadKey: string | null,
  input: RightPanelReconcileInput,
): RightPanelTabsState {
  const previous = threadKey ? stateByThreadKey.get(threadKey) : undefined;
  const next = reconcileRightPanelTabsState(previous, input);
  if (threadKey) {
    write(threadKey, next, true);
  }
  return next;
}

/** Subscribes to a thread's strip. `activeTab` is null whenever the sidebar is
 *  hidden or sitting on the launcher, so callers never have to pair the two. */
export function useRightPanelTabs(threadKey: string | null): {
  readonly visible: boolean;
  readonly openTabs: ReadonlyArray<RightPanelTab>;
  readonly activeTab: RightPanelTab | null;
  readonly diffTarget: RightPanelDiffTarget | null;
} {
  const state = useSyncExternalStore(
    subscribe,
    useCallback(() => readState(threadKey), [threadKey]),
  );
  return {
    visible: state.visible,
    openTabs: state.openTabs,
    activeTab: state.visible ? state.activeTab : null,
    diffTarget: state.diffTarget,
  };
}

export function focusRightPanelTab(threadKey: string | null, tab: RightPanelTab): void {
  mutate(threadKey, (state) => focusRightPanelTabState(state, tab));
}

export function retargetRightPanelDiff(
  threadKey: string | null,
  target: RightPanelDiffTarget | null,
): void {
  mutate(threadKey, (state) => retargetRightPanelDiffState(state, target));
}

/** Returns the tab that should now be active, for the caller to navigate to.
 *  Null means the strip is empty and the URL should read as closed. */
export function closeRightPanelTab(
  threadKey: string | null,
  tab: RightPanelTab,
): RightPanelTab | null {
  return mutate(threadKey, (state) => closeRightPanelTabState(state, tab)).activeTab;
}

/** Returns the tab to navigate to; null means show the launcher. */
export function showRightPanel(
  threadKey: string | null,
  availableTabs: ReadonlyArray<RightPanelTab>,
): { readonly activeTab: RightPanelTab | null; readonly diffTarget: RightPanelDiffTarget | null } {
  const next = mutate(threadKey, (state) => showRightPanelState(state, availableTabs));
  return { activeTab: next.activeTab, diffTarget: next.diffTarget };
}

export function hideRightPanel(threadKey: string | null): void {
  mutate(threadKey, hideRightPanelState);
}

export function resetRightPanelTabsForTests(): void {
  stateByThreadKey.clear();
  notify();
}
