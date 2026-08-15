/**
 * The composer notice for a thread whose folder was deleted.
 *
 * This replaces the generic "Turn failed … Retry" row, which was a dead end
 * here: the turn failed because the directory the session runs in is gone, so
 * retrying reproduces it exactly. The two things that actually resolve it are
 * offered instead — move the thread to the project root, or put the folder back.
 *
 * Warning severity, not error: the thread is recoverable in one click, and the
 * notice dock reads severity as urgency.
 *
 * @module checkoutMissingNotice
 */
import { FolderXIcon, RotateCcwIcon } from "lucide-react";

import type { CheckoutRecoveryState } from "../../lib/checkoutRecovery";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";

export interface CheckoutRecoveryActions {
  readonly onSwitchToProjectRoot: () => void;
  readonly onRecreateWorktree: () => void;
  /** A recovery action is running; both buttons wait it out. */
  readonly isBusy: boolean;
}

export function buildCheckoutMissingNotice({
  recovery,
  actions,
}: {
  recovery: CheckoutRecoveryState;
  actions: CheckoutRecoveryActions;
}): ComposerNotice {
  return {
    id: "checkout-missing",
    severity: "warning",
    lead: "This thread's folder no longer exists.",
    detail: <span className="font-mono text-muted-foreground">{recovery.cwd}</span>,
    actions: (
      <>
        {recovery.canSwitchToProjectRoot ? (
          <Button
            size="xs"
            disabled={actions.isBusy}
            onClick={actions.onSwitchToProjectRoot}
            aria-label="Switch this thread to the local checkout"
          >
            <FolderXIcon className="size-3" />
            Switch to local checkout
          </Button>
        ) : null}
        {recovery.canRecreateWorktree ? (
          <Button
            size="xs"
            variant="ghost"
            className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
            disabled={actions.isBusy}
            onClick={actions.onRecreateWorktree}
            aria-label="Recreate this thread's worktree"
          >
            <RotateCcwIcon className="size-3" />
            Recreate worktree
          </Button>
        ) : null}
      </>
    ),
  };
}
