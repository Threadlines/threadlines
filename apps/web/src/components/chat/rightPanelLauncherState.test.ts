import { describe, expect, it } from "vite-plus/test";

import { TurnId } from "@threadlines/contracts";

import type { SubagentProgressItem } from "../../session-logic";
import type { ThreadBackgroundRunItem } from "./threadActivity";
import {
  buildRightPanelLauncherStates,
  countReviewableTurnDiffs,
  resolveWorkingTreeFileCount,
  rightPanelDiffTargetIsExplicit,
} from "./rightPanelLauncherState";

function buildSubagent(overrides: Partial<SubagentProgressItem> = {}): SubagentProgressItem {
  return {
    id: "agent-1",
    agentThreadId: "agent-thread-1",
    transcriptAgentId: null,
    turnId: TurnId.make("turn-1"),
    label: "Explore subagent",
    role: null,
    objective: "Sweep the router for panel wiring",
    status: "running",
    statusLabel: "Running",
    model: null,
    reasoningEffort: null,
    liveBody: null,
    telemetry: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  };
}

function buildRun(overrides: Partial<ThreadBackgroundRunItem> = {}): ThreadBackgroundRunItem {
  return {
    id: "run-1",
    source: "detected",
    label: "Dev server",
    detail: "node - vite dev",
    cwd: "C:\\repo",
    statusLabel: "Running",
    urls: [],
    terminalId: null,
    pid: 4321,
    port: 5173,
    elapsed: "2m",
    canStop: true,
    ...overrides,
  };
}

const NO_AGENTS = { subagents: [], backgroundRuns: [], history: [] } as const;

/** A clean thread with no committed turn diffs behind it. */
const EMPTY_THREAD = { reviewableTurnCount: 0, agents: NO_AGENTS } as const;

describe("resolveWorkingTreeFileCount", () => {
  it("separates a clean tree from a status it cannot read", () => {
    expect(resolveWorkingTreeFileCount({ isRepo: true, workingTree: { files: [{}, {}] } })).toBe(2);
    expect(resolveWorkingTreeFileCount({ isRepo: true, workingTree: { files: [] } })).toBe(0);
    expect(resolveWorkingTreeFileCount({ isRepo: false, workingTree: { files: [{}] } })).toBeNull();
    expect(resolveWorkingTreeFileCount(null)).toBeNull();
  });
});

describe("rightPanelDiffTargetIsExplicit", () => {
  it("counts a file or a turn, but not the working tree the launcher already describes", () => {
    expect(rightPanelDiffTargetIsExplicit(null)).toBe(false);
    expect(rightPanelDiffTargetIsExplicit({ diffMode: "workingTree" })).toBe(false);
    expect(rightPanelDiffTargetIsExplicit({ diffFilePath: "apps/web/src/app.tsx" })).toBe(true);
    expect(rightPanelDiffTargetIsExplicit({ diffTurnId: TurnId.make("turn-1") })).toBe(true);
  });
});

describe("countReviewableTurnDiffs", () => {
  it("counts only turns that changed something, and keeps unknown unknown", () => {
    expect(countReviewableTurnDiffs([{ files: [{}] }, { files: [] }, { files: [{}, {}] }])).toBe(2);
    expect(countReviewableTurnDiffs([])).toBe(0);
    expect(countReviewableTurnDiffs(null)).toBeNull();
  });
});

