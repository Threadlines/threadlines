import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useRowSwipe, type RowSwipeHandler } from "../../hooks/useRowSwipe";
import { cn } from "../../lib/utils";

/** What one side of a row does when it is swiped open. */
export interface RowSwipeAction extends RowSwipeHandler {
  readonly label: string;
  readonly icon: LucideIcon;
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
      className={cn("relative", enabled && "touch-pan-y", view.side !== null && "overflow-hidden")}
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
