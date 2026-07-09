import {
  type EnvironmentId,
  type GitActionProgressEvent,
  type GitAuthRemediationActionId,
  type GitStackedAction,
  type ProviderReviewTarget,
  type SourceControlPublishRepositoryInput,
  type ThreadId,
} from "@threadlines/contracts";
import {
  keepPreviousData,
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ensureEnvironmentApi } from "../environmentApi";
import { requireEnvironmentConnection } from "../environments/runtime";

const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 120_000;
const GIT_BRANCHES_PAGE_SIZE = 100;

export const gitQueryKeys = {
  all: ["git"] as const,
  refs: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "refs", environmentId ?? null, cwd] as const,
  commitGraphPrefix: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "commit-graph", environmentId ?? null, cwd] as const,
  commitGraph: (environmentId: EnvironmentId | null, cwd: string | null, limit: number) =>
    ["git", "commit-graph", environmentId ?? null, cwd, limit] as const,
  commitDetails: (environmentId: EnvironmentId | null, cwd: string | null, sha: string | null) =>
    ["git", "commit-details", environmentId ?? null, cwd, sha] as const,
  workingTreeDiffPrefix: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "working-tree-diff", environmentId ?? null, cwd] as const,
  workingTreeDiff: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    filePaths: readonly string[] | null,
    ignoreWhitespace: boolean,
  ) =>
    [
      "git",
      "working-tree-diff",
      environmentId ?? null,
      cwd,
      filePaths?.join("\0") ?? null,
      ignoreWhitespace,
    ] as const,
  branchSearch: (environmentId: EnvironmentId | null, cwd: string | null, query: string) =>
    ["git", "refs", environmentId ?? null, cwd, "search", query] as const,
  authRemediationPlan: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "auth-remediation-plan", environmentId ?? null, cwd] as const,
};

export const gitMutationKeys = {
  init: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "init", environmentId ?? null, cwd] as const,
  switchRef: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "switchRef", environmentId ?? null, cwd] as const,
  createTag: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "createTag", environmentId ?? null, cwd] as const,
  deleteBranch: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "deleteBranch", environmentId ?? null, cwd] as const,
  mergeRef: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "mergeRef", environmentId ?? null, cwd] as const,
  discardChanges: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "discard-changes", environmentId ?? null, cwd] as const,
  stageChanges: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "stage-changes", environmentId ?? null, cwd] as const,
  unstageChanges: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "unstage-changes", environmentId ?? null, cwd] as const,
  runStackedAction: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "run-stacked-action", environmentId ?? null, cwd] as const,
  generateCommitMessage: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "generate-commit-message", environmentId ?? null, cwd] as const,
  startProviderReview: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "start-provider-review", environmentId ?? null, cwd] as const,
  pull: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "pull", environmentId ?? null, cwd] as const,
  preparePullRequestThread: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", environmentId ?? null, cwd] as const,
  publishRepository: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "publish-repository", environmentId ?? null, cwd] as const,
  applyAuthRemediation: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "apply-auth-remediation", environmentId ?? null, cwd] as const,
};

export function invalidateGitQueries(
  queryClient: QueryClient,
  input?: { environmentId?: EnvironmentId | null; cwd?: string | null },
) {
  const environmentId = input?.environmentId ?? null;
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.refs(environmentId, cwd) }),
      queryClient.invalidateQueries({
        queryKey: gitQueryKeys.commitGraphPrefix(environmentId, cwd),
      }),
    ]).then(() => undefined);
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

function invalidateGitBranchQueries(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  cwd: string | null,
) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return Promise.all([
    queryClient.invalidateQueries({ queryKey: gitQueryKeys.refs(environmentId, cwd) }),
    queryClient.invalidateQueries({
      queryKey: gitQueryKeys.commitGraphPrefix(environmentId, cwd),
    }),
  ]).then(() => undefined);
}

/**
 * @deprecated Use a VCS-named query helper once the UI naming migration lands.
 */
export function gitBranchSearchInfiniteQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.environmentId, input.cwd, normalizedQuery),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (!input.cwd) throw new Error("Git refs are unavailable.");
      if (!input.environmentId) throw new Error("Git refs are unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.listRefs({
        cwd: input.cwd,
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: [
      "git",
      "pull-request",
      input.environmentId ?? null,
      input.cwd,
      input.reference,
    ] as const,
    queryFn: async () => {
      if (!input.cwd || !input.reference || !input.environmentId) {
        throw new Error("Pull request lookup is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.environmentId !== null && input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitCommitGraphQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  limit?: number;
  enabled?: boolean;
}) {
  const limit = input.limit ?? 24;
  return queryOptions({
    queryKey: gitQueryKeys.commitGraph(input.environmentId, input.cwd, limit),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Git graph is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.commitGraph({ cwd: input.cwd, limit });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitCommitDetailsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  sha: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.commitDetails(input.environmentId, input.cwd, input.sha),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.sha) {
        throw new Error("Commit details are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.commitDetails({ cwd: input.cwd, sha: input.sha });
    },
    enabled:
      input.environmentId !== null &&
      input.cwd !== null &&
      input.sha !== null &&
      (input.enabled ?? true),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitWorkingTreeDiffQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  filePaths?: readonly string[] | null;
  ignoreWhitespace: boolean;
  enabled?: boolean;
}) {
  const filePaths =
    input.filePaths && input.filePaths.length > 0 ? [...input.filePaths].toSorted() : null;
  return queryOptions({
    queryKey: gitQueryKeys.workingTreeDiff(
      input.environmentId,
      input.cwd,
      filePaths,
      input.ignoreWhitespace,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Working tree diff is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.workingTreeDiff({
        cwd: input.cwd,
        ignoreWhitespace: input.ignoreWhitespace,
        ...(filePaths ? { filePaths } : {}),
      });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    staleTime: 2_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * @deprecated Use a VCS-named mutation helper once the UI naming migration lands.
 */
export function gitInitMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.environmentId, input.cwd),
    mutationFn: async () => {
      if (!input.cwd || !input.environmentId) throw new Error("Git init is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.init({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

/**
 * @deprecated Use a VCS-named mutation helper once the UI naming migration lands.
 */
export function gitCheckoutMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  type CheckoutMutationInput =
    | string
    | {
        readonly cwd?: string | null;
        readonly refName: string;
      };
  const resolveCheckoutInput = (args: CheckoutMutationInput) =>
    typeof args === "string"
      ? { cwd: input.cwd, refName: args }
      : { cwd: args.cwd ?? input.cwd, refName: args.refName };

  return mutationOptions({
    mutationKey: gitMutationKeys.switchRef(input.environmentId, input.cwd),
    mutationFn: async (args: CheckoutMutationInput) => {
      const checkout = resolveCheckoutInput(args);
      if (!checkout.cwd || !input.environmentId) throw new Error("Git switchRef is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.switchRef({ cwd: checkout.cwd, refName: checkout.refName });
    },
    onSettled: async (_data, _error, args) => {
      const checkout = resolveCheckoutInput(args);
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, checkout.cwd);
    },
  });
}

/**
 * @deprecated Use a VCS-named mutation helper once the UI naming migration lands.
 */
export function gitMergeRefMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.mergeRef(input.environmentId, input.cwd),
    mutationFn: async (refName: string) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git merge is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.mergeRef({ cwd: input.cwd, refName });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitCreateTagMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.createTag(input.environmentId, input.cwd),
    mutationFn: async (args: { tagName: string; targetSha: string }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git tag creation is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.createTag({
        cwd: input.cwd,
        tagName: args.tagName,
        targetSha: args.targetSha,
      });
    },
    onSettled: async () => {
      await input.queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
    },
  });
}

export function gitDeleteBranchMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.deleteBranch(input.environmentId, input.cwd),
    mutationFn: async (branchName: string) => {
      if (!input.cwd || !input.environmentId) throw new Error("Branch deletion is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.deleteBranch({
        cwd: input.cwd,
        branchName,
      });
    },
    onSettled: async () => {
      await input.queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
    },
  });
}

export function gitDiscardChangesMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.discardChanges(input.environmentId, input.cwd),
    mutationFn: async (args: { filePaths: string[]; scope?: "all" | "unstaged" }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Discard changes is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.discardChanges({
        cwd: input.cwd,
        filePaths: args.filePaths,
        ...(args.scope ? { scope: args.scope } : {}),
      });
    },
    onSettled: async () => {
      await input.queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
    },
  });
}

export function gitStageChangesMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.stageChanges(input.environmentId, input.cwd),
    mutationFn: async (args: { filePaths: string[] }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Stage changes is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.stageChanges({ cwd: input.cwd, filePaths: args.filePaths });
    },
    onSettled: async () => {
      await input.queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
    },
  });
}

