import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
  getWsRpcClientForEnvironment: vi.fn(),
}));

import type { InfiniteData } from "@tanstack/react-query";
import {
  EnvironmentId,
  type VcsCommitGraphResult,
  type VcsListRefsResult,
} from "@threadlines/contracts";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitApplyStashMutationOptions,
  gitCommitGraphQueryOptions,
  gitCreateStashMutationOptions,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStashesQueryOptions,
  gitWorkingTreeDiffQueryOptions,
  invalidateGitQueries,
  invalidateGitWorkingTreeDiffQueries,
} from "./gitReactQuery";
import { ensureEnvironmentApi } from "../environmentApi";

const BRANCH_QUERY_RESULT: VcsListRefsResult = {
  refs: [],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 0,
};

const BRANCH_SEARCH_RESULT: InfiniteData<VcsListRefsResult, number> = {
  pages: [BRANCH_QUERY_RESULT],
  pageParams: [0],
};
const COMMIT_GRAPH_RESULT: VcsCommitGraphResult = {
  commits: [],
  truncated: false,
};
const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

describe("git ref query options", () => {
  it("refreshes the shared snapshot once and does not poll in the background", async () => {
    const listRefs = vi.fn(async () => BRANCH_QUERY_RESULT);
    vi.mocked(ensureEnvironmentApi).mockReturnValue({ vcs: { listRefs } } as never);
    const options = gitBranchSearchInfiniteQueryOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      query: "feature",
    });

    await options.queryFn?.({ pageParam: 0 } as never);
    await options.queryFn?.({ pageParam: 100 } as never);

    expect(listRefs).toHaveBeenNthCalledWith(1, {
      cwd: "/repo/a",
      query: "feature",
      cursor: 0,
      limit: 100,
      refresh: true,
    });
    expect(listRefs).toHaveBeenNthCalledWith(2, {
      cwd: "/repo/a",
      query: "feature",
      cursor: 100,
      limit: 100,
      refresh: false,
    });
    expect(options.refetchInterval).toBeUndefined();
  });
});

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction(ENVIRONMENT_A, "/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.pull(ENVIRONMENT_A, "/repo/b"),
    );
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread(ENVIRONMENT_A, "/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction(ENVIRONMENT_A, "/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull(ENVIRONMENT_A, "/repo/a"));
  });

  it("passes an explicit rewritten-history confirmation to the pull API", async () => {
    const pull = vi.fn(async () => ({
      status: "reconciled" as const,
      refName: "main",
      upstreamRef: "origin/main",
      recoveryRef: "refs/threadlines/recovery/main-20260713T120000Z",
    }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({ vcs: { pull } } as never);
    const options = gitPullMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    const mutationFn = options.mutationFn;
    expect(mutationFn).toBeDefined();

    await mutationFn?.(
      {
        historyReconciliation: {
          refName: "main",
          upstreamRef: "origin/main",
          expectedLocalSha: "1111111111111111111111111111111111111111",
          expectedUpstreamSha: "2222222222222222222222222222222222222222",
        },
      },
      {} as never,
    );

    expect(pull).toHaveBeenCalledWith({
      cwd: "/repo/a",
      historyReconciliation: {
        refName: "main",
        upstreamRef: "origin/main",
        expectedLocalSha: "1111111111111111111111111111111111111111",
        expectedUpstreamSha: "2222222222222222222222222222222222222222",
      },
    });
  });

  it("passes explicit stash protection to the pull API", async () => {
    const pull = vi.fn(async () => ({
      status: "pulled_with_restored_changes" as const,
      refName: "main",
      upstreamRef: "origin/main",
      stashId: "0123456789abcdef0123456789abcdef01234567",
      stashDropped: true,
    }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({ vcs: { pull } } as never);
    const options = gitPullMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });

    await options.mutationFn?.({ stashLocalChanges: true }, {} as never);

    expect(pull).toHaveBeenCalledWith({
      cwd: "/repo/a",
      stashLocalChanges: true,
    });
  });

  it("binds explicit stash creation and apply requests", async () => {
    const createStash = vi.fn(async () => ({
      stash: {
        id: "0123456789abcdef0123456789abcdef01234567",
        selector: "stash@{0}",
        message: "Explorer fix",
        createdAt: "2026-07-24T12:00:00.000Z",
        recoveryBranch: null,
      },
    }));
    const applyStash = vi.fn(async () => ({
      status: "applied" as const,
      stashId: "0123456789abcdef0123456789abcdef01234567",
      dropped: true,
      conflictedPaths: [],
    }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({
      vcs: { createStash, applyStash },
    } as never);
    const createOptions = gitCreateStashMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    const applyOptions = gitApplyStashMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });

    await createOptions.mutationFn?.(
      { message: "Explorer fix", includeUntracked: true },
      {} as never,
    );
    await applyOptions.mutationFn?.(
      {
        selector: "stash@{0}",
        expectedStashId: "0123456789abcdef0123456789abcdef01234567",
        dropAfterApply: true,
      },
      {} as never,
    );

    expect(createStash).toHaveBeenCalledWith({
      cwd: "/repo/a",
      message: "Explorer fix",
      includeUntracked: true,
    });
    expect(applyStash).toHaveBeenCalledWith({
      cwd: "/repo/a",
      selector: "stash@{0}",
      expectedStashId: "0123456789abcdef0123456789abcdef01234567",
      dropAfterApply: true,
    });
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(
      gitMutationKeys.preparePullRequestThread(ENVIRONMENT_A, "/repo/a"),
    );
  });
});

