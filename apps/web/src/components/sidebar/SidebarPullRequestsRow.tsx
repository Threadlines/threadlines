import { useLocation, useNavigate } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import { useCallback } from "react";

import type { PullRequestListSnapshot } from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import { countNeedsYou } from "../pull-requests/pullRequests.logic";
import { useSidebar } from "../ui/sidebar";

/**
 * The Pull Requests destination, directly under General Chats.
 *
 * The listing itself is read by the sidebar, because the thread rows below
 * need the same answer for their badges; this row only counts it. The row is
 * absent entirely when no connected environment can answer, because a
 * destination that only ever shows "unsupported" is not worth a permanent seat.
 *
 * The count is what needs the user, not the number of open pull requests: a
 * total nobody has to act on is noise in the corner of the eye.
 */
export function SidebarPullRequestsRow({
  snapshot,
}: {
  readonly snapshot: PullRequestListSnapshot;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const isActive = pathname.startsWith("/pull-requests");
  const needsYouCount = countNeedsYou(snapshot.entries);

  const openPullRequests = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/pull-requests", search: { state: "open" } });
  }, [isMobile, navigate, setOpenMobile]);

  if (snapshot.environments.length === 0) {
    return null;
  }

  return (
    <div className="px-2 pt-0.5 pb-1">
      <button
        type="button"
        data-testid="sidebar-pull-requests"
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-xs transition-colors select-none focus-ring",
          isActive
            ? "bg-sidebar-accent text-foreground"
            : "text-foreground/85 hover:bg-sidebar-accent/60 hover:text-foreground",
        )}
        onClick={openPullRequests}
      >
        <GitPullRequestIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Pull Requests</span>
        {needsYouCount > 0 ? (
          <span
            // Inset from the row's edge like the timestamps on the rows below,
            // rather than sitting on the row's own thin padding.
            className="mr-1 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60"
            data-testid="sidebar-pull-requests-count"
          >
            {needsYouCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
