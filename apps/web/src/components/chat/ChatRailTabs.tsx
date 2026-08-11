/**
 * The right rail's tab row. Two text tabs separated by nothing but spacing:
 * the rail's own hairline header border is the only rule under them, and the
 * active tab is simply the one drawn in foreground ink.
 *
 * It renders inside each panel's existing header row, which already carries
 * the drag region and the window-controls-overlay paddings, so the rail keeps
 * one header row on desktop instead of stacking a tab strip on top of one.
 */
import { memo } from "react";

import { cn } from "~/lib/utils";
import { LiveNode } from "../ui/threadline";
import type { RightPanelTab } from "../../rightPanelLayout";

export interface ChatRailTabDescriptor {
  readonly id: RightPanelTab;
  readonly label: string;
  /** Draws the tab's live node, e.g. the turn still has agents running. */
  readonly live?: boolean;
}

export const ChatRailTabs = memo(function ChatRailTabs({
  tabs,
  activeTab,
  onSelectTab,
}: {
  tabs: ReadonlyArray<ChatRailTabDescriptor>;
  activeTab: RightPanelTab;
  onSelectTab: (tab: RightPanelTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Thread panel"
      className="flex min-w-0 items-center gap-4"
      data-chat-rail-tabs="true"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-chat-rail-tab={tab.id}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase transition-colors focus-ring",
              active ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground/80",
            )}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.live ? <LiveNode className="size-1.5" /> : null}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
});
