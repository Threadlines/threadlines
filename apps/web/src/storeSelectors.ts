import { type ScopedProjectRef, type ScopedThreadRef, type ThreadId } from "@threadlines/contracts";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
import { type Project, type Thread } from "./types";
import {
  getThreadFromEnvironmentState,
  selectThreadActivities,
  selectThreadMessages,
  selectThreadProposedPlans,
  selectThreadTurnDiffSummaries,
} from "./threadDerivation";

export interface ThreadCheckoutSlice {
  readonly id: Thread["id"];
  readonly environmentId: Thread["environmentId"];
  readonly projectId: Thread["projectId"];
  readonly branch: Thread["branch"];
  readonly worktreePath: Thread["worktreePath"];
  readonly effectiveCwd: Thread["effectiveCwd"];
  readonly worktreeOrigin: Thread["worktreeOrigin"];
  readonly session: Thread["session"];
}

export interface ThreadProviderReviewSlice {
  readonly environmentId: Thread["environmentId"];
  readonly projectId: Thread["projectId"];
  readonly modelSelection: Thread["modelSelection"];
  readonly runtimeMode: Thread["runtimeMode"];
  readonly interactionMode: Thread["interactionMode"];
  readonly branch: Thread["branch"];
  readonly worktreePath: Thread["worktreePath"];
  readonly session: Thread["session"];
}

export interface ThreadDiffContextSlice {
  readonly id: Thread["id"];
  readonly environmentId: Thread["environmentId"];
  readonly projectId: Thread["projectId"];
  readonly worktreePath: Thread["worktreePath"];
  readonly effectiveCwd: Thread["effectiveCwd"];
  readonly turnDiffSummaries: Thread["turnDiffSummaries"];
}

export interface ThreadRouteSlice {
  readonly id: Thread["id"];
  readonly environmentId: Thread["environmentId"];
  readonly projectId: Thread["projectId"];
  readonly branch: Thread["branch"];
  readonly worktreePath: Thread["worktreePath"];
  readonly effectiveCwd: Thread["effectiveCwd"];
  readonly archivedAt: Thread["archivedAt"];
  readonly linkedPullRequests?: Exclude<Thread["linkedPullRequests"], undefined>;
  readonly dismissedPullRequests?: Exclude<Thread["dismissedPullRequests"], undefined>;
  readonly pullRequestAutoFix?: Exclude<Thread["pullRequestAutoFix"], undefined>;
  readonly pullRequestAutoMerge?: Exclude<Thread["pullRequestAutoMerge"], undefined>;
  readonly turnDiffSummaries: Thread["turnDiffSummaries"];
  readonly messageCount: number;
  readonly hasPromotableActivity: boolean;
}

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

/**
 * Selects only the checkout and session fields a branch/worktree control reads,
 * ignoring streaming message, activity, diff, and `updatedAt` churn.
 */
export function createThreadCheckoutSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadCheckoutSlice | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousValue: ThreadCheckoutSlice | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }
    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (previousEnvironmentState === environmentState) {
      return previousValue;
    }
    previousEnvironmentState = environmentState;

    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousValue = undefined;
      return undefined;
    }
    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    if (
      previousValue !== undefined &&
      previousValue.id === shell.id &&
      previousValue.environmentId === shell.environmentId &&
      previousValue.projectId === shell.projectId &&
      previousValue.branch === shell.branch &&
      previousValue.worktreePath === shell.worktreePath &&
      previousValue.effectiveCwd === shell.effectiveCwd &&
      previousValue.worktreeOrigin === shell.worktreeOrigin &&
      previousValue.session === session
    ) {
      return previousValue;
    }
    previousValue = {
      id: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      effectiveCwd: shell.effectiveCwd,
      worktreeOrigin: shell.worktreeOrigin,
      session,
    };
    return previousValue;
  };
}

/**
 * Selects only the fields needed to resolve provider review defaults in Source,
 * avoiding re-renders during streaming turns and unrelated shell metadata churn.
 */
export function createThreadProviderReviewSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadProviderReviewSlice | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousValue: ThreadProviderReviewSlice | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }
    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (previousEnvironmentState === environmentState) {
      return previousValue;
    }
    previousEnvironmentState = environmentState;

    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousValue = undefined;
      return undefined;
    }
    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    if (
      previousValue !== undefined &&
      previousValue.environmentId === shell.environmentId &&
      previousValue.projectId === shell.projectId &&
      previousValue.modelSelection === shell.modelSelection &&
      previousValue.runtimeMode === shell.runtimeMode &&
      previousValue.interactionMode === shell.interactionMode &&
      previousValue.branch === shell.branch &&
      previousValue.worktreePath === shell.worktreePath &&
      previousValue.session === session
    ) {
      return previousValue;
    }
    previousValue = {
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      session,
    };
    return previousValue;
  };
}

