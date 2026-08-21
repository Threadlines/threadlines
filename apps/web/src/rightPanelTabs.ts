/**
 * The right sidebar's tab model.
 *
 * The sidebar is one browser-style panel with a tab strip: Source, Diff and
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

/** Launcher order and `+` menu order. The strip itself is ordered by when each
 *  tab was opened, like a browser's, so this is only how the fixed menus list
 *  the surfaces. */
export const RIGHT_PANEL_TAB_ORDER: ReadonlyArray<RightPanelTab> = [
  "sourceControl",
  "diff",
  "agents",
];

export interface RightPanelSurface {
  readonly id: RightPanelTab;
  readonly label: string;
  /** One line, for the launcher rows. Short enough to fit one line of the
   *  panel at its narrowest, so nothing here is ever read half-truncated. */
  readonly description: string;
}

export const RIGHT_PANEL_SURFACES: Readonly<Record<RightPanelTab, RightPanelSurface>> = {
  sourceControl: {
    id: "sourceControl",
    // "Source", not "Git": the contracts already model `jj` beside git, so a
    // Jujutsu repo would be reading a wrong word. Not "Changes" either -- the
    // surface commits, pulls and stashes as well as listing changes, and the
    // list inside it is already headed "Changes". The id, the search param and
    // every other internal name stay `sourceControl`.
    label: "Source",
    description: "Working tree changes on this branch.",
  },
  diff: {
    id: "diff",
    label: "Diff",
    description: "Review this thread's diff.",
  },
  agents: {
    id: "agents",
    label: "Agents",
    description: "Subagents and background runs.",
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
   * The URL's active tab as of the last reconcile pass. A mutation lands in this
   * store one render before the navigation it asks for reaches the URL, so the
   * reconcile has to ignore the URL until it actually changes — otherwise the
   * stale value reads as an external navigation and undoes the mutation.
   */
  readonly observedUrlTab: RightPanelTab | null;
}

export const EMPTY_RIGHT_PANEL_TABS_STATE: RightPanelTabsState = {
  visible: false,
  openTabs: [],
  activeTab: null,
  diffTarget: null,
  observedUrlTab: null,
};

/** A newly opened tab joins the end of the strip; an open one keeps its slot. */
function withTab(
  tabs: ReadonlyArray<RightPanelTab>,
  tab: RightPanelTab,
): ReadonlyArray<RightPanelTab> {
  return tabs.includes(tab) ? tabs : [...tabs, tab];
}

/** Open-or-focus: tabs are singletons, so this never duplicates one. */
export function focusRightPanelTabState(
  state: RightPanelTabsState,
  tab: RightPanelTab,
): RightPanelTabsState {
  return {
    ...state,
    visible: true,
    openTabs: withTab(state.openTabs, tab),
    activeTab: tab,
  };
}

/**
 * The first agent of a batch just spawned: surface the Agents tab without
 * taking anything away from the user.
 *
 * - Sidebar hidden, or open on the launcher: the Agents tab is the most useful
 *   thing to be looking at, so it opens focused.
 * - Sidebar open on another tab: the Agents tab joins the strip in the
 *   background — its live node advertises the running agent — and focus stays
 *   exactly where the user put it.
 *
 * Deciding *when* to call this (the 0→running edge, once per batch, wide
 * layouts only) is the caller's job; this is only what opening looks like.
 */
export function autoOpenAgentsTabState(state: RightPanelTabsState): RightPanelTabsState {
  if (state.visible && state.activeTab !== null && state.activeTab !== "agents") {
    return state.openTabs.includes("agents")
      ? state
      : { ...state, openTabs: withTab(state.openTabs, "agents") };
  }
  return focusRightPanelTabState(state, "agents");
}

/** Mutable per-thread state for the auto-open trigger. */
export interface AgentsAutoOpenEdge {
  threadKey: string | null;
  sawIdle: boolean;
}

/**
 * Advances the auto-open edge detector and returns whether this observation is
 * a fresh spawn — an idle→running transition seen while the thread was on
 * screen. Idle is only believed while `agentsKnown` (the thread's detail data
 * has actually loaded): before that, "no agents" just means the data has not
 * arrived, and counting it made every load of a thread with a live agent read
 * as a spawn. A thread switch re-arms nothing — landing on a thread whose
 * agents are already running is not a spawn either — and a returned true
 * consumes the edge, so one batch of spawns triggers exactly once.
 */
export function advanceAgentsAutoOpenEdge(
  edge: AgentsAutoOpenEdge,
  input: {
    readonly threadKey: string | null;
    readonly agentsKnown: boolean;
    readonly agentsRunning: boolean;
  },
): boolean {
  if (edge.threadKey !== input.threadKey) {
    edge.threadKey = input.threadKey;
    edge.sawIdle = false;
  }
  if (!input.agentsKnown) {
    return false;
  }
  if (!input.agentsRunning) {
    edge.sawIdle = true;
    return false;
  }
  if (!edge.sawIdle) {
    return false;
  }
  edge.sawIdle = false;
  return true;
}

/**
 * Drag-reorder: an open tab takes a new slot and the rest close ranks. The
 * strip's order is otherwise append-only (tabs join at the end), so this is
 * the one mutation that moves a tab, and it moves only the one the user held.
 */
export function moveRightPanelTabState(
  state: RightPanelTabsState,
  tab: RightPanelTab,
  toIndex: number,
): RightPanelTabsState {
  const from = state.openTabs.indexOf(tab);
  if (from === -1) {
    return state;
  }
  const to = Math.max(0, Math.min(state.openTabs.length - 1, toIndex));
  if (to === from) {
    return state;
  }
  const openTabs = [...state.openTabs];
  openTabs.splice(from, 1);
  openTabs.splice(to, 0, tab);
  return { ...state, openTabs };
}

/** Open-or-retarget the single Diff tab. */
export function retargetRightPanelDiffState(
  state: RightPanelTabsState,
  target: RightPanelDiffTarget | null,
): RightPanelTabsState {
  return { ...focusRightPanelTabState(state, "diff"), diffTarget: target };
}

/**
 * Closing a tab from the strip. Closing the last tab dismisses the sidebar —
 * an empty strip on screen is nothing the user asked to keep looking at. The
 * launcher stays reachable through the header's panel button.
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
  // The neighbour to the right, else the one to the left.
  const activeTab = openTabs[index] ?? openTabs[index - 1] ?? null;
  return {
    ...state,
    openTabs,
    activeTab,
    diffTarget,
    visible: activeTab !== null,
  };
}

/** The header's panel button, showing the sidebar. Lands on the tab the thread
 *  was left on, or the launcher when the strip is empty. */
export function showRightPanelState(
  state: RightPanelTabsState,
  availableTabs: ReadonlyArray<RightPanelTab>,
): RightPanelTabsState {
  const openTabs = state.openTabs.filter((tab) => availableTabs.includes(tab));
  const activeTab =
    state.activeTab && openTabs.includes(state.activeTab) ? state.activeTab : (openTabs[0] ?? null);
  return { ...state, visible: true, openTabs, activeTab };
}

/** The header's panel button, hiding the sidebar. The strip is remembered. */
export function hideRightPanelState(state: RightPanelTabsState): RightPanelTabsState {
  return { ...state, visible: false };
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
  /** Whether a thread with no state at all should open on Source (the
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
        ...EMPTY_RIGHT_PANEL_TABS_STATE,
        visible: true,
        openTabs: [urlActiveTab],
        activeTab: urlActiveTab,
        diffTarget: urlActiveTab === "diff" ? urlDiffTarget : null,
        observedUrlTab: urlActiveTab,
      };
    }
    if (!urlClosed && defaultVisible && availableTabs.includes("sourceControl")) {
      return {
        ...EMPTY_RIGHT_PANEL_TABS_STATE,
        visible: true,
        openTabs: ["sourceControl"],
        activeTab: "sourceControl",
      };
    }
    return EMPTY_RIGHT_PANEL_TABS_STATE;
  }

  if (urlActiveTab !== previous.observedUrlTab) {
    if (urlActiveTab) {
      const focused = focusRightPanelTabState(previous, urlActiveTab);
      return {
        ...focused,
        ...(urlActiveTab === "diff" ? { diffTarget: urlDiffTarget } : {}),
        observedUrlTab: urlActiveTab,
      };
    }
    // The sidebar closed — the last tab's ✕, the command palette, a sheet
    // auto-hide. The strip is remembered either way.
    if (urlClosed) {
      return { ...previous, visible: false, observedUrlTab: null };
    }
    // Panel params merely absent: leave the strip alone.
    return { ...previous, observedUrlTab: null };
  }

  // The diff panel retargets itself as you scroll and as you pick turns, so the
  // remembered target has to follow the URL while Diff is the active tab.
  if (urlActiveTab === "diff" && !rightPanelDiffTargetsEqual(previous.diffTarget, urlDiffTarget)) {
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
 * Reads the URL into the thread's remembered strip, subscribes to the strip's
 * own changes, and returns what to render. Exactly one caller per thread should
 * do this — the route that renders the sidebar — and everyone else should read
 * `useRightPanelTabs`.
 *
 * The commit happens during render on purpose: the chat header renders inside
 * the route and reads the same store, so deferring it would leave the header's
 * panel button a frame out of step with the panel beside it.
 */
export function useReconciledRightPanelTabs(
  threadKey: string | null,
  input: RightPanelReconcileInput,
): RightPanelTabsState {
  const stored = useSyncExternalStore(
    subscribe,
    useCallback(() => (threadKey ? stateByThreadKey.get(threadKey) : undefined), [threadKey]),
  );
  const next = reconcileRightPanelTabsState(stored, input);
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

/** Returns "agents" when the tab came up focused and the URL should follow;
 *  null when it only joined the strip in the background (or was already up). */
export function autoOpenAgentsTab(threadKey: string | null): RightPanelTab | null {
  const previous = readState(threadKey);
  const next = mutate(threadKey, autoOpenAgentsTabState);
  const focused =
    next.visible &&
    next.activeTab === "agents" &&
    !(previous.visible && previous.activeTab === "agents");
  return focused ? "agents" : null;
}

/** Reorder is strip state only — no navigation follows, so nothing returns. */
export function moveRightPanelTab(
  threadKey: string | null,
  tab: RightPanelTab,
  toIndex: number,
): void {
  mutate(threadKey, (state) => moveRightPanelTabState(state, tab, toIndex));
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