export function gitUnstageChangesMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.unstageChanges(input.environmentId, input.cwd),
    mutationFn: async (args: { filePaths: string[] }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Unstage changes is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.unstageChanges({ cwd: input.cwd, filePaths: args.filePaths });
    },
    onSettled: async () => {
      await input.queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.environmentId, input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git action is unavailable.");
      return requireEnvironmentConnection(input.environmentId).client.git.runStackedAction(
        {
          action,
          actionId,
          cwd: input.cwd,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch: true } : {}),
          ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSettled: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitGenerateCommitMessageMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.generateCommitMessage(input.environmentId, input.cwd),
    mutationFn: async (args?: { filePaths?: string[] }) => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Commit message generation is unavailable.");
      }
      return requireEnvironmentConnection(input.environmentId).client.git.generateCommitMessage({
        cwd: input.cwd,
        ...(args?.filePaths && args.filePaths.length > 0 ? { filePaths: args.filePaths } : {}),
      });
    },
  });
}

export function gitStartProviderReviewMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  threadId: ThreadId | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.startProviderReview(input.environmentId, input.cwd),
    mutationFn: async (args: { target: ProviderReviewTarget }) => {
      if (!input.cwd || !input.environmentId || !input.threadId) {
        throw new Error("Codex review is unavailable for this thread.");
      }
      return requireEnvironmentConnection(input.environmentId).client.server.startProviderReview({
        threadId: input.threadId,
        cwd: input.cwd,
        target: args.target,
        delivery: "inline",
      });
    },
  });
}

/**
 * @deprecated Use a VCS-named mutation helper once the UI naming migration lands.
 */
export function gitPullMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.environmentId, input.cwd),
    mutationFn: async () => {
      if (!input.cwd || !input.environmentId) throw new Error("Git pull is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.vcs.pull({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

/**
 * Probes which auth fixes apply to the repository's remote (gh login state,
 * SSH access). Server-side probes can take several seconds, so this only
 * runs while the remediation dialog is open.
 */
export function gitAuthRemediationPlanQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.authRemediationPlan(input.environmentId, input.cwd),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Authentication remediation is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.authRemediationPlan({ cwd: input.cwd });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitApplyAuthRemediationMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.applyAuthRemediation(input.environmentId, input.cwd),
    mutationFn: async (args: { actionId: GitAuthRemediationActionId }) => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Authentication remediation is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.applyAuthRemediation({ cwd: input.cwd, actionId: args.actionId });
    },
    onSuccess: async () => {
      await Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: gitQueryKeys.authRemediationPlan(input.environmentId, input.cwd),
        }),
        invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd),
      ]);
    },
  });
}

export function sourceControlPublishRepositoryMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.publishRepository(input.environmentId, input.cwd),
    mutationFn: async (args: Omit<SourceControlPublishRepositoryInput, "cwd">) => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Repository publishing is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.sourceControl.publishRepository({ cwd: input.cwd, ...args });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

/**
 * @deprecated Use a VCS-named mutation helper once the UI naming migration lands.
 */
export function gitCreateWorktreeMutationOptions(input: {
  environmentId: EnvironmentId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "create-worktree", input.environmentId ?? null] as const,
    mutationFn: (
      args: Parameters<ReturnType<typeof ensureEnvironmentApi>["vcs"]["createWorktree"]>[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("Worktree creation is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).vcs.createWorktree(args);
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { environmentId: input.environmentId });
    },
  });
}

/**
 * @deprecated Use a VCS-named mutation helper once the UI naming migration lands.
 */
export function gitRemoveWorktreeMutationOptions(input: {
  environmentId: EnvironmentId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "remove-worktree", input.environmentId ?? null] as const,
    mutationFn: (
      args: Parameters<ReturnType<typeof ensureEnvironmentApi>["vcs"]["removeWorktree"]>[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("Worktree removal is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).vcs.removeWorktree(args);
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { environmentId: input.environmentId });
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.preparePullRequestThread(input.environmentId, input.cwd),
    mutationFn: async (args: {
      reference: string;
      mode: "local" | "worktree";
      threadId?: ThreadId;
    }) => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Pull request thread preparation is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference: args.reference,
        mode: args.mode,
        ...(args.threadId ? { threadId: args.threadId } : {}),
      });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}
