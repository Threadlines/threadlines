import {
  createContext,
  type ReactNode,
  type RefCallback,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

/**
 * The open page's part of the window's title row (AppTitleBar), or null while
 * there is no title row: the phone layout.
 */
export const TitleBarSlotContext = createContext<HTMLElement | null>(null);

/** Whether the window has a title row (the desktop layout), with or without the page's header in it. */
export function useTitleBarRowPresent(): boolean {
  return use(TitleBarSlotContext) !== null;
}

/**
 * How much room the title row has, how much the open page's header needs
 * there, and so where the header goes. AppTitleBar publishes the room; the
 * page's TitleBarContent the need. A store, not React state: both come from
 * ResizeObservers, the placement is decided as they land, and a store change
 * renders before the next paint, so a header never draws a frame in a row it
 * doesn't fit.
 */
interface TitleBarLayout {
  /** The page's slot in the row, in px; null without a title row or before it's measured. */
  readonly slotWidth: number | null;
  /** The slot's width if the app's name were showing, whether it is or not. */
  readonly slotWidthWithName: number | null;
  /** The narrowest the open page's header can be in the row; null when it has none. */
  readonly headerNeed: number | null;
  readonly headerOwner: symbol | null;
  /** Whether that header sits in the row (true) or in a row of its own. */
  readonly headerInRow: boolean;
  /** When and at what slot width the header last left the row. */
  readonly headerLeftRow: { readonly slotWidth: number | null; readonly at: number } | null;
}

export const useTitleBarLayoutStore = create<TitleBarLayout>()(() => ({
  slotWidth: null,
  slotWidthWithName: null,
  headerNeed: null,
  headerOwner: null,
  headerInRow: true,
  headerLeftRow: null,
}));

/**
 * How long, after the header leaves the title row at one width, it waits
 * before trying the row again at that same width. The header's need is read
 * as it would be in the row wherever it is, so a return at the same width
 * finds the same answer; this guards against a header that somehow measured
 * differently moving back and forth without end, and is not a delay anyone
 * sees.
 */
const RETURN_AT_SAME_WIDTH_AFTER_MS = 500;

/**
 * Where the header goes: in the row while the slot is at least as wide as the
 * header needs there. An unknown size counts as fitting, which is what a page
 * without a header, or one not measured yet, needs.
 */
function fitsInRow(state: TitleBarLayout): boolean {
  return (
    state.slotWidth === null || state.headerNeed === null || state.slotWidth >= state.headerNeed
  );
}

function placeHeader(state: TitleBarLayout): TitleBarLayout {
  const fits = fitsInRow(state);
  if (fits === state.headerInRow) return state;
  if (!fits) {
    return {
      ...state,
      headerInRow: false,
      headerLeftRow: { slotWidth: state.slotWidth, at: performance.now() },
    };
  }
  const left = state.headerLeftRow;
  if (
    left !== null &&
    left.slotWidth === state.slotWidth &&
    performance.now() - left.at < RETURN_AT_SAME_WIDTH_AFTER_MS
  ) {
    return state;
  }
  return { ...state, headerInRow: true };
}

let returnRetry: ReturnType<typeof setTimeout> | null = null;

function updateTitleBarLayout(change: Partial<TitleBarLayout>) {
  const state = useTitleBarLayoutStore.getState();
  const next = placeHeader({ ...state, ...change });
  // A header held back from the row by the guard tries again once it lapses:
  // nothing else may change to prompt it.
  if (returnRetry !== null) {
    clearTimeout(returnRetry);
    returnRetry = null;
  }
  const left = next.headerLeftRow;
  if (!next.headerInRow && left !== null && fitsInRow(next)) {
    returnRetry = setTimeout(
      () => {
        returnRetry = null;
        updateTitleBarLayout({});
      },
      Math.max(0, RETURN_AT_SAME_WIDTH_AFTER_MS - (performance.now() - left.at)),
    );
  }
  const changed = (Object.keys(next) as (keyof TitleBarLayout)[]).some(
    (key) => next[key] !== state[key],
  );
  if (changed) useTitleBarLayoutStore.setState(next);
}

export function publishTitleBarRoom(slotWidth: number | null, slotWidthWithName: number | null) {
  updateTitleBarLayout({ slotWidth, slotWidthWithName });
}

function publishHeaderNeed(owner: symbol, need: number | null) {
  const state = useTitleBarLayoutStore.getState();
  if (need === null) {
    if (state.headerOwner === owner) {
      updateTitleBarLayout({ headerNeed: null, headerOwner: null, headerLeftRow: null });
    }
    return;
  }
  // A new page's header starts in the row, without the last one's history.
  updateTitleBarLayout(
    state.headerOwner === owner
      ? { headerNeed: need }
      : { headerNeed: need, headerOwner: owner, headerInRow: true, headerLeftRow: null },
  );
}

/**
 * The room the title row's name gives way to: it shows while the page's part
 * of the row keeps at least this much (or what the page's header needs, if
 * more), and hides first, before a header leaves the row.
 */
const NAME_GIVES_WAY_BELOW_PX = 400;

/** Whether the title row hides the app's name to make room. */
export function useTitleBarNameHidden(): boolean {
  return useTitleBarLayoutStore(
    (state) =>
      state.slotWidthWithName !== null &&
      state.slotWidthWithName < Math.max(state.headerNeed ?? 0, NAME_GIVES_WAY_BELOW_PX),
  );
}

/**
 * The narrowest a row of controls can be: items that don't shrink at their
 * width, rows that do measured the same way inside, other shrinking items at
 * their minimum (usually nothing), plus the gaps and padding between. Read
 * from the live layout, so it is the same wherever the row sits, except where
 * a container query shows more of it in a wider spot.
 */
function measureRowMinWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.position === "absolute" || style.position === "fixed") {
    return 0;
  }
  if (Number.parseFloat(style.flexShrink) === 0) return element.offsetWidth;
  const isRow = style.display.endsWith("flex") && !style.flexDirection.startsWith("column");
  if (!isRow) return Number.parseFloat(style.minWidth) || 0;
  let total = 0;
  let items = 0;
  for (const child of element.children) {
    if (!(child instanceof HTMLElement)) continue;
    const childStyle = getComputedStyle(child);
    if (childStyle.display === "none" || childStyle.position === "absolute") continue;
    total += measureRowMinWidth(child);
    items += 1;
  }
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return Math.ceil(total + gap * Math.max(0, items - 1) + padding);
}

