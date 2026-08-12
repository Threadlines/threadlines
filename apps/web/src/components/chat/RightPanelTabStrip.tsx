/**
 * The right sidebar's tab strip, in the internal browser's visual language: a
 * short row of rounded-top tabs, the active one lifted onto the background, a
 * close ✕ that appears on hover, and a `+` sitting after the last tab.
 *
 * The `+` opens a menu of the thread's surfaces rather than a new blank tab,
 * because there is a fixed set of them and each can only be open once. A
 * surface already in the strip stays listed and dimmed: choosing it focuses the
 * tab it already has.
 */
import { BotIcon, FileDiffIcon, PlusIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type { Icon } from "../Icons";
import { SourceControlIcon } from "../Icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MINI_HORIZONTAL_SCROLLBAR_CLASS, ScrollArea } from "../ui/scroll-area";
import { LiveNode } from "../ui/threadline";
import {
  RIGHT_PANEL_SURFACES,
  type RightPanelTab,
  type RightPanelSurface,
} from "../../rightPanelTabs";

export const RIGHT_PANEL_TAB_ICONS: Readonly<Record<RightPanelTab, Icon>> = {
  sourceControl: SourceControlIcon,
  diff: FileDiffIcon,
  agents: BotIcon,
};

function TabStripItem({
  surface,
  active,
  live,
  onSelect,
  onClose,
}: {
  surface: RightPanelSurface;
  active: boolean;
  /** Draws the tab's live node in place of its icon, e.g. agents still running. */
  live: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const TabIcon = RIGHT_PANEL_TAB_ICONS[surface.id];
  return (
    <div
      role="presentation"
      className={cn(
        // Exactly as wide as its own contents: icon, whole label, ✕. Not flex-1,
        // which made the strip's look depend on how many tabs happened to be
        // open, and not shrinkable either -- a surface named "Cha…" is worse
        // than a narrow one, so a label is never abbreviated. When the set
        // outgrows the strip the row scrolls, exactly as the browser panel's
        // does; nothing shrinks and nothing is truncated.
        "group/rail-tab flex shrink-0 items-center gap-1 rounded-t-md px-1.5 text-xs",
        active
          ? "bg-background text-foreground"
          : "text-muted-foreground/80 hover:bg-accent hover:text-foreground",
      )}
      data-right-panel-tab={surface.id}
      data-active={active ? "true" : undefined}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="flex shrink-0 items-center gap-1.5 py-1 focus-ring"
        title={surface.label}
        onClick={onSelect}
      >
        {live ? (
          <LiveNode className="size-1.5 shrink-0" />
        ) : (
          <TabIcon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
        )}
        <span className="whitespace-nowrap">{surface.label}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${surface.label}`}
        data-right-panel-close-tab={surface.id}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/rail-tab:opacity-100 focus-visible:opacity-100 focus-ring"
        onClick={onClose}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

export const RightPanelTabStrip = memo(function RightPanelTabStrip({
  openTabs,
  availableTabs,
  activeTab,
  liveTabs,
  onSelectTab,
  onCloseTab,
  trailing,
}: {
  openTabs: ReadonlyArray<RightPanelTab>;
  availableTabs: ReadonlyArray<RightPanelTab>;
  activeTab: RightPanelTab | null;
  /** Tabs whose content is currently live, drawn with a live node. */
  liveTabs?: ReadonlyArray<RightPanelTab>;
  onSelectTab: (tab: RightPanelTab) => void;
  onCloseTab: (tab: RightPanelTab) => void;
  /** Sheet-mode dismissal, parked at the end of the row. */
  trailing?: React.ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Selecting or opening a tab brings it into view, by the smallest scroll that
  // does it: a tab already on screen must not move the strip under the pointer.
  useEffect(() => {
    const strip = stripRef.current;
    if (activeTab === null || strip === null) {
      return;
    }
    const viewport = strip.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const tab = strip.querySelector<HTMLElement>(`[data-right-panel-tab="${activeTab}"]`);
    if (viewport === null || tab === null) {
      return;
    }
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < viewport.scrollLeft) {
      viewport.scrollLeft = start;
    } else if (end > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = end - viewport.clientWidth;
    }
  }, [activeTab, openTabs]);

  return (
    <div
      ref={stripRef}
      className="drag-region shrink-0 border-b border-border"
      data-right-panel-strip="true"
    >
      {/* One row, shared with the window controls Windows overlays on the top of
          the panel: the strip takes titlebar height and pads itself clear of the
          min/max/close cluster. Content-sized tabs are what make that share
          workable -- stretched ones had to divide whatever the padding left.

          The clearance is the cluster's own width plus 4px, where the app's other
          titlebar rows add 1em. They end in text or labelled controls that would
          read as crowded against the buttons; this row ends in the `+`, whose own
          padding is the breathing room, so the extra 12px only pushed it away
          from the controls it sits beside. */}
      <div
        className="flex h-9 items-stretch px-1.5 pt-1.5 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.25rem)]"
        data-right-panel-tabs-row="true"
      >
        {/* Tabs scroll rather than shrink, as the browser panel's do. Whatever
            the panel's width -- the 272px floor, or the Windows overlay's row
            shared with the controls cluster -- every tab is drawn whole and the
            hidden ones are reachable by scrolling, marked by the same hairline
            overlay bar and edge fades the browser strip uses. Neither costs the
            row any height.

            The scroller is sized by its tabs and shrinks only when it has to.
            That one rule covers both cases with no branch in it: while the tabs
            fit, the `+` is parked directly after the last one; once they do not,
            the scroller gives up exactly the pixels the `+` needs and lands it at
            the far right of whatever the strip has left. */}
        <div className="flex min-w-0 shrink items-stretch">
          <ScrollArea
            // Right edge only: that is where the tabs run under the `+` and the
            // window controls, so the fade reads as tabs passing beneath them.
            // The left edge is just the panel's own side, and fading there only
            // made the first tab look half-drawn.
            scrollFade="x-end"
            observeContentResize
            horizontalWheelScroll
            contentClassName="h-full"
            className={cn("min-w-0 flex-1 self-stretch", MINI_HORIZONTAL_SCROLLBAR_CLASS)}
          >
            <div
              role="tablist"
              aria-label="Thread panel"
              className="flex h-full items-stretch gap-px"
              data-right-panel-tablist="true"
            >
              {openTabs.map((tab) => (
                <TabStripItem
                  key={tab}
                  surface={RIGHT_PANEL_SURFACES[tab]}
                  active={tab === activeTab}
                  live={liveTabs?.includes(tab) ?? false}
                  onSelect={() => onSelectTab(tab)}
                  onClose={() => onCloseTab(tab)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
        {/* Anchored beside the scroller, never in it: the one control that adds a
            tab has to stay reachable no matter how far the tabs have scrolled. */}
        {availableTabs.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Open panel"
                  data-right-panel-add-tab="true"
                  className="ms-0.5 inline-flex size-6 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-ring"
                />
              }
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              {availableTabs.map((tab) => {
                const surface = RIGHT_PANEL_SURFACES[tab];
                const alreadyOpen = openTabs.includes(tab);
                const MenuIcon = RIGHT_PANEL_TAB_ICONS[tab];
                return (
                  <MenuItem
                    key={tab}
                    data-right-panel-menu-tab={tab}
                    data-right-panel-menu-tab-open={alreadyOpen ? "true" : undefined}
                    className={cn(alreadyOpen && "text-muted-foreground/60")}
                    onClick={() => onSelectTab(tab)}
                  >
                    <MenuIcon aria-hidden="true" className="text-muted-foreground" />
                    {surface.label}
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
        ) : null}
        {/* Dismissal belongs to the panel, not to the tabs, so it keeps the far
            edge and stays put while the tabs scroll past it. */}
        {trailing ? (
          <div className="flex shrink-0 items-center self-center ps-1">{trailing}</div>
        ) : null}
      </div>
    </div>
  );
});
