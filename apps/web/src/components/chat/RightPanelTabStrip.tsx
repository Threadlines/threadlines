/**
 * The right sidebar's tab strip, in the internal browser's visual language: a
 * short row of rounded-top tabs, the active one lifted onto the background, a
 * close ✕ that appears on hover, and a `+` sitting after the last tab. On touch
 * screens -- where a control that waits for hover is a control that does not
 * exist -- the ✕ is on show permanently instead, in width the tab reserves.
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
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
 * On hover-capable devices the label's tail fades out from under the ✕ while
 * the ✕ is showing. There the ✕ has no width of its own -- reserving one is the
 * whole thing this strip is trying to avoid -- so the label is what gives way,
 * which is also what Chrome and Edge do. (Touch tabs reserve real width via
 * padding instead, so the label never runs under the ✕ there.) Spelled out
 * twice rather than composed at runtime: Tailwind only ships classes it can see
 * written down.
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

/** How far a press must travel before it becomes a drag: below this it is a
 *  click, and the tab must not so much as twitch. */
const TAB_DRAG_THRESHOLD_PX = 4;

/** The tablist's `gap-px`, folded into every shift so tabs land on layout. */
const TAB_GAP_PX = 1;

/** Must match the `duration-150` on the shift/settle transitions below. */
const TAB_DRAG_SETTLE_MS = 150;

interface TabDragBox {
  readonly left: number;
  readonly width: number;
}

interface TabDragState {
  readonly tab: RightPanelTab;
  /** The strip's order when the drag started; `bounds` is indexed by it. */
  readonly order: ReadonlyArray<RightPanelTab>;
  readonly bounds: ReadonlyArray<TabDragBox>;
  readonly from: number;
  /** The slot the tab would land in if released right now. */
  readonly to: number;
  readonly startX: number;
  /** Pointer travel, clamped to the strip's own run of tabs. */
  readonly dx: number;
  /** Released: the tab is gliding from the pointer to its new slot. */
  readonly settling: boolean;
}

/** What a drag asks one tab to look like this frame. */
type TabDragVisual =
  | { readonly kind: "dragged"; readonly offsetX: number; readonly settling: boolean }
  | { readonly kind: "shifted"; readonly offsetX: number };

/**
 * The slot the dragged tab has earned, measured against where the other tabs
 * STARTED — reading their shifted positions back into this decision is what
 * makes strips like this flicker at the crossover point.
 *
 * A swap happens when the dragged tab's LEADING edge crosses a neighbour's
 * midpoint, not its centre: the drag is clamped to the strip's run of tabs,
 * and a dragged tab at least as wide as the end tab could never carry its
 * centre past that tab's midpoint — the far slot was unreachable. Its edge
 * always reaches the strip's edge, so the edge is what earns the slot.
 */
function dragTargetIndex(bounds: ReadonlyArray<TabDragBox>, from: number, dx: number): number {
  const own = bounds[from];
  if (own === undefined) {
    return from;
  }
  if (dx < 0) {
    const edge = own.left + dx;
    for (let index = 0; index < from; index += 1) {
      const box = bounds[index];
      if (box !== undefined && edge < box.left + box.width / 2) {
        return index;
      }
    }
    return from;
  }
  const edge = own.left + own.width + dx;
  for (let index = bounds.length - 1; index > from; index -= 1) {
    const box = bounds[index];
    if (box !== undefined && edge > box.left + box.width / 2) {
      return index;
    }
  }
  return from;
}

/** Where the dragged tab's new slot lies relative to its old one: the width of
 *  everything it passed, so the settle animation ends exactly on layout. */
function dragSettleOffset(bounds: ReadonlyArray<TabDragBox>, from: number, to: number): number {
  let offset = 0;
  if (to > from) {
    for (let index = from + 1; index <= to; index += 1) {
      offset += (bounds[index]?.width ?? 0) + TAB_GAP_PX;
    }
  } else {
    for (let index = to; index < from; index += 1) {
      offset -= (bounds[index]?.width ?? 0) + TAB_GAP_PX;
    }
  }
  return offset;
}

