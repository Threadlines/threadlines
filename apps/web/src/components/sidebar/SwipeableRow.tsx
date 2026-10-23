import {
  ArchiveIcon,
  CheckIcon,
  PinIcon,
  PinOffIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useRowSwipe, type RowSwipeHandler } from "../../hooks/useRowSwipe";
import type { ThreadRowSwipeAction, ThreadRowSwipeHandler } from "../../hooks/useThreadRowSwipes";
import { cn } from "../../lib/utils";

/** What one side of a row does when it is swiped open. */
export interface RowSwipeAction extends RowSwipeHandler {
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * One side of a thread row's swipe: the menu action it runs, named and drawn
 * the way the menu and the row's buttons name it. Null without a handler, so a
 * list that doesn't run swipes gets rows that don't swipe.
 */
export function threadRowSwipeAction(
  onSwipe: ThreadRowSwipeHandler | undefined,
  thread: { readonly threadKey: string; readonly title: string },
  action: ThreadRowSwipeAction,
): RowSwipeAction | null {
  if (!onSwipe) return null;
  const run = () => onSwipe(action, thread.threadKey, thread.title);
  switch (action) {
    case "pin":
      return { label: "Pin", icon: PinIcon, leaves: false, run };
    case "unpin":
      return { label: "Unpin", icon: PinOffIcon, leaves: false, run };
    case "wrap-up":
      return { label: "Wrap up", icon: CheckIcon, leaves: true, run };
    case "reopen":
      return { label: "Reopen", icon: Undo2Icon, leaves: true, run };
    case "archive":
      return { label: "Archive", icon: ArchiveIcon, leaves: true, run };
  }
}

/**
 * A list row a finger can swipe sideways to run an action: right for the
 * leading one, left for the trailing one. The action shows under the row as it
 * moves, in the row's quiet fill until letting go would run it, then in full
 * strength. Every swipe action is also on the row's buttons and its
 * press-and-hold menu; the swipe is the quick way, never the only one.
 *
 * Inside the phone's sidebar drawer the row keeps its swipes
 * (`data-base-ui-swipe-ignore`): a sideways swipe anywhere else on the panel
 * closes it.
 */
export function SwipeableRow(props: {
  readonly leading: RowSwipeAction | null;
  readonly trailing: RowSwipeAction | null;
  /** While the row is being renamed, its input owns the touch. */
  readonly disabled?: boolean;
  /** For a row with its own shape (rounded corners), so the action under it matches. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { leading, trailing, children } = props;
  const { enabled, view, containerRef, layerRef, handlers } = useRowSwipe({
    leading,
    trailing,
    disabled: props.disabled === true,
  });
  const shown = view.side === "leading" ? leading : view.side === "trailing" ? trailing : null;
  const ShownIcon = shown?.icon;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        enabled && "touch-pan-y",
        view.side !== null && "overflow-hidden",
        props.className,
      )}
      data-base-ui-swipe-ignore={enabled ? "" : undefined}
      {...handlers}
    >
      {shown && ShownIcon ? (
        <div
          aria-hidden="true"
          data-testid="row-swipe-action"
          data-armed={view.armed ? "true" : undefined}
          className={cn(
            "absolute inset-0 flex items-center gap-1.5 px-4 text-xs font-medium transition-colors duration-100",
            view.side === "leading" ? "justify-start" : "justify-end",
            view.armed
              ? "bg-foreground/14 text-foreground"
              : "bg-sidebar-accent text-muted-foreground",
          )}
        >
          <ShownIcon className="size-3.5 shrink-0" />
          <span>{shown.label}</span>
        </div>
      ) : null}
      {/* Opaque while it moves, so the action shows only where the row has
          slid off it. */}
      <div ref={layerRef} className={cn(view.side !== null && "bg-sidebar")}>
        {children}
      </div>
    </div>
  );
}