interface TitleBarMeasure {
  readonly report: (need: number) => void;
  readonly flexibleMinWidth: number;
}

const TitleBarMeasureContext = createContext<TitleBarMeasure | null>(null);

/**
 * How narrow `header` can be in `slot`. In the slot, read from it as it is.
 * In its own row it may be laid out roomier (container queries show more of
 * a wider header), so it's read from a copy laid out at the slot's width: the
 * answer depends on the slot and the header's controls, never on which row
 * the header is in, so the two rows can't trade it back and forth. The copy is
 * removed before anything is drawn.
 */
function measureHeaderNeedIn(slot: HTMLElement, header: HTMLElement): number {
  if (slot.contains(header)) return measureRowMinWidth(header);
  const probe = document.createElement("div");
  probe.inert = true;
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;top:0;left:0;height:100%;display:flex;visibility:hidden;pointer-events:none;";
  probe.style.width = `${slot.clientWidth}px`;
  const copy = header.cloneNode(true) as HTMLElement;
  probe.append(copy);
  slot.append(probe);
  try {
    return measureRowMinWidth(copy);
  } finally {
    probe.remove();
  }
}

/**
 * For a page header shown through TitleBarContent: attach it to the header's
 * outermost row and the title row learns how narrow the header can get there
 * (its fixed controls, plus the room TitleBarContent keeps for its title).
 * Re-read whenever the header or the slot resizes or the header's controls
 * change. Does nothing outside TitleBarContent.
 */
