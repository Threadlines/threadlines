/**
 * The right sidebar's tab strip, in the internal browser's visual language: a
 * short row of rounded-top tabs, the active one lifted onto the background, a
 * close ✕ that appears on hover, and a `+` sitting after the last tab.
 *
 * The `+` opens a menu of the thread's surfaces rather than a new blank tab,
 * because there is a fixed set of them and each can only be open once. A
 * surface already in the strip stays listed and dimmed: choosing it focuses the
 * tab it already has. Empty surfaces stay clickable too, but use the same quiet
 * treatment as their rows in the panel launcher.
 *
 * The row shares its width with the Windows window-controls overlay, which
 * reserves ~150px of it, so the strip measures itself and drops every label
 * rather than scrolling the moment two tabs stop fitting -- losing sight of the
 * tab you were just on is worse than losing its name, which a tooltip gives
 * back. Scrolling is still there underneath, for when even the icons overflow.
 */
import { BotIcon, FileDiffIcon, PlusIcon, XIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { Icon } from "../Icons";
import { SourceControlIcon } from "../Icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MINI_HORIZONTAL_SCROLLBAR_CLASS, ScrollArea } from "../ui/scroll-area";
import { LiveNode } from "../ui/threadline";
import { TooltipWrapper } from "../ui/tooltip";
import type { RightPanelLauncherStates } from "./rightPanelLauncherState";
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

/** Labelled while they fit, all icons once they do not. Never a mix: dropping
 *  only some labels makes the strip's tabs read as different kinds of thing. */
export type RightPanelTabStripMode = "labels" | "icons";

/**
 * Slack the labelled row must have spare before the strip puts labels back.
 * Collapsing happens the moment they stop fitting, but re-expanding waits for
 * headroom, so dragging the panel across the boundary settles instead of
 * flickering between the two modes on every observed pixel.
 */
const TAB_LABEL_HYSTERESIS_PX = 12;

/**
 * The label's tail fades out from under the ✕ while the ✕ is showing. The ✕ has
 * no width of its own -- reserving one is the whole thing this strip is trying
 * to avoid -- so the label is what gives way, which is also what Chrome and Edge
 * do. Spelled out twice rather than composed at runtime: Tailwind only ships
 * classes it can see written down.
 */
const LABEL_FADE_UNDER_CLOSE =
  "group-hover/rail-tab:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent_calc(100%-0.75rem))] " +
  "group-has-[:focus-visible]/rail-tab:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent_calc(100%-0.75rem))]";

/** Hover on the tab, or keyboard focus anywhere in it -- including the ✕ itself,
 *  which has to stay visible while it is the focused element. */
const REVEAL_ON_TAB_HOVER_OR_FOCUS =
  "group-hover/rail-tab:opacity-100 group-has-[:focus-visible]/rail-tab:opacity-100";
const HIDE_ON_TAB_HOVER_OR_FOCUS =
  "group-hover/rail-tab:opacity-0 group-has-[:focus-visible]/rail-tab:opacity-0";

function TabStripItem({
  surface,
  active,
  live,
  iconOnly,
  measuring = false,
  onSelect,
  onClose,
}: {
  surface: RightPanelSurface;
  active: boolean;
  /** Draws the tab's live node in place of its icon, e.g. agents still running. */
  live: boolean;
  /** Icon alone, with the label moved into a tooltip. */
  iconOnly: boolean;
  /**
   * Rendered into the strip's hidden measuring row rather than the strip: same
   * box model, no identity. That row is always labelled, which is what makes
   * the mode decision independent of the mode currently in force.
   */
  measuring?: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const TabIcon = RIGHT_PANEL_TAB_ICONS[surface.id];
  // With no label to overlay, only the active tab offers a ✕: hovering an
  // inactive icon takes you to its surface, and turning that same hover into a
  // close target would make a 28px box mean two opposite things. Reaching a
  // background surface's ✕ costs one extra click (select it, then close it),
  // which is the trade the strip already makes for not spending width on a
  // control that is invisible most of the time. Middle-click closes either way.
  const closable = !iconOnly || active;
  const tabButton = (
    <button
      type="button"
      role={measuring ? undefined : "tab"}
      aria-selected={measuring ? undefined : active}
      {...(iconOnly ? { "aria-label": surface.label } : {})}
      className={cn(
        "flex shrink-0 items-center py-1 focus-ring",
        iconOnly ? "justify-center" : "gap-1.5",
      )}
      onClick={measuring ? undefined : onSelect}
    >
      <span
        className={cn(
          "flex size-3 shrink-0 items-center justify-center transition-opacity",
          // The glyph steps aside only where the ✕ lands on top of it.
          iconOnly && closable && HIDE_ON_TAB_HOVER_OR_FOCUS,
        )}
        {...(measuring ? {} : { "data-right-panel-tab-glyph": "true" })}
      >
        {live ? (
          <LiveNode className="size-1.5" />
        ) : (
          <TabIcon className="size-3 opacity-70" aria-hidden="true" />
        )}
      </span>
      {iconOnly ? null : (
        <span
          className={cn("whitespace-nowrap", !measuring && closable && LABEL_FADE_UNDER_CLOSE)}
          data-right-panel-tab-label={measuring ? undefined : "true"}
        >
          {surface.label}
        </span>
      )}
    </button>
  );

  const tab = (
    <div
      role="presentation"
      className={cn(
        // Exactly as wide as its own contents: icon and whole label, or icon
        // alone. Not flex-1, which made the strip's look depend on how many tabs
        // happened to be open, and not shrinkable either -- a surface named
        // "Cha…" is worse than a nameless one, so a label is never abbreviated;
        // it is whole, or it is a tooltip. When even the icons outgrow the strip
        // the row scrolls, exactly as the browser panel's does.
        "group/rail-tab relative flex shrink-0 items-center rounded-t-md text-xs",
        iconOnly
          ? // Square-ish: the glyph and its padding, nothing else.
            "px-2"
          : // Padded wider after the label than before the glyph: the glyph
            // anchors the left edge, and the tail carries the ✕, which wants a
            // margin of its own rather than sitting on the tab's edge.
            "pr-3.5 pl-1.5",
        active
          ? "bg-background text-foreground"
          : "bg-muted/50 text-muted-foreground/80 hover:bg-accent hover:text-foreground",
      )}
      {...(measuring
        ? {}
        : {
            "data-right-panel-tab": surface.id,
            "data-active": active ? "true" : undefined,
            "data-right-panel-tab-icon-only": iconOnly ? "true" : undefined,
            // A tab with no ✕ on show still closes the way browser tabs always
            // have, so no panel width ever strands a tab open.
            onAuxClick: (event: React.MouseEvent) => {
              if (event.button !== 1) {
                return;
              }
              event.preventDefault();
              onClose();
            },
            onMouseDown: (event: React.MouseEvent) => {
              // Suppress the middle-click autoscroll cursor; the close itself
              // happens on auxclick, where the gesture is complete.
              if (event.button === 1) {
                event.preventDefault();
              }
            },
          })}
    >
      {tabButton}
      {/* Overlaid on the tab's right edge rather than given a column of its own:
          reserving ~18px per tab for a control that is invisible most of the
          time is the width this strip cannot spare. Absolute, so revealing it
          reflows nothing -- the tab is the same box hovered or not. */}
      {closable && !measuring ? (
        <button
          type="button"
          aria-label={`Close ${surface.label}`}
          data-right-panel-close-tab={surface.id}
          // Its ground is the tab's own surface, so the ✕ reads as a chip the
          // label passes under rather than as a glyph printed on top of the text.
          // And its own hover fill over that, because the cursor is an arrow
          // across the whole tab: without it nothing says the pointer is on the ✕
          // rather than on the tab it sits in.
          className={cn(
            "group/rail-close absolute inline-flex items-center justify-center opacity-0 transition-[opacity,background-color,color] hover:text-foreground focus-ring",
            active ? "bg-background" : "bg-rail",
            iconOnly
              ? // The whole tab, so the target is the icon's own 28px box rather
                // than a badge pinned to a corner of it. Its visible hover fill
                // stays around the centered ✕, matching the labelled control,
                // while this full box keeps the pointer target generous.
                "inset-0 rounded-t-md"
              : "top-1/2 right-1 size-4 -translate-y-1/2 rounded hover:bg-foreground/10",
            REVEAL_ON_TAB_HOVER_OR_FOCUS,
            "focus-visible:opacity-100",
          )}
          onClick={onClose}
        >
          <span
            className={cn(
              "inline-flex items-center justify-center transition-colors",
              iconOnly && "size-4 rounded group-hover/rail-close:bg-foreground/10",
            )}
            data-right-panel-close-glyph="true"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </span>
        </button>
      ) : null}
    </div>
  );

  if (!iconOnly || measuring) {
    // A labelled tab needs no tooltip: it would only repeat what is written on it.
    return tab;
  }
  // On the whole tab rather than on its button, because the active icon's ✕
  // covers that button entirely -- anchoring the tooltip there would mean the one
  // thing naming the surface disappears exactly when the glyph does. And with no
  // dwell: on a control with no label, waiting reads as the control being
  // nameless rather than as a tooltip on its way. The button's own `aria-label`
  // is what carries the name to assistive tech and to keyboard focus.
  return (
    <TooltipWrapper delay={0} side="bottom" tooltip={surface.label}>
      {tab}
    </TooltipWrapper>
  );
}

/**
 * Decides between labelled and icon-only from what the row actually has to
 * spend, not from a viewport breakpoint: the panel is user-resizable and the
 * window-controls overlay eats a variable slice of the same row, so the only
 * honest inputs are the row's own content box, the width the anchored controls
 * take out of it, and how wide the tabs would be with their labels on.
 *
 * That last number comes from a hidden, always-labelled copy of the row. Asking
 * the live row how wide it would be with labels is impossible once the labels
 * are off, and estimating it is what makes strips like this oscillate.
 */
function useTabStripMode(tabsKey: string): {
  mode: RightPanelTabStripMode;
  rowRef: React.RefObject<HTMLDivElement | null>;
  measureRef: React.RefObject<HTMLDivElement | null>;
  actionsRef: React.RefObject<HTMLDivElement | null>;
} {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<RightPanelTabStripMode>("labels");
  const modeRef = useRef<RightPanelTabStripMode>(mode);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (row === null || measure === null) {
      return;
    }
    const evaluate = () => {
      const style = getComputedStyle(row);
      // The row's content box, less the `+` and the sheet's dismissal: they are
      // anchored beside the tabs and always on screen, so their width was never
      // the tabs' to spend.
      const available =
        row.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        (actionsRef.current?.offsetWidth ?? 0);
      const labelled = measure.offsetWidth;
      const fits =
        modeRef.current === "labels"
          ? labelled <= available
          : labelled + TAB_LABEL_HYSTERESIS_PX <= available;
      const next: RightPanelTabStripMode = fits ? "labels" : "icons";
      if (next !== modeRef.current) {
        modeRef.current = next;
        setMode(next);
      }
    };
    evaluate();
    const observer = new ResizeObserver(evaluate);
    observer.observe(row);
    observer.observe(measure);
    const actions = actionsRef.current;
    if (actions !== null) {
      observer.observe(actions);
    }
    return () => {
      observer.disconnect();
    };
    // The measuring row is rebuilt when the open set changes, so its observed
    // box is the only thing that has to be re-subscribed.
  }, [tabsKey]);

  return { mode, rowRef, measureRef, actionsRef };
}

