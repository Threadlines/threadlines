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
 * The threads a delete "with its threads" offers to take along: the thread's
 * attached children that are not archived, as this device knows them. The
 * dialog counts these and the delete names them (`alsoDelete`), so the server
 * deletes exactly what the user was shown: one still attached and unarchived
 * when it decides. A thread started after the dialog counted is separated and
 * kept. The server cleans up each thread it actually deletes
 * (ThreadDeletionReactor) and each client forgets it when its removal arrives.
 */
export function deletableChildThreadIds(target: ScopedThreadRef): ThreadId[] {
  return selectThreadsForEnvironment(useStore.getState(), target.environmentId)
    .filter(
      (thread) =>
        thread.parentThreadId === target.threadId &&
        thread.attachedToParent === true &&
        thread.archivedAt === null,
    )
    .map((thread) => thread.id);
}

/**
 * What `thread.delete` says about the family: with its threads, naming the
 * ones the dialog listed. `withChildren` stays for a server that predates
 * `alsoDelete`, where it means every attached child, one level.
 */
function familyDeleteFields(alsoDelete: ReadonlyArray<ThreadId> | undefined): {
  readonly withChildren?: true;
  readonly alsoDelete?: ThreadId[];
} {
  return alsoDelete === undefined ? {} : { withChildren: true, alsoDelete: [...alsoDelete] };
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
        /**
         * Child threads: delete these threads in its family too, the ones the
         * dialog listed (deletableChildThreadIds), instead of separating them.
         */
        alsoDelete?: ReadonlyArray<ThreadId>;
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
        const deletedChildren = opts.alsoDelete ?? [];
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: target.threadId,
          ...familyDeleteFields(opts.alsoDelete),
        });
        refreshArchivedThreadsForEnvironment(target.environmentId);
        const currentRouteThreadRef = getCurrentRouteThreadRef();
        if (
          currentRouteThreadRef?.environmentId === target.environmentId &&
          deletedChildren.includes(currentRouteThreadRef.threadId)
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

      // Its family goes with it when asked: the threads the dialog listed. The
      // server winds each one down; this device only steers away from them.
      const deletedChildren = opts.alsoDelete ?? [];
      await windDownThreadBeforeDelete(api, threadRef.environmentId, thread);

      const deletedThreadIds = new Set<ThreadId>([...(deletedIds ?? []), ...deletedChildren]);
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.environmentId === threadRef.environmentId &&
        (currentRouteThreadRef.threadId === threadRef.threadId ||
          deletedChildren.includes(currentRouteThreadRef.threadId));
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        ...familyDeleteFields(opts.alsoDelete),
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
      const childIds = deletableChildThreadIds(target);

      if (confirmThreadDelete && childIds.length > 0) {
        const answer = await confirmThreadDeleteWithChildren({
          title: title ?? "this thread",
          childCount: childIds.length,
        });
        if (answer === null) {
          return;
        }
        await deleteThread(target, answer.withChildren ? { alsoDelete: childIds } : {});
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