function tabDragVisual(drag: TabDragState | null, tab: RightPanelTab): TabDragVisual | null {
  if (drag === null) {
    return null;
  }
  const index = drag.order.indexOf(tab);
  if (index === -1) {
    return null;
  }
  if (index === drag.from) {
    return { kind: "dragged", offsetX: drag.dx, settling: drag.settling };
  }
  const span = (drag.bounds[drag.from]?.width ?? 0) + TAB_GAP_PX;
  const offsetX =
    drag.from < index && index <= drag.to
      ? -span
      : drag.to <= index && index < drag.from
        ? span
        : 0;
  return { kind: "shifted", offsetX };
}

/** What the strip hands each tab when reordering is on. */
interface TabReorderProps {
  readonly onPointerDown: (event: React.PointerEvent) => void;
  readonly onClickCapture: (event: React.MouseEvent) => void;
  readonly visual: TabDragVisual | null;
}

/**
 * Pointer-drag reorder, in the browser-tab idiom: the held tab rides the
 * pointer, its neighbours slide out of the way as it crosses their midpoints,
 * and on release it glides into the slot it was over BEFORE the order commits
 * — committing first would snap it there with no journey. Positions are
 * measured once, on the press becoming a drag; a strip whose tabs change under
 * the drag (an auto-opened Agents tab, a middle-click close) cancels it.
 *
 * Window-level listeners rather than pointer capture: the drag must survive
 * the pointer leaving the strip, and capture of untrusted pointers is exactly
 * the part that cannot be exercised in tests.
 */
function useTabDragReorder(input: {
  stripRef: React.RefObject<HTMLDivElement | null>;
  openTabs: ReadonlyArray<RightPanelTab>;
  onReorderTab: ((tab: RightPanelTab, toIndex: number) => void) | undefined;
}): {
  drag: TabDragState | null;
  beginTabDrag: (tab: RightPanelTab) => (event: React.PointerEvent) => void;
  suppressDragClick: (event: React.MouseEvent) => void;
} {
  const [drag, setDrag] = useState<TabDragState | null>(null);
  const dragRef = useRef<TabDragState | null>(null);
  const onReorderTabRef = useRef(input.onReorderTab);
  onReorderTabRef.current = input.onReorderTab;
  const suppressClickRef = useRef(false);

  // One closure holds the whole listener machine, built once: its handlers
  // read refs, so they never go stale and never need re-attaching.
  const machineRef = useRef<{
    begin: (tab: RightPanelTab, event: React.PointerEvent) => void;
    cancel: () => void;
  } | null>(null);
  if (machineRef.current === null) {
    const { stripRef } = input;
    let pending: { tab: RightPanelTab; startX: number } | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const commit = (state: TabDragState | null) => {
      dragRef.current = state;
      setDrag(state);
    };
    const detach = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
    const cancel = () => {
      pending = null;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      detach();
      if (dragRef.current !== null) {
        commit(null);
      }
    };
    // The click after a drag's pointerup dispatches synchronously; the flag
    // outlives exactly that and nothing else.
    const dropSuppressionAfterClick = () => {
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    function onPointerMove(event: PointerEvent) {
      if (dragRef.current === null) {
        if (pending === null || Math.abs(event.clientX - pending.startX) < TAB_DRAG_THRESHOLD_PX) {
          return;
        }
        const tablist =
          stripRef.current?.querySelector<HTMLElement>('[data-right-panel-tablist="true"]') ?? null;
        const elements =
          tablist === null
            ? []
            : Array.from(tablist.querySelectorAll<HTMLElement>("[data-right-panel-tab]"));
        const order = elements.map(
          (element) => element.getAttribute("data-right-panel-tab") as RightPanelTab,
        );
        const from = order.indexOf(pending.tab);
        if (from === -1 || order.length < 2) {
          pending = null;
          detach();
          return;
        }
        suppressClickRef.current = true;
        commit({
          tab: pending.tab,
          order,
          bounds: elements.map((element) => ({
            left: element.offsetLeft,
            width: element.offsetWidth,
          })),
          from,
          to: from,
          startX: pending.startX,
          dx: 0,
          settling: false,
        });
        pending = null;
      }
      const state = dragRef.current;
      if (state === null || state.settling) {
        return;
      }
      const first = state.bounds[0];
      const last = state.bounds[state.bounds.length - 1];
      const own = state.bounds[state.from];
      if (first === undefined || last === undefined || own === undefined) {
        return;
      }
      const dx = Math.max(
        first.left - own.left,
        Math.min(last.left + last.width - (own.left + own.width), event.clientX - state.startX),
      );
      commit({ ...state, dx, to: dragTargetIndex(state.bounds, state.from, dx) });
    }

    function onPointerUp() {
      pending = null;
      detach();
      const state = dragRef.current;
      if (state === null || state.settling) {
        return;
      }
      dropSuppressionAfterClick();
      const settled: TabDragState = {
        ...state,
        dx: dragSettleOffset(state.bounds, state.from, state.to),
        settling: true,
      };
      commit(settled);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        // Reorder and release in one commit, so the new order never renders
        // under the old transforms.
        if (settled.to !== settled.from) {
          onReorderTabRef.current?.(settled.tab, settled.to);
        }
        commit(null);
      }, TAB_DRAG_SETTLE_MS);
    }

    function onPointerCancel() {
      dropSuppressionAfterClick();
      cancel();
    }

    machineRef.current = {
      begin: (tab, event) => {
        if (onReorderTabRef.current === undefined) {
          return;
        }
        if (event.button !== 0 || dragRef.current !== null) {
          return;
        }
        // The ✕ is deliberately NOT excluded: in icon mode it covers the whole
        // active tab, so refusing to drag from it made that tab undraggable.
        // The travel threshold is what separates the two gestures — a still
        // press stays a close, and a real drag swallows the trailing click.
        pending = { tab, startX: event.clientX };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
      },
      cancel,
    };
  }
  const machine = machineRef.current;

  useEffect(() => () => machine.cancel(), [machine]);

  // A strip mutated mid-drag invalidates the measured order; drop the drag
  // rather than reorder a list that no longer matches it.
  const openTabsKey = input.openTabs.join(",");
  useEffect(() => {
    const state = dragRef.current;
    if (state !== null && state.order.join(",") !== openTabsKey) {
      machine.cancel();
    }
  }, [machine, openTabsKey]);

  const beginTabDrag = useCallback(
    (tab: RightPanelTab) => (event: React.PointerEvent) => machine.begin(tab, event),
    [machine],
  );
  const suppressDragClick = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { drag, beginTabDrag, suppressDragClick };
}

