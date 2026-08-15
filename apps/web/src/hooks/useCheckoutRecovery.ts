/**
 * Recovery state and actions for a thread whose folder was deleted.
 *
 * Two surfaces have to offer the same way out — the notice above the composer
 * and the source control panel — and they must agree on whether the checkout is
 * missing, whether it can be recreated, and what happens when the user acts. So
 * the branch lookup, the two mutations, and the busy state live here once
 * instead of being rebuilt per surface.
 *
 * @module useCheckoutRecovery
 */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { readEnvironmentApi } from "../environmentApi";
import {
  type CheckoutRecoveryState,
  type CheckoutStatusLike,
  selectCheckoutRecovery,
} from "../lib/checkoutRecovery";
import { gitBranchSearchInfiniteQueryOptions, invalidateGitQueries } from "../lib/gitReactQuery";
import { newCommandId } from "../lib/utils";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export interface CheckoutRecoveryView {
  /** Null when nothing is wrong with this thread's checkout. */
  readonly recovery: CheckoutRecoveryState | null;
  readonly isBusy: boolean;
  readonly onSwitchToProjectRoot: () => void;
  readonly onRecreateWorktree: () => void;
}

export function useCheckoutRecovery(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** Working directory the thread's surfaces operate in. */
  readonly cwd: string | null;
  readonly projectCwd: string | null;
  readonly branch: string | null;
  readonly status: CheckoutStatusLike | null | undefined;
}): CheckoutRecoveryView {
  const queryClient = useQueryClient();
  const [isBusy, setIsBusy] = useState(false);
  const pathMissing = input.status?.pathMissing === true;
  const branch = input.branch;

  // Only runs once a checkout is known to be missing, so the ordinary case
  // costs nothing. Recreating a worktree needs its branch to still exist;
  // offering the action without checking would hand the user a button that
  // fails.
  const branchQuery = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      environmentId: input.environmentId,
      cwd: input.projectCwd,
      query: branch ?? "",
      enabled: pathMissing && branch !== null && input.projectCwd !== null,
    }),
  );

  const branchExists = useMemo(() => {
    if (!pathMissing || branch === null) {
      return undefined;
    }
    if (branchQuery.isPending || branchQuery.data === undefined) {
      return undefined;
    }
    return branchQuery.data.pages.some((page) =>
      page.refs.some((ref) => !ref.isRemote && ref.name === branch),
    );
  }, [branch, branchQuery.data, branchQuery.isPending, pathMissing]);

  const recovery = useMemo(
    () =>
      selectCheckoutRecovery({
        cwd: input.cwd,
        projectCwd: input.projectCwd,
        branch,
        status: input.status,
        branchExists,
      }),
    [branch, branchExists, input.cwd, input.projectCwd, input.status],
  );

  const run = useCallback(
    async (
      action: (api: NonNullable<ReturnType<typeof readEnvironmentApi>>) => Promise<unknown>,
    ) => {
      const environmentId = input.environmentId;
      if (environmentId === null) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      setIsBusy(true);
      try {
        await action(api);
        await invalidateGitQueries(queryClient, { environmentId });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not recover this thread's folder",
            description: error instanceof Error ? error.message : "Unknown error.",
          }),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [input.environmentId, queryClient],
  );

  const onSwitchToProjectRoot = useCallback(() => {
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    // The same command the checkout picker dispatches: clearing the worktree
    // moves the thread to the project root, and the server cycles the session
    // into it on the next turn.
    void run((api) =>
      api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        worktreePath: null,
      }),
    );
  }, [input.threadId, run]);

  const onRecreateWorktree = useCallback(() => {
    if (!recovery?.projectCwd || !recovery.branch) {
      return;
    }
    const projectCwd = recovery.projectCwd;
    const refName = recovery.branch;
    const path = recovery.cwd;
    // Recreated at the same path on the same branch, so the thread resumes
    // exactly where it was rather than being moved somewhere new.
    void run((api) => api.vcs.createWorktree({ cwd: projectCwd, refName, path }));
  }, [recovery, run]);

  return { recovery, isBusy, onSwitchToProjectRoot, onRecreateWorktree };
}
