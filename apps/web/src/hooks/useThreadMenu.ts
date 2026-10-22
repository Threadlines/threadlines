import {
  EMPTY_CHILD_REQUEST_STATE,
  type ScopedThreadRef,
  type ThreadId,
} from "@threadlines/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { childAttachRefusal } from "@threadlines/shared/childThreads";
import { useCallback } from "react";

import {
  attachedParentKeyOf,
  isChildThreadWorking,
  resolveThreadStatusPill,
} from "../components/Sidebar.logic";
import { confirmThreadDeleteWithChildren } from "../components/ThreadDeleteDialog";
import { openThreadMoveDialog } from "../components/ThreadMoveDialog";
import { openThreadRenameDialog } from "../components/ThreadRenameDialog";
import {
  describeThreadMenu,
  describeThreadSelectionMenu,
  type ThreadMenuAction,
} from "../components/threadMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { readThreadMoveOffered } from "../environments/links/threadMoves";
import {
  markThreadDoneByKey,
  markThreadUnreadByKey,
  reopenThreadByKey,
} from "../lib/threadInboxSync";
import { newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  selectProjectByRef,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import type { SidebarThreadSummary } from "../types";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

/** The thread a menu is for, and what only its surface knows. */
export interface ThreadMenuTarget {
  readonly threadRef: ScopedThreadRef;
  /** Where the inbox files it, when the menu opens from the inbox; it offers Wrap up or Reopen. */
  readonly inbox?: { readonly isDone: boolean; readonly canMarkDone: boolean } | null;
  /** Renames in place (a sidebar row); without it, a dialog asks for the name. */
  readonly renameInPlace?: (() => void) | undefined;
}

type MenuPosition = { readonly x: number; readonly y: number };

const errorToast = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );

const summariesByKey = (): Map<string, SidebarThreadSummary> =>
  new Map(
    selectSidebarThreadsAcrossEnvironments(useStore.getState()).map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );

/**
 * A thread's menu, the same wherever a thread is offered: a sidebar row
 * (right-click or a held finger), a general chat, the command palette. It
 * reads the thread as it is when asked, so callers hold nothing but its ref.
 */
