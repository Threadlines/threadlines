import { UsersRoundIcon } from "lucide-react";

import { cn } from "../../lib/utils";

/**
 * The Rooms row under Pull Requests: a filter, not a page. Pressed, the inbox
 * lists only threads with more than one agent; pressed again, or on a scope
 * change, it lists everything. Rooms are threads, so a page of its own would
 * repeat the inbox.
 */
export function SidebarRoomsRow({
  active,
  roomCount,
  onToggle,
}: {
  readonly active: boolean;
  readonly roomCount: number;
  readonly onToggle: () => void;
}) {
  return (
    <div className="px-2 pb-1">
      <button
        type="button"
        data-testid="sidebar-rooms"
        aria-pressed={active}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-xs transition-colors select-none focus-ring",
          active
            ? "bg-sidebar-accent text-foreground"
            : "text-foreground/85 hover:bg-sidebar-accent/60 hover:text-foreground",
        )}
        onClick={onToggle}
      >
        <UsersRoundIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Rooms</span>
        {roomCount > 0 ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {roomCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