export function useTitleBarHeaderRef(): RefCallback<HTMLElement> {
  const measure = use(TitleBarMeasureContext);
  const slot = use(TitleBarSlotContext);
  return useCallback(
    (node: HTMLElement | null) => {
      if (!measure || !slot || !node || typeof ResizeObserver === "undefined") return undefined;
      const publish = () =>
        measure.report(measureHeaderNeedIn(slot, node) + measure.flexibleMinWidth);
      const resizeObserver = new ResizeObserver(publish);
      resizeObserver.observe(node);
      // In its own row the header doesn't resize with the slot (the name
      // folding, the list docking), but its need there does.
      const stopFollowingSlot = useTitleBarLayoutStore.subscribe((state, previous) => {
        if (state.slotWidth !== previous.slotWidth) publish();
      });
      // A control appearing (a running task, an agent's face) or its label
      // changing moves the header's minimum without resizing the header.
      const mutationObserver = new MutationObserver(publish);
      mutationObserver.observe(node, { childList: true, subtree: true, characterData: true });
      publish();
      return () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        stopFollowingSlot();
      };
    },
    [measure, slot],
  );
}

/**
 * A page's header. While the window has a title row and the header fits in
 * it, it goes up into the row's slot for the open page, after the toggle,
 * back, forward and the app's name, the way Mail, Notes and Finder put their
 * toolbars in the title bar. Otherwise it is `fallback`, the page's own
 * header row: on a phone (with the sidebar trigger it needs there), and in a
 * desktop window too narrow for it, where the row keeps the window's own
 * controls and the header gets a row of its own beneath.
 *
 * The header fits while the slot is at least as wide as it can shrink: the
 * header marks its outer row with useTitleBarHeaderRef, and
 * `flexibleMinWidth` keeps room for what shrinks in it (a thread's title).
 *
 * In the row the content fills the slot (`h-full`), so `measureRef` reads
 * the row's bottom as the header's; empty space around the controls still
 * moves the window, and the controls themselves never do.
 */
export function TitleBarContent({
  children,
  fallback = null,
  measureRef,
  findRegion,
  flexibleMinWidth = 0,
}: {
  readonly children?: ReactNode;
  readonly fallback?: ReactNode;
  readonly measureRef?: RefCallback<HTMLElement>;
  /** Marks the header as part of a find-in-page region, as the inline header is. */
  readonly findRegion?: string;
  /** Room kept in the title row for the header's shrinking part, in px. */
  readonly flexibleMinWidth?: number;
}) {
  const slot = use(TitleBarSlotContext);
  const [owner] = useState(() => Symbol("title-bar-content"));
  const inRow = useTitleBarLayoutStore((state) => state.headerOwner !== owner || state.headerInRow);
  const measure = useMemo<TitleBarMeasure>(
    () => ({ report: (next) => publishHeaderNeed(owner, next), flexibleMinWidth }),
    [flexibleMinWidth, owner],
  );
  const empty = children === null || children === undefined || children === false;
  // A header that's gone (a page action that only shows sometimes) needs no
  // room. Not cleared when it moves between rows: the move remounts it, and a
  // moment without a need would read as "fits" and send it straight back.
  useEffect(() => {
    if (empty) publishHeaderNeed(owner, null);
  }, [empty, owner]);
  useEffect(() => () => publishHeaderNeed(owner, null), [owner]);

  if (slot === null) {
    return <TitleBarMeasureContext value={measure}>{fallback}</TitleBarMeasureContext>;
  }
  if (empty) return null;
  if (!inRow) {
    return <TitleBarMeasureContext value={measure}>{fallback}</TitleBarMeasureContext>;
  }
  return createPortal(
    <TitleBarMeasureContext value={measure}>
      <div
        ref={measureRef}
        data-find-region={findRegion}
        data-testid="titlebar-page-content"
        className="flex h-full min-w-0 flex-1 items-center gap-2"
      >
        {children}
      </div>
    </TitleBarMeasureContext>,
    slot,
  );
}
