/**
 * What each launcher row says about its surface, and whether that surface has
 * anything in it right now.
 *
 * Nothing here decides whether a row is clickable: an empty surface still
 * opens, and its own empty state explains itself. Emptiness only changes how a
 * row reads, because diffs and agents appear and vanish while a turn runs, and
 * a control that flickers dead is worse than one that opens onto nothing.
 *
 * Every description falls back to the surface's static copy while the real
 * state is unknown -- git status still loading, no repository, the chat column
 * has not published its agents yet -- so the launcher never claims a thread is
 * clean or agentless on missing data.
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { useMemo } from "react";

import { useGitStatus } from "../../lib/gitStatusState";
import { pluralize } from "../../lib/utils";
import {
  RIGHT_PANEL_SURFACES,
  type RightPanelDiffTarget,
  type RightPanelTab,
} from "../../rightPanelTabs";
import type { SubagentProgressItem, ThreadSubagentHistoryEntry } from "../../session-logic";
import { buildAgentsPanelView, summarizeLiveAgents } from "./agentsPanel.logic";
import type { ThreadBackgroundRunItem } from "./threadActivity";

export interface RightPanelSurfaceState {
  /** The one line under the row's label. */
  readonly description: string;
  /** Whether the surface currently holds nothing. Dims the row; never disables it. */
  readonly empty: boolean;
}

export type RightPanelLauncherStates = Readonly<
  Partial<Record<RightPanelTab, RightPanelSurfaceState>>
>;

/** The agent state the panel already receives, read only for its counts. */
export interface RightPanelLauncherAgentsInput {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  readonly history: ReadonlyArray<ThreadSubagentHistoryEntry>;
}

/** Just enough of a git status snapshot to count what the working tree holds. */
export interface RightPanelLauncherGitStatus {
  readonly isRepo: boolean;
  readonly workingTree: { readonly files: ReadonlyArray<unknown> };
}

/** Just enough of a turn's diff summary to know whether it has anything in it. */
export interface RightPanelLauncherTurnDiffSummary {
  readonly files: ReadonlyArray<unknown>;
}

/**
 * How many of the thread's turns actually changed a file. This is what the diff
 * panel's mode picker lists beneath "Uncommitted changes" and "All chat
 * changes", and it is the reason a clean working tree says nothing about
 * whether the Diff surface is empty: committing empties the tree and leaves
 * every one of these behind.
 */
export function countReviewableTurnDiffs(
  summaries: ReadonlyArray<RightPanelLauncherTurnDiffSummary> | null | undefined,
): number | null {
  if (!summaries) {
    return null;
  }
  return summaries.filter((summary) => summary.files.length > 0).length;
}

/**
 * How many files the working tree has touched: `0` is a clean tree, and null is
 * "not knowable" (status not delivered yet, or not a repository at all). The
 * two must stay distinct — reporting an unloaded status as clean would tell the
 * user a dirty branch has nothing on it.
 */
export function resolveWorkingTreeFileCount(
  status: RightPanelLauncherGitStatus | null | undefined,
): number | null {
  if (!status || !status.isRepo) {
    return null;
  }
  return status.workingTree.files.length;
}

/** Whether the Diff tab points at something the working tree does not describe. */
export function rightPanelDiffTargetIsExplicit(target: RightPanelDiffTarget | null): boolean {
  if (target === null) {
    return false;
  }
  return Boolean(target.diffFilePath) || Boolean(target.diffTurnId);
}

function staticState(tab: RightPanelTab): RightPanelSurfaceState {
  return { description: RIGHT_PANEL_SURFACES[tab].description, empty: false };
}

function changedFilesDescription(fileCount: number): string {
  return `${pluralize(fileCount, "file")} changed.`;
}

/** What both tree-backed rows say when the checkout folder itself is gone. */
const MISSING_CHECKOUT_DESCRIPTION = "This thread's folder is missing.";

/**
 * Source reports the working tree but is never dimmed by it: switching branches,
 * committing, pushing and opening a pull request are all reasons to go there
 * with nothing changed, so a clean tree is a fact about the tree rather than a
 * surface with nothing in it.
 */
function sourceControlState(
  fileCount: number | null,
  checkoutMissing: boolean,
): RightPanelSurfaceState {
  // Source is where the recovery actions live, so the row stays lit — but it
  // must not describe a working tree that is not there.
  if (checkoutMissing) {
    return { description: MISSING_CHECKOUT_DESCRIPTION, empty: false };
  }
  if (fileCount === null) {
    return staticState("sourceControl");
  }
  if (fileCount === 0) {
    return { description: "No uncommitted changes.", empty: false };
  }
  return { description: changedFilesDescription(fileCount), empty: false };
}

/**
 * Diff opens on the working tree, but its mode picker also holds "All chat
 * changes" and one entry per turn — content that outlives a commit. So it only
 * reads as empty when the tree is clean AND no turn left a diff behind, and a
 * clean tree with turns still in the picker gets a line that reports the tree
 * without claiming the surface is empty.
 *
 * When the turns cannot be seen from here (`reviewableTurnCount` null) the row
 * is never dimmed: a less informative row beats a wrong one.
 */
