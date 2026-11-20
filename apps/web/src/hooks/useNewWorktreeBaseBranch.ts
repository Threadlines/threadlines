import type { EnvironmentId } from "@threadlines/contracts";
import { findRefForBranchName, resolveNewWorktreeBaseBranch } from "@threadlines/shared/git";
import { type QueryClient, useInfiniteQuery } from "@tanstack/react-query";

import { gitBranchSearchInfiniteQueryOptions } from "../lib/gitReactQuery";
import { useComputerConfig, waitForComputerConfig } from "../newThreadDefaults";

/**
 * The same base as `useNewWorktreeBaseBranch`, for a send that goes before
 * the hook has it: the branch list can take seconds on a busy repository,
 * and the first message of a new worktree thread waits for it rather than
 * failing. Shares the hook's queries, so a lookup already running is joined,
 * not repeated. Null when the computer's settings never come or no branch
 * fits; a failed lookup rejects.
 */
/** How long a send waits for a computer's settings (a remote one can be slow to connect). */
const SEND_SETTINGS_WAIT_MS = 15_000;

export async function fetchNewWorktreeBaseBranch(input: {
  readonly queryClient: QueryClient;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}): Promise<string | null> {
  const base = (await waitForComputerConfig(input.environmentId, SEND_SETTINGS_WAIT_MS))?.settings
    .newWorktreeBase;
  if (base === undefined) {
    return null;
  }
  const namedBranch = base.from === "named" ? base.branch : "";
  const lookup = (query: string) =>
    input.queryClient.fetchInfiniteQuery(
      gitBranchSearchInfiniteQueryOptions({
        environmentId: input.environmentId,
        cwd: input.cwd,
        query,
      }),
    );
  const [listed, named] = await Promise.all([
    lookup(""),
    namedBranch.length > 0 ? lookup(namedBranch) : null,
  ]);
  const listedRefs = listed.pages.flatMap((page) => page.refs);
  return resolveNewWorktreeBaseBranch({
    base,
    refs: [...listedRefs, ...(named?.pages.flatMap((page) => page.refs) ?? [])],
    currentBranch: listedRefs.find((candidate) => candidate.current)?.name ?? null,
  });
}

/**
 * The branch a new worktree starts from until the user picks one: the
 * computer's "New worktrees from" setting (Settings › Threads) applied to
 * `cwd`'s refs. Undefined until it is `needed` and what it rests on is known
 * (the computer's settings, and those refs unless the setting is the current
 * branch). A lookup that fails leaves it undefined, so the user picks a base
 * rather than getting a fallback the setting didn't ask for. The lookups load
 * while the thread only `canStartWorktree`, so switching to a new worktree
 * finds the base ready instead of showing another branch first.
 */
export function useNewWorktreeBaseBranch(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly currentGitBranch: string | null;
  readonly canStartWorktree: boolean;
  readonly needed: boolean;
}): string | null | undefined {
  const base = useComputerConfig(input.environmentId)?.settings.newWorktreeBase;
  const namedBranch = base?.from === "named" ? base.branch : "";
  const load = input.canStartWorktree || input.needed;
  // The unfiltered list leads with the current and default branches; a
  // search leads with the branch of exactly that name.
  const listed = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      query: "",
      enabled: load,
    }),
  );
  const named = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      query: namedBranch,
      enabled: load && namedBranch.length > 0,
    }),
  );
  if (!input.needed || base === undefined) {
    return undefined;
  }
  if (base.from === "current" && input.currentGitBranch !== null) {
    return input.currentGitBranch;
  }
  // A lookup still loading, or one that failed without a past answer, says
  // nothing about where the branch is: no base yet rather than a fallback.
  if (listed.data === undefined || (namedBranch.length > 0 && named.data === undefined)) {
    return undefined;
  }
  const listedRefs = listed.data.pages.flatMap((page) => page.refs);
  const refs = [...listedRefs, ...(named.data?.pages.flatMap((page) => page.refs) ?? [])];
  // A cached lookup that missed the branch waits for the refetch, which may
  // find one made since.
  if (named.isFetching && findRefForBranchName(refs, namedBranch) === null) {
    return undefined;
  }
  return resolveNewWorktreeBaseBranch({
    base,
    refs,
    currentBranch:
      input.currentGitBranch ?? listedRefs.find((candidate) => candidate.current)?.name ?? null,
  });
}
