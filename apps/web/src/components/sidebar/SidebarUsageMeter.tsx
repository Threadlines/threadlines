import { formatTokensCompact } from "@threadlines/shared/usageFormat";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useCallback } from "react";

import { usageTodayQueryOptions, useUsageEnvironmentTargets } from "../../lib/usageReactQuery";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";

/**
 * Today's token total in the sidebar footer.
 *
 * Self-contained on purpose: the query lives here rather than in the sidebar so
 * a usage refetch re-renders one line of chrome instead of the whole inbox.
 * Without an answer it stays the plain label, because a wrong number in the
 * footer is worse than no number.
 */
export function SidebarUsageMeter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const targets = useUsageEnvironmentTargets();
  const usageQuery = useQuery(usageTodayQueryOptions({ targets }));
  const totalTokens = usageQuery.data?.merged.totalTokens ?? null;

  const openUsage = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenuButton
      size="sm"
      className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      data-testid="sidebar-usage-meter"
      onClick={openUsage}
    >
      <GaugeIcon className="size-3.5" />
      {totalTokens === null ? (
        <span className="text-xs">Usage</span>
      ) : (
        <span className="font-mono text-xs tabular-nums">
          {formatTokensCompact(totalTokens)} today
        </span>
      )}
    </SidebarMenuButton>
  );
}
