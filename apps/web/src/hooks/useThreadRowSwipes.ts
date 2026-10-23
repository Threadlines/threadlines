import { parseScopedThreadKey } from "@threadlines/client-runtime";
import { useCallback, useRef, useState } from "react";

import type { SwipeUndo } from "../components/sidebar/SwipeUndoBar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { reopenThreadByKey } from "../lib/threadInboxSync";
import { useSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";
import { useThreadMenu } from "./useThreadMenu";

/**
 * What a swipe on a thread row asks for: the same actions, by the same names,
 * as the thread's menu, so a swipe and a menu pick behave alike.
 */
export type ThreadRowSwipeAction = "pin" | "unpin" | "wrap-up" | "reopen" | "archive";

/** Runs a row's swipe action; the row passes its thread's key and title. */
export type ThreadRowSwipeHandler = (
  action: ThreadRowSwipeAction,
  threadKey: string,
  title: string,
) => void;

/**
 * Runs swipe actions for a list of thread rows (the inbox, the chats lists),
 * and keeps the Undo a list shows after one, for its `SwipeUndoBar`.
 *
 * A swipe runs the menu's action of the same name, so archive asks first when
 * Settings says to. The two that file a thread away without asking, Wrap up
 * and an unconfirmed Archive, are the ones a swipe can do by accident (a left
 * swipe elsewhere on the phone's sidebar closes it), so they offer Undo.
 */
export function useThreadRowSwipes() {
  const { run } = useThreadMenu();
  const confirmArchive = useSettings<boolean>((settings) => settings.confirmThreadArchive);
  const { archiveThread, unarchiveThread } = useThreadActions();
  const [swipeUndo, setSwipeUndo] = useState<SwipeUndo | null>(null);
  // Numbers the swipes that can be undone, as they happen: an archive that
  // answers late must not take the bar from a newer swipe.
  const undoSeqRef = useRef(0);

  const dismissSwipeUndo = useCallback((id: number) => {
    setSwipeUndo((current) => (current?.id === id ? null : current));
  }, []);

  const handleRowSwipe = useCallback<ThreadRowSwipeHandler>(
    (action, threadKey, title) => {
      const threadRef = parseScopedThreadKey(threadKey);
      if (!threadRef) return;
      const nextUndo = () => {
        undoSeqRef.current += 1;
        const id = undoSeqRef.current;
        return (verb: SwipeUndo["verb"], undo: SwipeUndo["undo"]) => {
          if (undoSeqRef.current === id) setSwipeUndo({ id, verb, title, undo });
        };
      };
      if (action === "archive" && !confirmArchive) {
        const offerUndo = nextUndo();
        void archiveThread(threadRef).then(
          () => offerUndo("Archived", () => unarchiveThread(threadRef)),
          (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          },
        );
        return;
      }
      void run(action, { threadRef });
      if (action === "wrap-up") {
        nextUndo()("Wrapped up", async () => reopenThreadByKey(threadKey));
      }
    },
    [archiveThread, confirmArchive, run, unarchiveThread],
  );

  return { handleRowSwipe, swipeUndo, dismissSwipeUndo };
}