describe("git stash query options", () => {
  it("lists stashes for the selected checkout", async () => {
    const listStashes = vi.fn(async () => ({ stashes: [] }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({ vcs: { listStashes } } as never);
    const options = gitStashesQueryOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
    });

    await options.queryFn?.({} as never);

    expect(listStashes).toHaveBeenCalledWith({ cwd: "/repo/a" });
  });
});

describe("invalidateGitQueries", () => {
  it("can invalidate a single cwd without blasting other git query scopes", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo/a",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        environmentId: ENVIRONMENT_B,
        cwd: "/repo/b",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(
      gitCommitGraphQueryOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo/a",
      }).queryKey,
      COMMIT_GRAPH_RESULT,
    );
    queryClient.setQueryData(
      gitCommitGraphQueryOptions({
        environmentId: ENVIRONMENT_B,
        cwd: "/repo/b",
      }).queryKey,
      COMMIT_GRAPH_RESULT,
    );

    await invalidateGitQueries(queryClient, { environmentId: ENVIRONMENT_A, cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          environmentId: ENVIRONMENT_A,
          cwd: "/repo/a",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          environmentId: ENVIRONMENT_B,
          cwd: "/repo/b",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        gitCommitGraphQueryOptions({
          environmentId: ENVIRONMENT_A,
          cwd: "/repo/a",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitCommitGraphQueryOptions({
          environmentId: ENVIRONMENT_B,
          cwd: "/repo/b",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
  });

  it("reuses commit graph data across page sizes but never across repositories", () => {
    const options = gitCommitGraphQueryOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      limit: 48,
    });
    const placeholderData = options.placeholderData as (
      previousData: VcsCommitGraphResult | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ) => VcsCommitGraphResult | undefined;
    const previousKeyFor = (environmentId: EnvironmentId, cwd: string) => ({
      queryKey: gitCommitGraphQueryOptions({ environmentId, cwd, limit: 24 }).queryKey,
    });

    expect(placeholderData(COMMIT_GRAPH_RESULT, previousKeyFor(ENVIRONMENT_A, "/repo/a"))).toEqual(
      COMMIT_GRAPH_RESULT,
    );
    expect(
      placeholderData(COMMIT_GRAPH_RESULT, previousKeyFor(ENVIRONMENT_A, "/repo/b")),
    ).toBeUndefined();
    expect(
      placeholderData(COMMIT_GRAPH_RESULT, previousKeyFor(ENVIRONMENT_B, "/repo/a")),
    ).toBeUndefined();
    expect(placeholderData(COMMIT_GRAPH_RESULT, undefined)).toBeUndefined();
  });
});

describe("invalidateGitWorkingTreeDiffQueries", () => {
  it("invalidates every diff variant for one checkout only", async () => {
    const queryClient = new QueryClient();
    const targetDiffKeys = [false, true].map(
      (ignoreWhitespace) =>
        gitWorkingTreeDiffQueryOptions({
          environmentId: ENVIRONMENT_A,
          cwd: "/repo/a",
          filePaths: null,
          ignoreWhitespace,
        }).queryKey,
    );
    const otherDiffKey = gitWorkingTreeDiffQueryOptions({
      environmentId: ENVIRONMENT_B,
      cwd: "/repo/b",
      filePaths: null,
      ignoreWhitespace: false,
    }).queryKey;

    for (const queryKey of [...targetDiffKeys, otherDiffKey]) {
      queryClient.setQueryData(queryKey, { diff: "cached" });
    }

    await invalidateGitWorkingTreeDiffQueries(queryClient, {
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
    });

    for (const queryKey of targetDiffKeys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(otherDiffKey)?.isInvalidated).toBe(false);
  });
});
