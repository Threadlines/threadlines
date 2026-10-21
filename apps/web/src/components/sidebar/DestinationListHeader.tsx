import type { ReactNode } from "react";

/**
 * The top of a page's own list beside the rail (General chats, Computers):
 * its name and, at the end, the one action it offers. The thread list's
 * search row takes this place on Threads, at the same height.
 */
export function DestinationListHeader({
  title,
  action,
}: {
  readonly title: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 ps-4 pe-2 pt-1">
      <h2 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold text-foreground">
        {title}
      </h2>
      {action}
    </div>
  );
}
