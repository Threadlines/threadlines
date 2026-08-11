/**
 * The sidebar with nothing open in it. Tiles rather than a list because each one
 * is a single click that opens a surface, and a tile can carry the one line of
 * copy that says what the surface is for.
 */
import { memo } from "react";

import { RIGHT_PANEL_SURFACES, type RightPanelTab } from "../../rightPanelTabs";
import { SectionLabel } from "../ui/threadline";
import { RIGHT_PANEL_TAB_ICONS } from "./RightPanelTabStrip";

export const RightPanelLauncher = memo(function RightPanelLauncher({
  availableTabs,
  openTabs,
  onOpenTab,
}: {
  availableTabs: ReadonlyArray<RightPanelTab>;
  /** Surfaces already in the strip, marked so the tile reads as a focus. */
  openTabs: ReadonlyArray<RightPanelTab>;
  onOpenTab: (tab: RightPanelTab) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-right-panel-launcher="true">
      <SectionLabel className="mb-2.5">Open a panel</SectionLabel>
      {availableTabs.length === 0 ? (
        <p className="text-[12px] text-muted-foreground/60">
          Nothing to show for this thread yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {availableTabs.map((tab) => {
            const surface = RIGHT_PANEL_SURFACES[tab];
            const TileIcon = RIGHT_PANEL_TAB_ICONS[tab];
            return (
              <button
                key={tab}
                type="button"
                data-right-panel-launcher-tile={tab}
                data-right-panel-launcher-tile-open={openTabs.includes(tab) ? "true" : undefined}
                className="flex flex-col items-start gap-1 rounded-md border border-border bg-transparent px-2.5 py-2.5 text-left transition-colors hover:bg-accent/50 focus-ring"
                onClick={() => onOpenTab(tab)}
              >
                <TileIcon className="size-3.5 text-muted-foreground/70" aria-hidden="true" />
                <span className="text-[13px] leading-4 font-medium text-foreground">
                  {surface.label}
                </span>
                <span className="text-[11px] leading-4 text-muted-foreground/70">
                  {surface.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
