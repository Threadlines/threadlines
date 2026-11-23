import { parseScopedThreadKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { type ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { readEnvironmentApi } from "../environmentApi";
import {
  gitRemoveWorktreeMutationOptions,
  invalidateGitQueries,
  runGitMutation,
} from "../lib/gitReactQuery";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { stopThreadSession } from "../lib/threadSessionCommands";
import { newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  selectProjectByRef,
  selectThreadByRef,
  selectThreadsForEnvironment,
  useStore,
} from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import {
  describeWorktreeRemovalError,
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
} from "../worktreeCleanup";
import { failureNotice, toastManager } from "../components/ui/toast";
import { confirmThreadDeleteWithChildren } from "../components/ThreadDeleteDialog";
import type { Thread } from "../types";
import { useSettings } from "./useSettings";

/**
 * Asks whether the folder should go too. Answers false when no confirm dialog
 * is available, so a worktree is never removed without the user saying so.
 */
async function confirmOrphanedWorktreeDeletion(worktreePath: string): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) {
    return false;
  }
  return localApi.dialogs.confirm(
    [
      "This thread is the only one linked to this worktree:",
      formatWorktreePathForDisplay(worktreePath),
      "",
      "Delete the worktree too?",
    ].join("\n"),
  );
}

/**
 * The threads a delete "with its threads" should take along: the thread's
 * attached children that are not archived, as this device knows them. The
 * server applies the same rule to its own state, so the count the user is
 * shown matches what goes. It can still differ when a child leaves the family
 * in the meantime, so this list only decides the count and where to navigate.
 * The server cleans up each thread it actually deletes (ThreadDeletionReactor)
 * and each client forgets it when its removal arrives.
 */
function selectDeletableChildThreads(target: ScopedThreadRef): Thread[] {
  return selectThreadsForEnvironment(useStore.getState(), target.environmentId).filter(
    (thread) =>
      thread.parentThreadId === target.threadId &&
      thread.attachedToParent === true &&
      thread.archivedAt === null,
  );
}

/** How many threads a delete "with its threads" would take along; see selectDeletableChildThreads. */
export function countAttachedChildThreads(target: ScopedThreadRef): number {
  return selectDeletableChildThreads(target).length;
}

/**
 * Stops the named thread's session and closes its terminals before the server
 * deletes it. Only for the thread the user named: its children are the
 * server's call, and one it keeps must not lose its terminal history.
 */
async function windDownThreadBeforeDelete(
  api: NonNullable<ReturnType<typeof readEnvironmentApi>>,
  environmentId: ScopedThreadRef["environmentId"],
  thread: Pick<Thread, "id" | "session">,
): Promise<void> {
  if (thread.session && thread.session.status !== "closed") {
    await stopThreadSession(scopeThreadRef(environmentId, thread.id)).catch(() => undefined);
  }
  try {
    await api.terminal.close({ threadId: thread.id, deleteHistory: true });
  } catch {
    // Terminal may already be closed.
  }
}