function TabStripItem({
  surface,
  active,
  live,
  iconOnly,
  measuring = false,
  reorder,
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
  /** Present while the strip has tabs to swap; carries this tab's drag state. */
  reorder?: TabReorderProps;
  onSelect: () => void;
  onClose: () => void;
}) {
  const TabIcon = RIGHT_PANEL_TAB_ICONS[surface.id];
  // While this tab rides the pointer its ✕ hides and its glyph holds: a close
  // control on a tab being moved reads as the wrong gesture. Inline styles,
  // because they are the one thing that outranks the classes.
  const dragging = reorder?.visual?.kind === "dragged";
  // In icon mode the ✕ takes the glyph's whole box, so only the active tab
  // offers one: an always-on ✕ across every icon would erase the row's one
  // means of telling the surfaces apart, and the active surface is the one
  // whose identity the panel below is already showing. Reaching a background
  // surface's ✕ costs one extra tap (select it, then close it); middle-click
  // closes any of them outright.
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
          // The glyph steps aside only where the ✕ lands on top of it: on hover
          // where hover exists, permanently on touch, where the always-on ✕ has
          // the active tab's whole box.
          iconOnly && closable && cn("opacity-0 can-hover:opacity-100", HIDE_ON_TAB_HOVER_OR_FOCUS),
        )}
        {...(dragging ? { style: { opacity: 1 } } : {})}
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
            // anchors the left edge, and the tail carries the ✕. On touch the
            // tail is wider still, real reserved width for the always-on ✕; on
            // hover devices it shrinks back and the ✕ overlays the label.
            "pr-5.5 pl-1.5 can-hover:pr-3.5",
        active
          ? "bg-background text-foreground"
          : "bg-muted/50 text-muted-foreground/80 hover:bg-accent hover:text-foreground",
        // Reorderable tabs claim their pointer from the window drag region and
        // from touch scrolling: a drag on a tab is a tab drag, nothing else.
        reorder && "touch-none [-webkit-app-region:no-drag]",
        // The held tab rides over its neighbours; everyone else slides. The
        // dragged tab itself only transitions while settling into its slot --
        // under the pointer it must track, not chase.
        reorder?.visual?.kind === "dragged" && "z-10",
        reorder?.visual &&
          (reorder.visual.kind === "shifted" || reorder.visual.settling) &&
          "transition-transform duration-150 ease-out",
      )}
      {...(reorder?.visual
        ? { style: { transform: `translateX(${reorder.visual.offsetX}px)` } }
        : {})}
      {...(measuring
        ? {}
        : {
            "data-right-panel-tab": surface.id,
            "data-active": active ? "true" : undefined,
            "data-right-panel-tab-icon-only": iconOnly ? "true" : undefined,
            ...(reorder
              ? {
                  onPointerDown: reorder.onPointerDown,
                  onClickCapture: reorder.onClickCapture,
                }
              : {}),
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
          on hover devices, reserving ~18px per tab for a control that is
          invisible most of the time is the width this strip cannot spare, so it
          hides until hover and reflows nothing when it shows. Touch screens
          have no hover to reveal it with, so there it stays on show and the
          tab's own padding reserves its ground. */}
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
            "group/rail-close absolute inline-flex items-center justify-center transition-[opacity,background-color,color] hover:text-foreground focus-ring",
            active ? "bg-background" : "bg-rail",
            iconOnly
              ? // The whole tab, so the target is the icon's own 28px box rather
                // than a badge pinned to a corner of it. Its visible hover fill
                // stays around the centered ✕, matching the labelled control,
                // while this full box keeps the pointer target generous.
                "inset-0 rounded-t-md"
              : "top-1/2 right-1 size-4 -translate-y-1/2 rounded hover:bg-foreground/10",
            "can-hover:opacity-0",
            REVEAL_ON_TAB_HOVER_OR_FOCUS,
            "focus-visible:opacity-100",
          )}
          {...(dragging ? { style: { opacity: 0, pointerEvents: "none" } } : {})}
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
  trailingRef: React.RefObject<HTMLDivElement | null>;
} {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);
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
        (actionsRef.current?.offsetWidth ?? 0) -
        (trailingRef.current?.offsetWidth ?? 0);
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
    const trailing = trailingRef.current;
    if (trailing !== null) {
      observer.observe(trailing);
    }
    return () => {
      observer.disconnect();
    };
    // The measuring row is rebuilt when the open set changes, so its observed
    // box is the only thing that has to be re-subscribed.
  }, [tabsKey]);

  return { mode, rowRef, measureRef, actionsRef, trailingRef };
}

