import type { EnvironmentId } from "@threadlines/contracts";
import { findRefForBranchName, resolveNewWorktreeBaseBranch } from "@threadlines/shared/git";
import { useInfiniteQuery } from "@tanstack/react-query";

import { gitBranchSearchInfiniteQueryOptions } from "../lib/gitReactQuery";
import { useComputerConfig } from "../newThreadDefaults";

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
