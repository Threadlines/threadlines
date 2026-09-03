import { TurnId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_RIGHT_PANEL_TABS_STATE,
  activeRightPanelTabFromSearch,
  advanceAgentsAutoOpenEdge,
  autoOpenAgentsTabState,
  type AgentsAutoOpenEdge,
  availableRightPanelTabs,
  closeRightPanelTabState,
  focusRightPanelTabState,
  hideRightPanelState,
  isRightPanelClosedInSearch,
  moveRightPanelTabState,
  reconcileRightPanelTabsState,
  retargetRightPanelDiffState,
  rightPanelTabSearchParams,
  showRightPanelState,
  type RightPanelTab,
  type RightPanelTabsState,
} from "./rightPanelTabs";

const ALL_TABS = availableRightPanelTabs({ isGeneralChat: false, isDraft: false });

function reconcileFresh(
  input: Partial<Parameters<typeof reconcileRightPanelTabsState>[1]> = {},
): RightPanelTabsState {
  return reconcileRightPanelTabsState(undefined, {
    urlActiveTab: null,
    urlClosed: false,
    urlDiffTarget: {},
    availableTabs: ALL_TABS,
    defaultVisible: false,
    ...input,
  });
}

/** A thread whose sidebar the URL has already settled on `tab`, which is the
 *  state every mutation actually starts from in the app. */
function openedOn(tab: RightPanelTab): RightPanelTabsState {
  return reconcileFresh({ urlActiveTab: tab });
}

describe("availableRightPanelTabs", () => {
  it("offers only the surfaces a thread actually has", () => {
    expect(ALL_TABS).toEqual(["sourceControl", "diff", "pullRequest", "agents"]);
    // No repository, so no changes and no diff.
    expect(availableRightPanelTabs({ isGeneralChat: true, isDraft: false })).toEqual(["agents"]);
    // No turn yet, so no agents.
    expect(availableRightPanelTabs({ isGeneralChat: false, isDraft: true })).toEqual([
      "sourceControl",
      "diff",
    ]);
    expect(availableRightPanelTabs({ isGeneralChat: true, isDraft: true })).toEqual([]);
  });
});

describe("activeRightPanelTabFromSearch", () => {
  it("maps the existing panel params onto the active tab", () => {
    expect(activeRightPanelTabFromSearch({})).toBeNull();
    expect(activeRightPanelTabFromSearch({ sourceControl: "1" })).toBe("sourceControl");
    expect(activeRightPanelTabFromSearch({ agents: "1" })).toBe("agents");
    expect(activeRightPanelTabFromSearch({ pullRequest: "1" })).toBe("pullRequest");
    expect(activeRightPanelTabFromSearch({ diff: "1" })).toBe("diff");
    // The diff key wins, which is what `parseDiffRouteSearch` already enforces.
    expect(activeRightPanelTabFromSearch({ diff: "1", sourceControl: "1" })).toBe("diff");
  });

  it("reads an explicit zero as closed and no params as undecided", () => {
    expect(isRightPanelClosedInSearch({})).toBe(false);
    expect(isRightPanelClosedInSearch({ sourceControl: "0", pullRequest: "0", agents: "0" })).toBe(
      true,
    );
    expect(isRightPanelClosedInSearch({ sourceControl: "0", agents: "1" })).toBe(false);
    expect(isRightPanelClosedInSearch({ pullRequest: "1" })).toBe(false);
  });
});