export const RightPanelTabStrip = memo(function RightPanelTabStrip({
  openTabs,
  availableTabs,
  activeTab,
  liveTabs,
  surfaceStates,
  onSelectTab,
  onCloseTab,
  onReorderTab,
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
  /** Drag-reorder commit. Dragging is offered only while two or more tabs are
   *  open — with one there is nothing to swap. */
  onReorderTab?: ((tab: RightPanelTab, toIndex: number) => void) | undefined;
  /** Sheet-mode dismissal, parked at the end of the row. */
  trailing?: React.ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const { mode, rowRef, measureRef, actionsRef, trailingRef } = useTabStripMode(openTabs.join(","));
  const iconOnly = mode === "icons";
  const reorderable = onReorderTab !== undefined && openTabs.length > 1;
  const { drag, beginTabDrag, suppressDragClick } = useTabDragReorder({
    stripRef,
    openTabs,
    onReorderTab: reorderable ? onReorderTab : undefined,
  });

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
                  {...(reorderable
                    ? {
                        reorder: {
                          onPointerDown: beginTabDrag(tab),
                          onClickCapture: suppressDragClick,
                          visual: tabDragVisual(drag, tab),
                        },
                      }
                    : {})}
                  onSelect={() => onSelectTab(tab)}
                  onClose={() => onCloseTab(tab)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
        {/* Anchored beside the scroller, never in it: the one control that adds a
            tab has to stay reachable no matter how far the tabs have scrolled. */}
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
        </div>
        {/* Dismissal belongs to the panel, not to the tabs, so it is pushed out
            to the row's far edge rather than parked beside the `+`, and stays
            put while the tabs scroll past it. Measured on its own so the mode
            decision still knows the tabs never had this width to spend. */}
        {trailing ? (
          <div
            ref={trailingRef}
            className="ms-auto flex shrink-0 items-center self-center ps-1"
            data-right-panel-strip-trailing="true"
          >
            {trailing}
          </div>
        ) : null}
      </div>
    </div>
  );
});
