import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";

/** How long the bar offers to take a swipe back. */
const SWIPE_UNDO_VISIBLE_MS = 6000;

/** A swipe that filed a thread away, and how to put it back. */
export interface SwipeUndo {
  /** Which swipe this is; only the newest one that can be undone owns the bar. */
  readonly id: number;
  readonly verb: "Wrapped up" | "Archived";
  readonly title: string;
  /** Puts the thread back; rejects when that fails, and the bar says so. */
  readonly undo: () => Promise<void>;
}

/**
 * The way back from a swipe that filed a thread away (Wrap up, Archive): a
 * small bar floating at the bottom of the thread list for a few seconds.
 *
 * It lives in the list rather than in a toast because on a phone the list is
 * a drawer over the page, and toasts sit under every panel on purpose; an
 * undo there would be out of reach exactly while it is wanted. For the same
 * reason a failed undo is reported here, with another try, not in a toast.
 *
 * Key it by the undo's id, so each swipe starts with a fresh bar.
 */
export function SwipeUndoBar(props: {
  readonly undo: SwipeUndo;
  /** Called with the undo's id, so a late answer can't dismiss a newer bar. */
  readonly onDismiss: (id: number) => void;
  /**
   * On a full page that runs to the bottom of a phone's screen: keep above the
   * home indicator's strip. A list inside the sidebar is already clear of it.
   */
  readonly clearsSafeArea?: boolean;
}) {
  const { undo, onDismiss } = props;
  const [phase, setPhase] = useState<"offered" | "undoing" | "failed">("offered");

  // It waits while an undo is out, and a failure gets its own full time.
  useEffect(() => {
    if (phase === "undoing") return;
    const timer = setTimeout(() => onDismiss(undo.id), SWIPE_UNDO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [onDismiss, phase, undo.id]);

  const runUndo = () => {
    setPhase("undoing");
    undo.undo().then(
      () => onDismiss(undo.id),
      () => setPhase("failed"),
    );
  };

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-2 z-30 flex",
        props.clearsSafeArea === true
          ? "bottom-[calc(--spacing(2)+env(safe-area-inset-bottom))]"
          : "bottom-2",
      )}
    >
      <div
        role="status"
        data-testid="swipe-undo-bar"
        className="pointer-events-auto flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/75 bg-popover py-1.5 ps-3 pe-1.5 text-xs text-popover-foreground elevate-popover"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">
            {phase === "failed" ? "Couldn't put back" : undo.verb}
          </span>{" "}
          <span className="text-muted-foreground">{undo.title}</span>
        </span>
        <button
          type="button"
          disabled={phase === "undoing"}
          aria-busy={phase === "undoing" ? true : undefined}
          className="shrink-0 cursor-pointer rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-foreground/10 focus-ring disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent pointer-coarse:px-3 pointer-coarse:py-2"
          onClick={runUndo}
        >
          {phase === "failed" ? "Try again" : "Undo"}
        </button>
      </div>
    </div>
  );
}
