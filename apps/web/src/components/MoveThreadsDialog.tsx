/**
 * "Move threads" (docs/design/fleet.md, Part 3c): several of a computer's
 * open threads to one linked computer at once, for the moment that computer
 * is about to shut down. Opened from Fleet (a computer's page: "Move threads
 * here…"; this computer's page: "Move threads to another computer…") and
 * from the command palette. The host is mounted once at the root; each entry
 * asks through openMoveThreadsDialog. Offered only where the computer the
 * threads leave moves several at once (useMoveThreadsOffered).
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { Suspense } from "react";
import { create } from "zustand";

import { lazyWithPreload } from "../lib/lazyWithPreload";
import { Dialog } from "./ui/dialog";

const MoveThreadsDialogContent = lazyWithPreload(() =>
  import("./MoveThreadsDialogContent").then((module) => module.MoveThreadsDialogContent),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadMoveThreadsDialog = MoveThreadsDialogContent.preload;

export interface MoveThreadsDialogRequest {
  /** Each ask starts fresh. */
  readonly id: number;
  /** The computer the threads leave. */
  readonly sourceEnvironmentId: EnvironmentId;
  /** The computer picked to start with (its page's); null picks the first that can take them. */
  readonly targetEnvironmentId: EnvironmentId | null;
}

const useMoveThreadsDialogStore = create<{ request: MoveThreadsDialogRequest | null }>(() => ({
  request: null,
}));

/** Opens the Move threads dialog; a second ask replaces the first. */
export function openMoveThreadsDialog(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId?: EnvironmentId | null;
}): void {
  const previous = useMoveThreadsDialogStore.getState().request;
  useMoveThreadsDialogStore.setState({
    request: {
      id: (previous?.id ?? 0) + 1,
      sourceEnvironmentId: input.sourceEnvironmentId,
      targetEnvironmentId: input.targetEnvironmentId ?? null,
    },
  });
}

export function closeMoveThreadsDialog(): void {
  useMoveThreadsDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openMoveThreadsDialog asks. */
export function MoveThreadsDialogHost() {
  const request = useMoveThreadsDialogStore((state) => state.request);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeMoveThreadsDialog();
      }}
    >
      {request ? (
        <Suspense fallback={null}>
          <MoveThreadsDialogContent.Component key={request.id} request={request} />
        </Suspense>
      ) : null}
    </Dialog>
  );
}
