/**
 * The sidebar with nothing open in it: the thread's surfaces as a short list of
 * rows, in the left sidebar's own language. Rows rather than tiles because this
 * is navigation, and the left sidebar navigates by rows -- hairline dividers,
 * content on the panel's gutter, a hover fill and nothing else.
 */
import { memo } from "react";

import { cn } from "../../lib/utils";
import { RIGHT_PANEL_SURFACES, type RightPanelTab } from "../../rightPanelTabs";
import { SectionLabel } from "../ui/threadline";
import type { RightPanelLauncherStates, RightPanelSurfaceState } from "./rightPanelLauncherState";
import { RIGHT_PANEL_TAB_ICONS } from "./RightPanelTabStrip";

export const RightPanelLauncher = memo(function RightPanelLauncher({
  availableTabs,
  openTabs,
  surfaceStates,
  onOpenTab,
}: {
  availableTabs: ReadonlyArray<RightPanelTab>;
  /** Surfaces already in the strip, marked so the row reads as a focus. */
  openTabs: ReadonlyArray<RightPanelTab>;
  /** What each surface actually holds. Absent surfaces keep their static copy,
   *  which is what an unknown state reads as. */
  surfaceStates?: RightPanelLauncherStates | undefined;
  onOpenTab: (tab: RightPanelTab) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2" data-right-panel-launcher="true">
      <SectionLabel className="px-3 py-1.5" tick={false}>
        Open a panel
      </SectionLabel>
      {availableTabs.length === 0 ? (
        <p className="px-3 py-1.5 text-[12px] text-muted-foreground/60">
          Nothing to show for this thread yet.
        </p>
      ) : (
        <div className="divide-y divide-border/40 border-y border-border/40">
          {availableTabs.map((tab) => {
            const surface = RIGHT_PANEL_SURFACES[tab];
            const RowIcon = RIGHT_PANEL_TAB_ICONS[tab];
            // An empty surface reads quieter, and stays every bit as clickable:
            // opening it lands on its own empty state, which says more than a
            // launcher row can.
            const state: RightPanelSurfaceState = surfaceStates?.[tab] ?? {
              description: surface.description,
              empty: false,
            };
            return (
              <button
                key={tab}
                type="button"
                data-right-panel-launcher-row={tab}
                data-right-panel-launcher-row-open={openTabs.includes(tab) ? "true" : undefined}
                data-right-panel-launcher-row-empty={state.empty ? "true" : undefined}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.04] focus-ring"
                onClick={() => onOpenTab(tab)}
              >
                <RowIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    state.empty ? "text-muted-foreground/45" : "text-muted-foreground/70",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px] leading-4 font-medium",
                      state.empty ? "text-muted-foreground/70" : "text-foreground/90",
                    )}
                  >
                    {surface.label}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-[11px] leading-4",
                      state.empty ? "text-muted-foreground/45" : "text-muted-foreground/60",
                    )}
                  >
                    {state.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