function diffState(input: {
  readonly fileCount: number | null;
  readonly reviewableTurnCount: number | null;
  readonly hasExplicitTarget: boolean;
  readonly checkoutMissing: boolean;
}): RightPanelSurfaceState {
  if (input.checkoutMissing) {
    return { description: MISSING_CHECKOUT_DESCRIPTION, empty: true };
  }
  // A tab aimed at one file or one turn is not the working tree's story at all.
  if (input.hasExplicitTarget || input.fileCount === null) {
    return staticState("diff");
  }
  if (input.fileCount > 0) {
    return { description: changedFilesDescription(input.fileCount), empty: false };
  }
  if (input.reviewableTurnCount === null) {
    return { description: "No uncommitted changes.", empty: false };
  }
  if (input.reviewableTurnCount === 0) {
    return { description: "No changes to review.", empty: true };
  }
  return {
    description: `No uncommitted changes, ${pluralize(input.reviewableTurnCount, "turn")} to review.`,
    empty: false,
  };
}

/**
 * Agents reports what the thread has actually run: how many, and how many of
 * them are still going or asking for something. The counts come from the same
 * view and live summary the panel itself renders from, so the row and the
 * surface behind it can never disagree.
 */
function agentsState(agents: RightPanelLauncherAgentsInput | null): RightPanelSurfaceState {
  if (agents === null) {
    return staticState("agents");
  }
  const view = buildAgentsPanelView(agents);
  const total = view.current.length + view.earlier.length;
  if (total === 0) {
    // Commands are not agents, but a surface with live rows on it is not
    // empty either.
    return view.commands.length > 0
      ? { description: `${pluralize(view.commands.length, "background command")}.`, empty: false }
      : { description: "No agents yet.", empty: true };
  }
  const live = summarizeLiveAgents(agents);
  const waitingCount = live?.waitingCount ?? 0;
  const runningCount = (live?.count ?? 0) - waitingCount;
  // `2 of 5 agents`, but plainly `2 agents` when that is all of them: nobody
  // needs to be told 2 of 2.
  const share = (count: number) =>
    count === total ? pluralize(total, "agent") : `${count} of ${pluralize(total, "agent")}`;
  if (waitingCount > 0) {
    // The one state that asks something of the user outranks the rest.
    return {
      description: `${share(waitingCount)} ${waitingCount === 1 ? "needs" : "need"} you.`,
      empty: false,
    };
  }
  if (runningCount > 0) {
    return { description: `${share(runningCount)} running.`, empty: false };
  }
  return { description: `${pluralize(total, "agent")} so far.`, empty: false };
}

export function buildRightPanelLauncherStates(input: {
  readonly workingTreeFileCount: number | null;
  /** Turns whose diffs the Diff tab's mode picker still offers. Null when that
   *  is not knowable from here, which keeps the row lit. */
  readonly reviewableTurnCount: number | null;
  /** A Diff tab aimed at one file or one turn is not described by the working
   *  tree, so a clean tree says nothing about whether it is empty. */
  readonly diffHasExplicitTarget: boolean;
  readonly agents: RightPanelLauncherAgentsInput | null;
  /** The checkout folder itself no longer exists; the tree-backed rows must
   *  not describe a working tree that is not there. */
  readonly checkoutMissing?: boolean;
}): RightPanelLauncherStates {
  const checkoutMissing = input.checkoutMissing === true;
  return {
    sourceControl: sourceControlState(input.workingTreeFileCount, checkoutMissing),
    diff: diffState({
      fileCount: input.workingTreeFileCount,
      reviewableTurnCount: input.reviewableTurnCount,
      hasExplicitTarget: input.diffHasExplicitTarget,
      checkoutMissing,
    }),
    agents: agentsState(input.agents),
  };
}

/**
 * The launcher's state for a thread, for the routes that compose the sidebar.
 *
 * The git status read here is the same refcounted subscription the chat column
 * and the Source surface already hold for this cwd, so the launcher costs no
 * extra traffic; `enabled` keeps even that share to the frames where the
 * launcher is the thing on screen.
 */
export function useRightPanelLauncherStates(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly diffTarget: RightPanelDiffTarget | null;
  /** The thread's turn diffs, straight off the store the diff panel's mode
   *  picker reads. Null means "not knowable here", not "none". */
  readonly turnDiffSummaries: ReadonlyArray<RightPanelLauncherTurnDiffSummary> | null;
  readonly agents: RightPanelLauncherAgentsInput | null;
}): RightPanelLauncherStates | undefined {
  const { agents, enabled } = input;
  const gitStatus = useGitStatus({
    environmentId: enabled ? input.environmentId : null,
    cwd: enabled ? input.cwd : null,
  });
  const workingTreeFileCount = resolveWorkingTreeFileCount(gitStatus.data);
  const reviewableTurnCount = countReviewableTurnDiffs(input.turnDiffSummaries);
  const diffHasExplicitTarget = rightPanelDiffTargetIsExplicit(input.diffTarget);
  const checkoutMissing = gitStatus.data?.pathMissing === true;
  return useMemo(
    () =>
      enabled
        ? buildRightPanelLauncherStates({
            workingTreeFileCount,
            reviewableTurnCount,
            diffHasExplicitTarget,
            agents,
            checkoutMissing,
          })
        : undefined,
    [
      agents,
      checkoutMissing,
      diffHasExplicitTarget,
      enabled,
      reviewableTurnCount,
      workingTreeFileCount,
    ],
  );
}
