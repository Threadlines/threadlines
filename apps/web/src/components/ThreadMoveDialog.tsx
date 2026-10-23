/**
 * "Move to another computer" (docs/design/fleet.md, Part 3): one dialog for
 * every entry point (the sidebar's thread menu, the command palette, the chat
 * header). Each asks through openThreadMoveDialog; the host mounted once at
 * the root shows it. The dialog asks the thread's computer where the thread
 * could go and what would go with it, then starts the move there.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";
import { Suspense } from "react";
import { create } from "zustand";

import { lazyWithPreload } from "../lib/lazyWithPreload";
import { Dialog } from "./ui/dialog";

const ThreadMoveDialogContent = lazyWithPreload(() =>
  import("./ThreadMoveDialogContent").then((module) => module.ThreadMoveDialogContent),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadThreadMoveDialog = ThreadMoveDialogContent.preload;

interface ThreadMoveDialogRequest {
  /** Each ask starts fresh, even for the same thread twice. */
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
}

const useThreadMoveDialogStore = create<{ request: ThreadMoveDialogRequest | null }>(() => ({
  request: null,
}));

/** Opens the move dialog for a thread; a second ask replaces the first. */
export function openThreadMoveDialog(threadRef: ScopedThreadRef): void {
  const previous = useThreadMoveDialogStore.getState().request;
  useThreadMoveDialogStore.setState({ request: { id: (previous?.id ?? 0) + 1, threadRef } });
}

export function closeThreadMoveDialog(): void {
  useThreadMoveDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openThreadMoveDialog asks. */
export function ThreadMoveDialogHost() {
  const request = useThreadMoveDialogStore((state) => state.request);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadMoveDialog();
      }}
    >
      {request ? (
        <Suspense fallback={null}>
          <ThreadMoveDialogContent.Component key={request.id} threadRef={request.threadRef} />
        </Suspense>
      ) : null}
    </Dialog>
  );
}