describe("buildRightPanelLauncherStates", () => {
  it("dims Diff on a clean tree with no turn diffs, but never Source", () => {
    const states = buildRightPanelLauncherStates({
      workingTreeFileCount: 0,
      diffHasExplicitTarget: false,
      ...EMPTY_THREAD,
    });

    // Source stays lit whatever the tree says: switching branches, committing
    // and opening a pull request are all reasons to go there with nothing
    // changed. Only its description reports the clean tree.
    expect(states.sourceControl).toEqual({
      description: "No uncommitted changes.",
      empty: false,
    });
    expect(states.diff).toEqual({ description: "No changes to review.", empty: true });
  });

  it("says the folder is missing instead of describing a tree that is not there", () => {
    const states = buildRightPanelLauncherStates({
      workingTreeFileCount: null,
      diffHasExplicitTarget: false,
      checkoutMissing: true,
      ...EMPTY_THREAD,
    });

    // Source stays lit — the recovery actions live behind it — but neither git
    // surface may claim working-tree facts about a deleted checkout.
    expect(states.sourceControl).toEqual({
      description: "This thread's folder is missing.",
      empty: false,
    });
    expect(states.diff).toEqual({
      description: "This thread's folder is missing.",
      empty: true,
    });
  });

  it("reports the same change count on both git surfaces and dims neither", () => {
    const states = buildRightPanelLauncherStates({
      workingTreeFileCount: 12,
      diffHasExplicitTarget: false,
      ...EMPTY_THREAD,
    });

    expect(states.sourceControl).toEqual({ description: "12 files changed.", empty: false });
    expect(states.diff).toEqual({ description: "12 files changed.", empty: false });

    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: 1,
        diffHasExplicitTarget: false,
        ...EMPTY_THREAD,
      }).sourceControl?.description,
    ).toBe("1 file changed.");
  });

  it("never calls Diff empty while committed turn diffs are still reviewable", () => {
    // The commit that empties the tree leaves every turn's diff in the picker.
    const states = buildRightPanelLauncherStates({
      workingTreeFileCount: 0,
      reviewableTurnCount: 6,
      diffHasExplicitTarget: false,
      agents: NO_AGENTS,
    });

    expect(states.diff).toEqual({
      description: "No uncommitted changes, 6 turns to review.",
      empty: false,
    });
    expect(states.sourceControl).toEqual({ description: "No uncommitted changes.", empty: false });
  });

  it("leaves Diff lit when the thread's turns cannot be seen from here", () => {
    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: 0,
        reviewableTurnCount: null,
        diffHasExplicitTarget: false,
        agents: NO_AGENTS,
      }).diff,
    ).toEqual({ description: "No uncommitted changes.", empty: false });
  });

  it("keeps a targeted Diff tab undimmed and on its static copy over a clean tree", () => {
    const states = buildRightPanelLauncherStates({
      workingTreeFileCount: 0,
      diffHasExplicitTarget: true,
      ...EMPTY_THREAD,
    });

    expect(states.diff).toEqual({ description: "Review this thread's diff.", empty: false });
    // The Source surface still reports the tree it actually opens onto.
    expect(states.sourceControl?.description).toBe("No uncommitted changes.");
  });

  it("falls back to the static copy while the working tree is unknown", () => {
    const states = buildRightPanelLauncherStates({
      workingTreeFileCount: null,
      reviewableTurnCount: null,
      diffHasExplicitTarget: false,
      agents: null,
    });

    expect(states.sourceControl).toEqual({
      description: "Working tree changes on this branch.",
      empty: false,
    });
    expect(states.diff).toEqual({ description: "Review this thread's diff.", empty: false });
    expect(states.agents).toEqual({ description: "Subagents and background runs.", empty: false });
  });

  it("dims Agents only when the thread has never run one", () => {
    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: 0,
        reviewableTurnCount: 0,
        diffHasExplicitTarget: false,
        agents: NO_AGENTS,
      }).agents,
    ).toEqual({ description: "No agents yet.", empty: true });

    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: 0,
        reviewableTurnCount: 0,
        diffHasExplicitTarget: false,
        agents: {
          subagents: [],
          backgroundRuns: [],
          history: [
            { item: buildSubagent({ id: "a", status: "completed" }), resultBody: null },
            {
              item: buildSubagent({
                id: "b",
                agentThreadId: "agent-thread-2",
                status: "completed",
              }),
              resultBody: null,
            },
          ],
        },
      }).agents,
    ).toEqual({ description: "2 agents so far.", empty: false });
  });

  it("leads with what is running, and with what is waiting on the user", () => {
    const history = [
      {
        item: buildSubagent({ id: "old", agentThreadId: "agent-thread-old", status: "completed" }),
        resultBody: null,
      },
    ];

    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: null,
        reviewableTurnCount: 0,
        diffHasExplicitTarget: false,
        agents: { subagents: [buildSubagent()], backgroundRuns: [buildRun()], history },
      }).agents,
    ).toEqual({ description: "2 of 3 agents running.", empty: false });

    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: null,
        reviewableTurnCount: 0,
        diffHasExplicitTarget: false,
        agents: {
          subagents: [buildSubagent({ status: "waiting", statusLabel: "Needs approval" })],
          backgroundRuns: [],
          history,
        },
      }).agents,
    ).toEqual({ description: "1 of 2 agents needs you.", empty: false });

    // Nobody needs to be told "1 of 1".
    expect(
      buildRightPanelLauncherStates({
        workingTreeFileCount: null,
        reviewableTurnCount: 0,
        diffHasExplicitTarget: false,
        agents: { subagents: [buildSubagent()], backgroundRuns: [], history: [] },
      }).agents,
    ).toEqual({ description: "1 agent running.", empty: false });
  });
});