export const RightPanelTabStrip = memo(function RightPanelTabStrip({
  openTabs,
  availableTabs,
  activeTab,
  liveTabs,
  surfaceStates,
  onSelectTab,
  onCloseTab,
  trailing,
}: {
  openTabs: ReadonlyArray<RightPanelTab>;
  availableTabs: ReadonlyArray<RightPanelTab>;
  activeTab: RightPanelTab | null;
  /** Tabs whose content is currently live, drawn with a live node. */
  liveTabs?: ReadonlyArray<RightPanelTab>;
  /** Shared surface availability, used to quiet empty entries in the + menu. */
  surfaceStates?: RightPanelLauncherStates | undefined;
  onSelectTab: (tab: RightPanelTab) => void;
  onCloseTab: (tab: RightPanelTab) => void;
  /** Sheet-mode dismissal, parked at the end of the row. */
  trailing?: React.ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const { mode, rowRef, measureRef, actionsRef } = useTabStripMode(openTabs.join(","));
  const iconOnly = mode === "icons";

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
  }, [activeTab, openTabs, mode]);

  return (
    <div
      ref={stripRef}
      className="drag-region shrink-0 border-b border-border"
      data-right-panel-strip="true"
      data-right-panel-strip-mode={mode}
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
        ref={rowRef}
        className="relative flex h-9 items-stretch px-1.5 pt-1.5 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.25rem)]"
        data-right-panel-tabs-row="true"
      >
        {/* The labelled row the mode decision is measured against. Out of the
            flow and out of the accessibility tree, but laid out in the strip's
            own font and spacing, and built from the same component as the real
            tabs so the two cannot drift apart. */}
        <div
          ref={measureRef}
          aria-hidden="true"
          data-right-panel-tabs-measure="true"
          className="pointer-events-none invisible absolute top-0 left-0 flex w-max items-stretch gap-px"
        >
          {openTabs.map((tab) => (
            <TabStripItem
              key={tab}
              surface={RIGHT_PANEL_SURFACES[tab]}
              active={false}
              live={false}
              iconOnly={false}
              measuring
              onSelect={() => undefined}
              onClose={() => undefined}
            />
          ))}
        </div>
        {/* Tabs collapse to icons before they scroll, and scroll rather than
            shrink once even the icons overflow, as the browser panel's do.
            Whatever the panel's width -- the 272px floor, or the Windows
            overlay's row shared with the controls cluster -- every tab is drawn
            whole and the hidden ones are reachable by scrolling, marked by the
            same hairline overlay bar and edge fades the browser strip uses.
            Neither costs the row any height.

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
                  iconOnly={iconOnly}
                  onSelect={() => onSelectTab(tab)}
                  onClose={() => onCloseTab(tab)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
        {/* Anchored beside the scroller, never in it: the one control that adds a
            tab has to stay reachable no matter how far the tabs have scrolled.
            Grouped with the sheet's dismissal so the strip can measure in one
            read what the tabs do not get to spend. */}
        <div
          ref={actionsRef}
          className="flex shrink-0 items-stretch"
          data-right-panel-strip-actions="true"
        >
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
                  const empty = surfaceStates?.[tab]?.empty ?? false;
                  const MenuIcon = RIGHT_PANEL_TAB_ICONS[tab];
                  return (
                    <MenuItem
                      key={tab}
                      data-right-panel-menu-tab={tab}
                      data-right-panel-menu-tab-open={alreadyOpen ? "true" : undefined}
                      data-right-panel-menu-tab-empty={empty ? "true" : undefined}
                      className={cn((alreadyOpen || empty) && "text-muted-foreground/60")}
                      onClick={() => onSelectTab(tab)}
                    >
                      <MenuIcon
                        aria-hidden="true"
                        className={cn(empty ? "text-muted-foreground/45" : "text-muted-foreground")}
                      />
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
    </div>
  );
});