/**
 * Selects only the checkout and checkpoint diff summaries the diff panel reads,
 * avoiding re-renders on streaming messages, activities, or `updatedAt` ticks.
 */
export function createThreadDiffContextSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadDiffContextSlice | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousValue: ThreadDiffContextSlice | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }
    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (previousEnvironmentState === environmentState) {
      return previousValue;
    }
    previousEnvironmentState = environmentState;

    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousValue = undefined;
      return undefined;
    }
    const turnDiffSummaries = selectThreadTurnDiffSummaries(environmentState, ref.threadId);
    if (
      previousValue !== undefined &&
      previousValue.id === shell.id &&
      previousValue.environmentId === shell.environmentId &&
      previousValue.projectId === shell.projectId &&
      previousValue.worktreePath === shell.worktreePath &&
      previousValue.effectiveCwd === shell.effectiveCwd &&
      previousValue.turnDiffSummaries === turnDiffSummaries
    ) {
      return previousValue;
    }
    previousValue = {
      id: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      worktreePath: shell.worktreePath,
      effectiveCwd: shell.effectiveCwd,
      turnDiffSummaries,
    };
    return previousValue;
  };
}

/**
 * Selects the route-level slice for the chat thread view, keeping the route
 * shell quiet while assistant tokens and activities stream in.
 */
export function createThreadRouteSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadRouteSlice | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousValue: ThreadRouteSlice | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }
    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (previousEnvironmentState === environmentState) {
      return previousValue;
    }
    previousEnvironmentState = environmentState;

    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousValue = undefined;
      return undefined;
    }
    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    const turnState = environmentState.threadTurnStateById[ref.threadId];
    const turnDiffSummaries = selectThreadTurnDiffSummaries(environmentState, ref.threadId);
    const messageCount = selectThreadMessages(environmentState, ref.threadId).length;
    const hasPromotableActivity =
      (turnState?.latestTurn ?? null) !== null ||
      selectThreadActivities(environmentState, ref.threadId).length > 0 ||
      selectThreadProposedPlans(environmentState, ref.threadId).length > 0 ||
      turnDiffSummaries.length > 0 ||
      Boolean(shell.error) ||
      session?.status === "error" ||
      session?.orchestrationStatus === "error" ||
      session?.orchestrationStatus === "interrupted";

    if (
      previousValue !== undefined &&
      previousValue.id === shell.id &&
      previousValue.environmentId === shell.environmentId &&
      previousValue.projectId === shell.projectId &&
      previousValue.branch === shell.branch &&
      previousValue.worktreePath === shell.worktreePath &&
      previousValue.effectiveCwd === shell.effectiveCwd &&
      previousValue.archivedAt === shell.archivedAt &&
      previousValue.linkedPullRequests === shell.linkedPullRequests &&
      previousValue.dismissedPullRequests === shell.dismissedPullRequests &&
      previousValue.pullRequestAutoFix === shell.pullRequestAutoFix &&
      previousValue.pullRequestAutoMerge === shell.pullRequestAutoMerge &&
      previousValue.turnDiffSummaries === turnDiffSummaries &&
      previousValue.messageCount === messageCount &&
      previousValue.hasPromotableActivity === hasPromotableActivity
    ) {
      return previousValue;
    }
    previousValue = {
      id: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      effectiveCwd: shell.effectiveCwd,
      archivedAt: shell.archivedAt,
      ...(shell.linkedPullRequests !== undefined
        ? { linkedPullRequests: shell.linkedPullRequests }
        : {}),
      ...(shell.dismissedPullRequests !== undefined
        ? { dismissedPullRequests: shell.dismissedPullRequests }
        : {}),
      ...(shell.pullRequestAutoFix !== undefined
        ? { pullRequestAutoFix: shell.pullRequestAutoFix }
        : {}),
      ...(shell.pullRequestAutoMerge !== undefined
        ? { pullRequestAutoMerge: shell.pullRequestAutoMerge }
        : {}),
      turnDiffSummaries,
      messageCount,
      hasPromotableActivity,
    };
    return previousValue;
  };
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) {
      return undefined;
    }

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[ScopedThreadRef["environmentId"], EnvironmentState]>) {
      if (environmentState.threadShellById[threadId]) {
        return {
          environmentId,
          threadId,
        };
      }
    }
    return undefined;
  });
}
