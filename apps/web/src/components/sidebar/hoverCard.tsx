import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusIndicators";
import { TooltipProvider } from "../ui/tooltip";

/**
 * Shared shell for the sidebar's hover cards, so a thread card and a project
 * card read as the same object with different contents.
 */
export const HOVER_CARD_POPUP_CLASS_NAME =
  "w-64 rounded-lg p-2.5 text-left text-popover-foreground text-sm shadow-none elevate-popover";

export function HoverCardTitle({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 line-clamp-2 text-xs font-medium leading-tight text-foreground">
      {children}
    </p>
  );
}

/** Status on the left, when it last moved on the right, ruled off from the details. */
export function HoverCardStatusLine({
  status,
  idleLabel = "Idle",
  timestamp,
}: {
  status: ThreadStatusPill | null;
  idleLabel?: string;
  timestamp: string | null;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 border-b border-border/60 pb-1.5 text-xs leading-tight">
      <ThreadStatusDot status={status} />
      <span className="min-w-0 flex-1 truncate text-foreground/80">
        {status ? status.label : idleLabel}
      </span>
      {timestamp ? (
        <span className="shrink-0 tabular-nums text-muted-foreground/60">{timestamp}</span>
      ) : null}
    </div>
  );
}

export function HoverCardDetailRow({
  icon,
  children,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs leading-tight text-muted-foreground">
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
        {icon}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", className)}>{children}</span>
    </div>
  );
}

export function HoverCardDetails({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}

/**
 * Groups hover cards so a list behaves like one surface.
 *
 * The delay is there to stop a card firing while the pointer is only crossing
 * the list on its way elsewhere. Once one card is open that intent is no longer
 * in doubt, so neighbouring rows swap instantly, and `timeout` keeps the group
 * warm briefly after the last one closes.
 */
export function SidebarHoverCardGroup({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={280} closeDelay={120} timeout={600}>
      {children}
    </TooltipProvider>
  );
}