export function useThreadMenu() {
  const { archiveThread, deleteThread, pinThread, unpinThread } = useThreadActions();
  const confirmArchive = useSettings<boolean>((settings) => settings.confirmThreadArchive);
  const confirmDelete = useSettings<boolean>((settings) => settings.confirmThreadDelete);
  const { copyToClipboard: copyThreadId } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: ctx.threadId });
    },
    onError: (error) => errorToast("Failed to copy thread ID", error),
  });
  const { copyToClipboard: copyPath } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => errorToast("Failed to copy path", error),
  });

  /** The menu's items for a thread as it is now; null when the app doesn't know the thread. */
  const describe = useCallback((target: ThreadMenuTarget) => {
    const byKey = summariesByKey();
    const threadKey = scopedThreadKey(target.threadRef);
    const thread = byKey.get(threadKey);
    if (!thread) return null;
    const children = [...byKey.values()].filter(
      (candidate) => candidate.archivedAt === null && attachedParentKeyOf(candidate) === threadKey,
    );
    const workingChildCount = children.filter((child) =>
      isChildThreadWorking({
        threadKey: scopedThreadKey(scopeThreadRef(child.environmentId, child.id)),
        thread: child,
        status: resolveThreadStatusPill({ thread: child }),
        isDone: false,
      }),
    ).length;
    const parent =
      thread.parentThreadId != null
        ? (byKey.get(
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId)),
          ) ?? null)
        : null;
    const attachedChild = thread.attachedToParent === true && thread.parentThreadId != null;
    // Put back is offered while the parent is still around to take it; the
    // rules that can refuse it are the server's, read here first so the menu
    // says why.
    const putBack =
      !attachedChild && parent !== null && parent.archivedAt === null
        ? {
            parentTitle: parent.title,
            refusal: childAttachRefusal(
              {
                parentThreadId: thread.parentThreadId ?? null,
                childRequests:
                  selectThreadByRef(useStore.getState(), target.threadRef)?.childRequests ??
                  EMPTY_CHILD_REQUEST_STATE,
              },
              {
                parentThreadId: parent.parentThreadId ?? null,
                attachedToParent: parent.attachedToParent ?? false,
                archivedAt: parent.archivedAt,
                deletedAt: null,
              },
              children.length > 0 ||
                (thread.awaitedChildThreadCount ?? 0) > 0 ||
                thread.pendingChildApproval === true,
            ),
          }
        : null;
    const full = selectThreadByRef(useStore.getState(), target.threadRef);
    return describeThreadMenu({
      pinned: thread.pinnedAt !== null,
      inbox: target.inbox ?? null,
      attachedChild,
      putBack,
      workingChildCount,
      moveOffered: readThreadMoveOffered(thread.environmentId, thread.moveStatus),
      running: full?.session?.status === "running" && full.session.activeTurnId != null,
    });
  }, []);

  /** Does what the menu item says, for the thread as it is now. */
  const run = useCallback(
    async (action: ThreadMenuAction, target: ThreadMenuTarget) => {
      const { threadRef } = target;
      const threadKey = scopedThreadKey(threadRef);
      const byKey = summariesByKey();
      const thread = byKey.get(threadKey);
      if (!thread) return;
      switch (action) {
        case "rename":
          if (target.renameInPlace) target.renameInPlace();
          else openThreadRenameDialog(threadRef, thread.title);
          return;
        case "pin":
        case "unpin":
          try {
            if (action === "pin") await pinThread(threadRef);
            else await unpinThread(threadRef);
          } catch (error) {
            errorToast(action === "pin" ? "Failed to pin thread" : "Failed to unpin thread", error);
          }
          return;
        case "mark-unread":
          markThreadUnreadByKey(threadKey, thread.latestTurn?.completedAt);
          return;
        case "wrap-up":
          markThreadDoneByKey(threadKey);
          return;
        case "reopen":
          reopenThreadByKey(threadKey);
          return;
        case "separate":
        case "attach":
        case "stop-children": {
          const api = readEnvironmentApi(threadRef.environmentId);
          if (!api) return;
          try {
            await api.orchestration.dispatchCommand(
              action === "stop-children"
                ? {
                    type: "thread.children.stop",
                    commandId: newCommandId(),
                    threadId: threadRef.threadId,
                    createdAt: new Date().toISOString(),
                  }
                : {
                    type: "thread.parent-attachment.set",
                    commandId: newCommandId(),
                    threadId: threadRef.threadId,
                    attached: action === "attach",
                    createdAt: new Date().toISOString(),
                  },
            );
          } catch (error) {
            errorToast(
              action === "stop-children"
                ? "Could not stop its threads"
                : action === "attach"
                  ? "Could not put the thread back"
                  : "Could not make it its own thread",
              error,
            );
          }
          return;
        }
        case "move":
          openThreadMoveDialog(threadRef);
          return;
        case "copy-path": {
          const project = selectProjectByRef(
            useStore.getState(),
            scopeProjectRef(thread.environmentId, thread.projectId),
          );
          const path = thread.worktreePath ?? project?.cwd ?? null;
          if (!path) {
            errorToast("Path unavailable", new Error("This thread has no folder to copy."));
            return;
          }
          copyPath(path, { path });
          return;
        }
        case "copy-thread-id":
          copyThreadId(thread.id, { threadId: thread.id });
          return;
        case "archive": {
          const api = readLocalApi();
          if (
            confirmArchive &&
            api &&
            !(await api.dialogs.confirm(`Archive thread "${thread.title}"?`))
          ) {
            return;
          }
          try {
            await archiveThread(threadRef);
          } catch (error) {
            errorToast("Failed to archive thread", error);
          }
          return;
        }
        case "delete": {
          const api = readLocalApi();
          // A parent's threads are separated, not deleted, unless the user says so.
          const childCount = [...byKey.values()].filter(
            (candidate) =>
              candidate.archivedAt === null && attachedParentKeyOf(candidate) === threadKey,
          ).length;
          if (confirmDelete && childCount > 0) {
            const answer = await confirmThreadDeleteWithChildren({
              title: thread.title,
              childCount,
            });
            if (answer === null) return;
            await deleteThread(threadRef, { withChildren: answer.withChildren });
            return;
          }
          if (
            confirmDelete &&
            api &&
            !(await api.dialogs.confirm(
              [
                `Delete thread "${thread.title}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
            ))
          ) {
            return;
          }
          await deleteThread(threadRef);
          return;
        }
      }
    },
    [
      archiveThread,
      confirmArchive,
      confirmDelete,
      copyPath,
      copyThreadId,
      deleteThread,
      pinThread,
      unpinThread,
    ],
  );

  /** Opens the thread's menu at `position` and does what is picked. */
  const open = useCallback(
    async (target: ThreadMenuTarget, position: MenuPosition) => {
      const api = readLocalApi();
      const items = describe(target);
      if (!api || items === null) return;
      const clicked = await api.contextMenu.show(items, position);
      if (clicked) await run(clicked, target);
    },
    [describe, run],
  );

  /** The menu over several selected threads (by scoped key); `done` runs once it acted. */
  const openSelection = useCallback(
    async (threadKeys: ReadonlyArray<string>, position: MenuPosition, done: () => void) => {
      const api = readLocalApi();
      if (!api || threadKeys.length === 0) return;
      const byKey = summariesByKey();
      const threads = threadKeys.flatMap((key) => {
        const thread = byKey.get(key);
        return thread ? [{ key, thread }] : [];
      });
      const count = threads.length;
      if (count === 0) return;
      const clicked = await api.contextMenu.show(
        describeThreadSelectionMenu({
          count,
          allPinned: threads.every(({ thread }) => thread.pinnedAt !== null),
        }),
        position,
      );
      if (clicked === null) return;
      const refOf = (thread: SidebarThreadSummary) =>
        scopeThreadRef(thread.environmentId, thread.id);
      const isRunning = (thread: SidebarThreadSummary) => thread.latestTurn?.state === "running";
      switch (clicked) {
        case "mark-unread":
          for (const { key, thread } of threads) {
            markThreadUnreadByKey(key, thread.latestTurn?.completedAt);
          }
          break;
        case "pin":
        case "unpin":
          for (const { thread } of threads) {
            if ((thread.pinnedAt !== null) === (clicked === "pin")) continue;
            try {
              if (clicked === "pin") await pinThread(refOf(thread));
              else await unpinThread(refOf(thread));
            } catch (error) {
              errorToast(
                clicked === "pin" ? "Failed to pin thread" : "Failed to unpin thread",
                error,
              );
            }
          }
          break;
        case "wrap-up":
          for (const { key, thread } of threads) {
            if (!isRunning(thread)) markThreadDoneByKey(key);
          }
          break;
        case "archive": {
          if (
            confirmArchive &&
            !(await api.dialogs.confirm(`Archive ${count} thread${count === 1 ? "" : "s"}?`))
          ) {
            return;
          }
          for (const { thread } of threads) {
            if (isRunning(thread)) continue;
            try {
              await archiveThread(refOf(thread));
            } catch (error) {
              errorToast("Failed to archive thread", error);
            }
          }
          break;
        }
        case "delete": {
          if (
            confirmDelete &&
            !(await api.dialogs.confirm(
              [
                `Delete ${count} thread${count === 1 ? "" : "s"}?`,
                "This permanently clears conversation history for these threads.",
              ].join("\n"),
            ))
          ) {
            return;
          }
          const deletedThreadKeys = new Set(threads.map(({ key }) => key));
          for (const { thread } of threads) {
            await deleteThread(refOf(thread), { deletedThreadKeys });
          }
          break;
        }
      }
      done();
    },
    [archiveThread, confirmArchive, confirmDelete, deleteThread, pinThread, unpinThread],
  );

  return { describe, run, open, openSelection };
}
