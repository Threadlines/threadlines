/**
 * "What's new": the release notes for the version you have, over the app.
 * Every entry point asks through openWhatsNewDialog: the notice after an
 * update, Settings › General › Version, the command palette, and the desktop
 * Help menu. The host mounted once at the root shows it; its body is a chunk
 * of its own, and so are the notes it reads.
 */
import { Suspense } from "react";
import { create } from "zustand";

import { lazyWithPreload } from "../lib/lazyWithPreload";
import { Dialog } from "./ui/dialog";

const WhatsNewDialogContent = lazyWithPreload(() =>
  import("./WhatsNewDialogContent").then((module) => module.WhatsNewDialogContent),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadWhatsNewDialog = WhatsNewDialogContent.preload;

const useWhatsNewDialogStore = create<{ openCount: number; open: boolean }>(() => ({
  openCount: 0,
  open: false,
}));

/** Opens "What's new"; each open starts on the version you have. */
export function openWhatsNewDialog(): void {
  const { openCount } = useWhatsNewDialogStore.getState();
  useWhatsNewDialogStore.setState({ openCount: openCount + 1, open: true });
}

export function closeWhatsNewDialog(): void {
  useWhatsNewDialogStore.setState({ open: false });
}

/** Mounted once at the root; shows "What's new" while it's open. */
export function WhatsNewDialogHost() {
  const open = useWhatsNewDialogStore((state) => state.open);
  const openCount = useWhatsNewDialogStore((state) => state.openCount);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeWhatsNewDialog();
      }}
    >
      {open ? (
        <Suspense fallback={null}>
          <WhatsNewDialogContent.Component key={openCount} />
        </Suspense>
      ) : null}
    </Dialog>
  );
}

/**
 * Once per version on each device, the first launch of a newer stable
 * release says so (whatsNewNotice.ts, a chunk of its own so startup never
 * carries it).
 */
export function announceUpdateOnce(): Promise<void> {
  return import("./whatsNewNotice").then((module) => module.announceUpdateOnce());
}