describe("rightPanelTabSearchParams", () => {
  it("writes the active tab and an explicit closed for the others", () => {
    expect(rightPanelTabSearchParams({ keep: "yes" }, "sourceControl")).toMatchObject({
      keep: "yes",
      sourceControl: "1",
      agents: "0",
      diff: undefined,
    });
    expect(rightPanelTabSearchParams({}, "agents")).toMatchObject({
      sourceControl: "0",
      pullRequest: "0",
      agents: "1",
    });
    expect(rightPanelTabSearchParams({}, "pullRequest")).toMatchObject({
      sourceControl: "0",
      pullRequest: "1",
      agents: "0",
    });
  });

  it("carries the diff tab's target", () => {
    expect(
      rightPanelTabSearchParams({}, "diff", {
        diffTurnId: TurnId.make("turn-1"),
        diffFilePath: "src/app.ts",
      }),
    ).toMatchObject({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
    expect(rightPanelTabSearchParams({}, "diff", { diffMode: "workingTree" })).toMatchObject({
      diff: "1",
      diffMode: "workingTree",
    });
  });

  it("expresses the launcher as closed", () => {
    expect(rightPanelTabSearchParams({ diff: "1" }, null)).toMatchObject({
      diff: undefined,
      sourceControl: "0",
      pullRequest: "0",
      agents: "0",
    });
  });
});

describe("right panel tab transitions", () => {
  it("opens tabs in the order they were opened and never duplicates one", () => {
    let state = focusRightPanelTabState(EMPTY_RIGHT_PANEL_TABS_STATE, "agents");
    state = focusRightPanelTabState(state, "sourceControl");
    state = focusRightPanelTabState(state, "agents");

    expect(state.openTabs).toEqual(["agents", "sourceControl"]);
    expect(state.activeTab).toBe("agents");
    expect(state.visible).toBe(true);
  });

  it("retargets the single diff tab instead of opening another", () => {
    let state = focusRightPanelTabState(EMPTY_RIGHT_PANEL_TABS_STATE, "sourceControl");
    state = retargetRightPanelDiffState(state, { diffFilePath: "a.ts", diffMode: "workingTree" });
    state = retargetRightPanelDiffState(state, { diffFilePath: "b.ts", diffMode: "workingTree" });

    expect(state.openTabs).toEqual(["sourceControl", "diff"]);
    expect(state.activeTab).toBe("diff");
    expect(state.diffTarget).toEqual({ diffFilePath: "b.ts", diffMode: "workingTree" });
  });

  it("closes to the neighbouring tab and dismisses the sidebar when the strip empties", () => {
    let state = focusRightPanelTabState(EMPTY_RIGHT_PANEL_TABS_STATE, "sourceControl");
    state = retargetRightPanelDiffState(state, { diffMode: "workingTree" });
    state = focusRightPanelTabState(state, "agents");

    // Closing an inactive tab leaves the active one alone.
    const withoutChanges = closeRightPanelTabState(state, "sourceControl");
    expect(withoutChanges.openTabs).toEqual(["diff", "agents"]);
    expect(withoutChanges.activeTab).toBe("agents");

    // Closing the active tab falls to the one on its right, else its left.
    const withoutAgents = closeRightPanelTabState(withoutChanges, "agents");
    expect(withoutAgents.activeTab).toBe("diff");

    const empty = closeRightPanelTabState(withoutAgents, "diff");
    expect(empty.openTabs).toEqual([]);
    expect(empty.activeTab).toBeNull();
    // Closing the last tab closes the whole sidebar.
    expect(empty.visible).toBe(false);
    // A closed diff tab forgets its file, so reopening it is the working tree.
    expect(empty.diffTarget).toBeNull();
  });

  it("moves a dragged tab to its dropped slot and nothing else", () => {
    let state = focusRightPanelTabState(EMPTY_RIGHT_PANEL_TABS_STATE, "sourceControl");
    state = focusRightPanelTabState(state, "diff");
    state = focusRightPanelTabState(state, "agents");
    expect(state.openTabs).toEqual(["sourceControl", "diff", "agents"]);

    const moved = moveRightPanelTabState(state, "agents", 0);
    expect(moved.openTabs).toEqual(["agents", "sourceControl", "diff"]);
    // Focus follows the tab, not the slot: the active tab stays active.
    expect(moved.activeTab).toBe("agents");

    // Out-of-range drops clamp to the ends instead of losing the tab.
    expect(moveRightPanelTabState(moved, "agents", 99).openTabs).toEqual([
      "sourceControl",
      "diff",
      "agents",
    ]);

    // A no-op move and a tab not in the strip both return the state as-is.
    expect(moveRightPanelTabState(state, "diff", 1)).toBe(state);
    const withoutAgents = closeRightPanelTabState(state, "agents");
    expect(moveRightPanelTabState(withoutAgents, "agents", 0)).toBe(withoutAgents);
  });

  it("hides and shows the sidebar without losing the strip", () => {
    let state = focusRightPanelTabState(EMPTY_RIGHT_PANEL_TABS_STATE, "sourceControl");
    state = focusRightPanelTabState(state, "agents");
    state = hideRightPanelState(state);
    expect(state.visible).toBe(false);

    const shown = showRightPanelState(state, ALL_TABS);
    expect(shown.visible).toBe(true);
    expect(shown.openTabs).toEqual(["sourceControl", "agents"]);
    expect(shown.activeTab).toBe("agents");
  });

  it("drops tabs a thread no longer offers when showing the sidebar", () => {
    let state = focusRightPanelTabState(EMPTY_RIGHT_PANEL_TABS_STATE, "sourceControl");
    state = focusRightPanelTabState(state, "agents");

    const shown = showRightPanelState(state, ["agents"]);
    expect(shown.openTabs).toEqual(["agents"]);
    expect(shown.activeTab).toBe("agents");
  });
});

describe("reconcileRightPanelTabsState", () => {
  it("opens a deep link with just that tab in the strip", () => {
    const state = reconcileFresh({ urlActiveTab: "agents" });
    expect(state.visible).toBe(true);
    expect(state.openTabs).toEqual(["agents"]);
    expect(state.activeTab).toBe("agents");
  });

  it("records a deep-linked diff target", () => {
    const state = reconcileFresh({
      urlActiveTab: "diff",
      urlDiffTarget: { diffTurnId: TurnId.make("turn-9") },
    });
    expect(state.diffTarget).toEqual({ diffTurnId: TurnId.make("turn-9") });
  });

  it("ignores a deep link to a surface the thread does not offer", () => {
    const state = reconcileFresh({ urlActiveTab: "sourceControl", availableTabs: ["agents"] });
    expect(state).toEqual(EMPTY_RIGHT_PANEL_TABS_STATE);
  });

  it("applies the default-open setting only without explicit URL state", () => {
    expect(reconcileFresh({ defaultVisible: true })).toMatchObject({
      visible: true,
      openTabs: ["sourceControl"],
      activeTab: "sourceControl",
    });
    expect(reconcileFresh({ defaultVisible: true, urlClosed: true })).toEqual(
      EMPTY_RIGHT_PANEL_TABS_STATE,
    );
  });

  it("adopts a tab the URL was navigated to from outside the strip", () => {
    const opened = openedOn("sourceControl");
    const state = reconcileRightPanelTabsState(opened, {
      urlActiveTab: "diff",
      urlClosed: false,
      urlDiffTarget: { diffFilePath: "src/app.ts" },
      availableTabs: ALL_TABS,
      defaultVisible: false,
    });

    expect(state.openTabs).toEqual(["sourceControl", "diff"]);
    expect(state.activeTab).toBe("diff");
    expect(state.diffTarget).toEqual({ diffFilePath: "src/app.ts" });
  });

  it("stays dismissed once the closed URL from closing the last tab arrives", () => {
    const emptied = closeRightPanelTabState(openedOn("agents"), "agents");
    expect(emptied.visible).toBe(false);

    const state = reconcileRightPanelTabsState(emptied, {
      urlActiveTab: null,
      urlClosed: true,
      urlDiffTarget: {},
      availableTabs: ALL_TABS,
      defaultVisible: false,
    });

    expect(state.visible).toBe(false);
    expect(state.openTabs).toEqual([]);
  });

  /** A mutation lands a render before its navigation does, so the reconcile has
   *  to sit on its hands until the URL actually moves. */
  it("does not undo a mutation from the URL it has not caught up to yet", () => {
    const closed = closeRightPanelTabState(
      focusRightPanelTabState(openedOn("sourceControl"), "agents"),
      "sourceControl",
    );
    expect(closed.activeTab).toBe("agents");

    const state = reconcileRightPanelTabsState(closed, {
      // The URL still says Changes: the navigation to Agents is in flight.
      urlActiveTab: "sourceControl",
      urlClosed: false,
      urlDiffTarget: {},
      availableTabs: ALL_TABS,
      defaultVisible: false,
    });

    expect(state.openTabs).toEqual(["agents"]);
    expect(state.activeTab).toBe("agents");
  });

  it("hides the sidebar when something else closes it", () => {
    const opened = openedOn("agents");
    const state = reconcileRightPanelTabsState(opened, {
      urlActiveTab: null,
      urlClosed: true,
      urlDiffTarget: {},
      availableTabs: ALL_TABS,
      defaultVisible: false,
    });

    expect(state.visible).toBe(false);
    // The strip is remembered, so showing the sidebar again restores it.
    expect(state.openTabs).toEqual(["agents"]);
  });

  it("follows the diff panel's own retargeting while the diff tab is active", () => {
    const opened = retargetRightPanelDiffState(openedOn("diff"), { diffMode: "workingTree" });
    const state = reconcileRightPanelTabsState(opened, {
      urlActiveTab: "diff",
      urlClosed: false,
      urlDiffTarget: { diffMode: "workingTree", diffFilePath: "src/app.ts" },
      availableTabs: ALL_TABS,
      defaultVisible: false,
    });

    expect(state.diffTarget).toEqual({ diffMode: "workingTree", diffFilePath: "src/app.ts" });
  });

  it("leaves the strip alone when a navigation merely drops the panel params", () => {
    const opened = openedOn("sourceControl");
    const state = reconcileRightPanelTabsState(opened, {
      urlActiveTab: null,
      urlClosed: false,
      urlDiffTarget: {},
      availableTabs: ALL_TABS,
      defaultVisible: false,
    });

    expect(state.visible).toBe(true);
    expect(state.activeTab).toBe("sourceControl");
  });
});

describe("autoOpenAgentsTabState", () => {
  it("opens the agents tab focused when the sidebar is hidden", () => {
    const state = autoOpenAgentsTabState(EMPTY_RIGHT_PANEL_TABS_STATE);

    expect(state.visible).toBe(true);
    expect(state.openTabs).toEqual(["agents"]);
    expect(state.activeTab).toBe("agents");
  });

  it("opens focused from the launcher", () => {
    const launcher: RightPanelTabsState = {
      ...EMPTY_RIGHT_PANEL_TABS_STATE,
      visible: true,
    };

    const state = autoOpenAgentsTabState(launcher);
    expect(state.activeTab).toBe("agents");
  });

  it("joins the strip in the background while another tab has focus", () => {
    const onSource = openedOn("sourceControl");

    const state = autoOpenAgentsTabState(onSource);
    expect(state.openTabs).toEqual(["sourceControl", "agents"]);
    expect(state.activeTab).toBe("sourceControl");
  });

  it("changes nothing when the agents tab is already in the strip behind another", () => {
    const withAgents = focusRightPanelTabState(openedOn("agents"), "sourceControl");

    expect(autoOpenAgentsTabState(withAgents)).toBe(withAgents);
  });

  it("re-shows a hidden sidebar focused on agents", () => {
    const hidden = hideRightPanelState(openedOn("sourceControl"));

    const state = autoOpenAgentsTabState(hidden);
    expect(state.visible).toBe(true);
    expect(state.activeTab).toBe("agents");
    expect(state.openTabs).toEqual(["sourceControl", "agents"]);
  });
});

describe("advanceAgentsAutoOpenEdge", () => {
  const freshEdge = (): AgentsAutoOpenEdge => ({ threadKey: null, sawIdle: false });
  const step = (
    edge: AgentsAutoOpenEdge,
    agentsKnown: boolean,
    agentsRunning: boolean,
    threadKey = "thread-1",
  ) => advanceAgentsAutoOpenEdge(edge, { threadKey, agentsKnown, agentsRunning });

  it("triggers on a spawn observed after real idleness", () => {
    const edge = freshEdge();
    expect(step(edge, true, false)).toBe(false);
    expect(step(edge, true, true)).toBe(true);
  });

  it("consumes the edge: one batch triggers once", () => {
    const edge = freshEdge();
    step(edge, true, false);
    expect(step(edge, true, true)).toBe(true);
    expect(step(edge, true, true)).toBe(false);
    // A second spawn while the first batch still runs is the same story.
    expect(step(edge, true, true)).toBe(false);
    // Settling and spawning again is a new batch.
    step(edge, true, false);
    expect(step(edge, true, true)).toBe(true);
  });

  it("never reads a pre-hydration empty publish as idleness", () => {
    // The sequence a reload of a thread with a live agent produces: the chat
    // column publishes empty agent state before the detail snapshot arrives,
    // then the loaded state reports the agent running.
    const edge = freshEdge();
    expect(step(edge, false, false)).toBe(false);
    expect(step(edge, true, true)).toBe(false);
  });

  it("does not treat landing on a thread with running agents as a spawn", () => {
    const edge = freshEdge();
    step(edge, true, false, "thread-1");
    expect(step(edge, true, true, "thread-2")).toBe(false);
  });

  it("re-arms per thread after a switch", () => {
    const edge = freshEdge();
    step(edge, true, false, "thread-1");
    step(edge, true, false, "thread-2");
    expect(step(edge, true, true, "thread-2")).toBe(true);
  });
});
