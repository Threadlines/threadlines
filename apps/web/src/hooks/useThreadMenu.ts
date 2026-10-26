import { EMPTY_CHILD_REQUEST_STATE, type ScopedThreadRef } from "@threadlines/contracts";
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
  isThreadTurnRunning,
  describeThreadSelectionMenu,
  type ThreadMenuAction,
} from "../components/threadMenu.logic";
import { failureNotice, toastManager } from "../components/ui/toast";
import { copyWithNotice } from "../components/ui/copyWithNotice";
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

const errorToast = (title: `Couldn't ${string}`, error: unknown) =>
  toastManager.add(
    failureNotice({
      title,
      error,
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
      running: isThreadTurnRunning(full?.session),
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
            errorToast(
              action === "pin" ? "Couldn't pin the thread" : "Couldn't unpin the thread",
              error,
            );
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
                ? "Couldn't stop its threads"
                : action === "attach"
                  ? "Couldn't put the thread back"
                  : "Couldn't make it its own thread",
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
            errorToast("Couldn't copy the path", new Error("This thread has no folder to copy."));
            return;
          }
          void copyWithNotice(path, "path");
          return;
        }
        case "copy-thread-id":
          void copyWithNotice(thread.id, "thread ID");
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
            errorToast("Couldn't archive the thread", error);
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
    [archiveThread, confirmArchive, confirmDelete, deleteThread, pinThread, unpinThread],
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

  /**
   * The menu over several selected threads (by scoped key). `inboxOf` says
   * where the inbox files each one now (null outside it); `done` runs once
   * the menu acted. The threads are read again after the pick, so a thread
   * that finished while the menu was open is treated as finished.
   */
  const openSelection = useCallback(
    async (
      threadKeys: ReadonlyArray<string>,
      position: MenuPosition,
      inboxOf: (threadKey: string) => ThreadMenuTarget["inbox"],
      done: () => void,
    ) => {
      const api = readLocalApi();
      if (!api || threadKeys.length === 0) return;
      const selected = () => {
        const byKey = summariesByKey();
        return threadKeys.flatMap((key) => {
          const thread = byKey.get(key);
          return thread ? [{ key, thread }] : [];
        });
      };
      const shown = selected();
      if (shown.length === 0) return;
      const clicked = await api.contextMenu.show(
        describeThreadSelectionMenu({
          count: shown.length,
          allPinned: shown.every(({ thread }) => thread.pinnedAt !== null),
        }),
        position,
      );
      if (clicked === null) return;
      const threads = selected();
      const count = threads.length;
      if (count === 0) return;
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
                clicked === "pin" ? "Couldn't pin the thread" : "Couldn't unpin the thread",
                error,
              );
            }
          }
          break;
        case "wrap-up":
          // Only what its own menu would wrap up: not a pinned or running
          // thread, nor one already wrapped (that would restamp it).
          for (const { key } of threads) {
            const inbox = inboxOf(key);
            if (inbox && !inbox.isDone && inbox.canMarkDone) markThreadDoneByKey(key);
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
              errorToast("Couldn't archive the thread", error);
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