export function useThreadActions() {
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const router = useRouter();
  const { handleNewThread } = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;
  const queryClient = useQueryClient();

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const state = useStore.getState();
    const thread = selectThreadByRef(state, target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread, threadRef } = resolved;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error("Cannot archive a running thread.");
      }

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToDraft =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const archiveCommand = api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });

      if (shouldNavigateToDraft) {
        await handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId));
      }

      await archiveCommand;
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    },
    [getCurrentRouteThreadRef, resolveThreadTarget],
  );

  const unarchiveThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
    refreshArchivedThreadsForEnvironment(target.environmentId);
  }, []);

  const pinThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.pin",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
  }, []);

  const unpinThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unpin",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
  }, []);

  const removeOrphanedWorktree = useCallback(
    async (input: {
      readonly environmentId: ScopedThreadRef["environmentId"];
      readonly threadId: ThreadId;
      readonly projectCwd: string;
      readonly worktreePath: string;
    }) => {
      try {
        // As a mutation, so a pull still running in that worktree's header waits.
        await runGitMutation(
          queryClient,
          gitRemoveWorktreeMutationOptions({ environmentId: input.environmentId }),
          { cwd: input.projectCwd, path: input.worktreePath, force: true },
        );
        await invalidateGitQueries(queryClient, { environmentId: input.environmentId });
      } catch (error) {
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId: input.threadId,
          projectCwd: input.projectCwd,
          worktreePath: input.worktreePath,
          error,
        });
        toastManager.add(
          failureNotice({
            title: "Couldn't remove the worktree",
            reason: `The thread was deleted. Couldn't remove ${formatWorktreePathForDisplay(input.worktreePath)}. ${describeWorktreeRemovalError(error)}`,
          }),
        );
      }
    },
    [queryClient],
  );

  /** Drops what this device keeps for the deleted thread the user named: drafts and terminal state. */
  const forgetDeletedThread = useCallback(
    (environmentId: ScopedThreadRef["environmentId"], thread: Pick<Thread, "id" | "projectId">) => {
      const threadRef = scopeThreadRef(environmentId, thread.id);
      clearComposerDraftForThread(threadRef);
      clearProjectDraftThreadById(scopeProjectRef(environmentId, thread.projectId), threadRef);
      clearTerminalState(threadRef);
    },
    [clearComposerDraftForThread, clearProjectDraftThreadById, clearTerminalState],
  );

  const deleteThread = useCallback(
    async (
      target: ScopedThreadRef,
      opts: {
        deletedThreadKeys?: ReadonlySet<string>;
        /** Child threads: delete the threads in its family too, instead of separating them. */
        withChildren?: boolean;
      } = {},
    ) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) {
        // Thread not in the main store (archived): its worktree link only
        // survives in the archived snapshot, so read it from there and offer
        // the same cleanup the live path offers.
        const snapshot = await api.orchestration.getArchivedShellSnapshot().catch(() => null);
        const archivedThreads = snapshot?.threads ?? [];
        const archivedThread = archivedThreads.find((entry) => entry.id === target.threadId);
        const liveThreads = selectThreadsForEnvironment(useStore.getState(), target.environmentId);
        const orphanedWorktreePath = getOrphanedWorktreePathForThread(
          liveThreads,
          target.threadId,
          archivedThreads,
        );
        const projectCwd =
          archivedThread === undefined
            ? undefined
            : snapshot?.projects.find((project) => project.id === archivedThread.projectId)
                ?.workspaceRoot;
        const shouldDeleteWorktree =
          orphanedWorktreePath !== null &&
          projectCwd !== undefined &&
          (await confirmOrphanedWorktreeDeletion(orphanedWorktreePath));

        // An archived parent can still have live threads in its family. The
        // server winds down and deletes the ones it takes along.
        const deletedChildren = opts.withChildren ? selectDeletableChildThreads(target) : [];
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: target.threadId,
          ...(opts.withChildren ? { withChildren: true } : {}),
        });
        refreshArchivedThreadsForEnvironment(target.environmentId);
        const currentRouteThreadRef = getCurrentRouteThreadRef();
        if (
          currentRouteThreadRef?.environmentId === target.environmentId &&
          deletedChildren.some((child) => child.id === currentRouteThreadRef.threadId)
        ) {
          await router.navigate({ to: "/", replace: true });
        }

        if (shouldDeleteWorktree && orphanedWorktreePath && projectCwd) {
          await removeOrphanedWorktree({
            environmentId: target.environmentId,
            threadId: target.threadId,
            projectCwd,
            worktreePath: orphanedWorktreePath,
          });
        }
        return;
      }
      const { thread, threadRef } = resolved;
      const state = useStore.getState();
      const threads = selectThreadsForEnvironment(state, threadRef.environmentId);
      const threadProject = selectProjectByRef(state, {
        environmentId: threadRef.environmentId,
        projectId: thread.projectId,
      });
      const deletedIds =
        opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
          ? new Set<ThreadId>(
              [...opts.deletedThreadKeys].flatMap((threadKey) => {
                const ref = parseScopedThreadKey(threadKey);
                return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
              }),
            )
          : undefined;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
          : threads;
      // Archived threads keep their worktree link, so they have to be weighed
      // before offering to remove the folder one of them still points at.
      const archivedThreads = thread.worktreePath
        ? ((await api.orchestration.getArchivedShellSnapshot().catch(() => null))?.threads ?? [])
        : [];
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        survivingThreads,
        threadRef.threadId,
        archivedThreads,
      );
      const shouldDeleteWorktree =
        orphanedWorktreePath !== null &&
        threadProject !== undefined &&
        (await confirmOrphanedWorktreeDeletion(orphanedWorktreePath));

      // Its family goes with it when asked. The server decides which children
      // that is and winds each one down; this device only steers away from them.
      const deletedChildren = opts.withChildren ? selectDeletableChildThreads(threadRef) : [];
      await windDownThreadBeforeDelete(api, threadRef.environmentId, thread);

      const deletedThreadIds = new Set<ThreadId>([
        ...(deletedIds ?? []),
        ...deletedChildren.map((child) => child.id),
      ]);
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.environmentId === threadRef.environmentId &&
        (currentRouteThreadRef.threadId === threadRef.threadId ||
          deletedChildren.some((child) => child.id === currentRouteThreadRef.threadId));
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        ...(opts.withChildren ? { withChildren: true } : {}),
      });
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      forgetDeletedThread(threadRef.environmentId, thread);

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          const fallbackThread = selectThreadByRef(
            useStore.getState(),
            scopeThreadRef(threadRef.environmentId, fallbackThreadId),
          );
          if (fallbackThread) {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            });
          } else {
            await router.navigate({ to: "/", replace: true });
          }
        } else {
          await router.navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      await removeOrphanedWorktree({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        projectCwd: threadProject.cwd,
        worktreePath: orphanedWorktreePath,
      });
    },
    [
      forgetDeletedThread,
      getCurrentRouteThreadRef,
      removeOrphanedWorktree,
      router,
      resolveThreadTarget,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef, opts: { title?: string } = {}) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const title = opts.title ?? resolved?.thread.title;
      const childCount = countAttachedChildThreads(target);

      if (confirmThreadDelete && childCount > 0) {
        const answer = await confirmThreadDeleteWithChildren({
          title: title ?? "this thread",
          childCount,
        });
        if (answer === null) {
          return;
        }
        await deleteThread(target, { withChildren: answer.withChildren });
        return;
      }

      if (confirmThreadDelete && localApi) {
        const confirmed = await localApi.dialogs.confirm(
          [
            title ? `Delete thread "${title}"?` : "Delete this thread?",
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return {
    archiveThread,
    unarchiveThread,
    pinThread,
    unpinThread,
    deleteThread,
    confirmAndDeleteThread,
  };
}
