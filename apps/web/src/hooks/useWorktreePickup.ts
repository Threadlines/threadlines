import { scopedProjectKey } from "@threadlines/client-runtime";
import type { EnvironmentId, ScopedProjectRef, VcsWorktreeStatus } from "@threadlines/contracts";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useConnectedComputerCapability } from "../environments/computerCapabilities";
import { vcsWorktreesMadeElsewhereQueryOptions } from "../lib/gitReactQuery";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { pickupCandidates, useWorktreePickupStore } from "../worktreePickup";

const NO_WORKTREES: ReadonlyArray<VcsWorktreeStatus> = [];

/**
 * A repository's worktrees made outside Threadlines
 * (docs/design/worktree-pickup.md). Empty for a computer whose server
 * predates pickup.
 *
 * They come named only, which is cheap enough for a count, a menu, or asking
 * whether a path is one of them. A list that shows what is in each asks with
 * `statuses`: the names stand in until the computer has read them
 * (`statusesLoaded`).
 */
export function useWorktreesMadeElsewhere(input: {
  readonly environmentId: EnvironmentId | null;
  /** Any checkout of the repository; every one lists the same worktrees. */
  readonly cwd: string | null;
  /** False keeps from asking the computer, for a surface that is not offering any now. */
  readonly enabled?: boolean;
  /** Also read what is in each worktree, for a list that shows it. */
  readonly statuses?: boolean;
}) {
  const supported = useConnectedComputerCapability(input.environmentId, "worktreePickup");
  const enabled = supported && (input.enabled ?? true);
  const namesQuery = useQuery(
    vcsWorktreesMadeElsewhereQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      statuses: false,
      enabled,
    }),
  );
  const statusesQuery = useQuery(
    vcsWorktreesMadeElsewhereQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      statuses: true,
      enabled: enabled && input.statuses === true,
    }),
  );
  // Only a list that asked for statuses reads them: they are fetched when it
  // is shown, so anything kept from an earlier showing can be long out of
  // date, and must not decide what a count or a menu lists.
  const read = input.statuses === true ? statusesQuery.data?.worktrees : undefined;
  // Nothing kept from before counts once the computer stops offering pickup
  // (it went back a version) or the surface stops asking.
  const worktrees = enabled ? (read ?? namesQuery.data?.worktrees ?? NO_WORKTREES) : NO_WORKTREES;
  /**
   * Whether a path is one of them, a thread's or not: a thread sent there is
   * a guest in it (ThreadWorktreeOrigin `existing`). False until the computer
   * has answered.
   */
  const isMadeElsewhere = useCallback(
    (path: string) =>
      worktrees.some(
        (worktree) => !worktree.managed && areFilesystemPathsEqual(worktree.path, path),
      ),
    [worktrees],
  );
  return {
    worktrees,
    isMadeElsewhere,
    /** The computer has answered: an empty list means there are none. */
    loaded: enabled && (read !== undefined || namesQuery.isSuccess),
    /** What is in each worktree is known, not just its name. */
    statusesLoaded: read !== undefined,
  };
}

/**
 * A project's worktrees made outside Threadlines that no thread works in yet,
 * and what this device remembers about offering them. Empty for a general
 * chat and a project not known yet.
 */
export function useWorktreePickup(input: {
  readonly projectRef: ScopedProjectRef | null;
  readonly projectCwd: string | null;
  readonly enabled?: boolean;
  readonly statuses?: boolean;
}) {
  const { projectRef, projectCwd } = input;
  const environmentId = projectRef?.environmentId ?? null;
  const projectKey = projectRef === null ? null : scopedProjectKey(projectRef);
  const offered = useWorktreePickupStore(
    (state) => projectKey !== null && state.offeredProjectKeys[projectKey] === true,
  );
  const hidden = useWorktreePickupStore(
    (state) => projectKey !== null && state.hiddenProjectKeys[projectKey] === true,
  );
  const { worktrees, loaded, statusesLoaded } = useWorktreesMadeElsewhere({
    environmentId,
    cwd: projectCwd,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
  });
  const threadWorktreePaths = useStore(
    useShallow((state) =>
      selectSidebarThreadsAcrossEnvironments(state)
        .filter((thread) => thread.environmentId === environmentId && thread.worktreePath !== null)
        .map((thread) => thread.worktreePath as string),
    ),
  );
  const candidates = useMemo(
    () =>
      projectCwd === null
        ? NO_WORKTREES
        : pickupCandidates({ worktrees, projectCwd, threadWorktreePaths }),
    [projectCwd, threadWorktreePaths, worktrees],
  );
  return { projectKey, candidates, offered, hidden, loaded, statusesLoaded };
}
