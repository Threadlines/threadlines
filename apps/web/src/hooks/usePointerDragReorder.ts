import { useCallback, useEffect, useRef, useState } from "react";

/** How far a press must travel before it becomes a drag: below this it is a
 *  click, and the item must not so much as twitch. */
const DRAG_THRESHOLD_PX = 4;

/** Must match the `duration-150` on the shift and settle transitions of whoever draws the drag. */
const DRAG_SETTLE_MS = 150;

/** How close to a scroll container's edge the pointer has to be to scroll it. */
const AUTO_SCROLL_EDGE_PX = 28;
const AUTO_SCROLL_MAX_STEP_PX = 10;

/** One item's place along the drag axis, in the coordinates `measure` chooses. */
export interface DragReorderBox {
  readonly start: number;
  readonly size: number;
}

export interface DragReorderState<Item> {
  readonly item: Item;
  /** The order when the drag started; `bounds` is indexed by it. */
  readonly order: ReadonlyArray<Item>;
  readonly bounds: ReadonlyArray<DragReorderBox>;
  readonly from: number;
  /** The slot the item would land in if released right now. */
  readonly to: number;
  /** Travel from the press, clamped to the items' own run. */
  readonly offset: number;
  /** Released: the item is gliding from the pointer to its new slot. */
  readonly settling: boolean;
}

/** What a drag asks one item to look like this frame. */
export type DragReorderVisual =
  | { readonly kind: "dragged"; readonly offset: number; readonly settling: boolean }
  | { readonly kind: "shifted"; readonly offset: number };

/**
 * The slot the dragged item has earned, measured against where the others
 * STARTED: reading their shifted positions back into this decision is what
 * makes lists like this flicker at the crossover point.
 *
 * A swap happens when the dragged item's LEADING edge crosses a neighbour's
 * midpoint, not its centre: the drag is clamped to the run of items, and an
 * item at least as big as the end one could never carry its centre past that
 * one's midpoint, so the far slot would be unreachable. Its edge always reaches
 * the run's edge, so the edge is what earns the slot.
 */
function dragTargetIndex(
  bounds: ReadonlyArray<DragReorderBox>,
  from: number,
  offset: number,
): number {
  const own = bounds[from];
  if (own === undefined) {
    return from;
  }
  if (offset < 0) {
    const edge = own.start + offset;
    for (let index = 0; index < from; index += 1) {
      const box = bounds[index];
      if (box !== undefined && edge < box.start + box.size / 2) {
        return index;
      }
    }
    return from;
  }
  const edge = own.start + own.size + offset;
  for (let index = bounds.length - 1; index > from; index -= 1) {
    const box = bounds[index];
    if (box !== undefined && edge > box.start + box.size / 2) {
      return index;
    }
  }
  return from;
}

/** Where the dragged item's new slot lies relative to its old one: the size of
 *  everything it passed, so the settle animation ends exactly on layout. */
function dragSettleOffset(
  bounds: ReadonlyArray<DragReorderBox>,
  from: number,
  to: number,
  gapPx: number,
): number {
  let offset = 0;
  if (to > from) {
    for (let index = from + 1; index <= to; index += 1) {
      offset += (bounds[index]?.size ?? 0) + gapPx;
    }
  } else {
    for (let index = to; index < from; index += 1) {
      offset -= (bounds[index]?.size ?? 0) + gapPx;
    }
  }
  return offset;
}

/** How one item should look this frame; null while it isn't part of a drag. */
export function dragReorderVisual<Item>(
  drag: DragReorderState<Item> | null,
  item: Item,
  gapPx = 0,
): DragReorderVisual | null {
  if (drag === null) {
    return null;
  }
  const index = drag.order.indexOf(item);
  if (index === -1) {
    return null;
  }
  if (index === drag.from) {
    return { kind: "dragged", offset: drag.offset, settling: drag.settling };
  }
  const span = (drag.bounds[drag.from]?.size ?? 0) + gapPx;
  const offset =
    drag.from < index && index <= drag.to
      ? -span
      : drag.to <= index && index < drag.from
        ? span
        : 0;
  return { kind: "shifted", offset };
}

export interface PointerDragReorderInput<Item> {
  readonly axis: "x" | "y";
  /** The space between items, folded into every shift so they land on layout. */
  readonly gapPx?: number;
  /** Reads the items that swap with this one, on the press becoming a drag. Null: no drag. */
  readonly measure: (item: Item) => {
    readonly order: ReadonlyArray<Item>;
    readonly bounds: ReadonlyArray<DragReorderBox>;
  } | null;
  /** Commits a move. Undefined: nothing can be dragged. */
  readonly onReorder: ((item: Item, toIndex: number) => void) | undefined;
  /** Changes when the measured positions stop being true, which cancels the drag. */
  readonly layoutKey: string;
  /** The scroller to carry along when the pointer nears its edges. */
  readonly scrollContainer?: () => HTMLElement | null;
}

/**
 * Pointer-drag reorder, in the browser-tab idiom: the held item rides the
 * pointer, its neighbours slide out of the way as it crosses their midpoints,
 * and on release it glides into the slot it was over BEFORE the order commits;
 * committing first would snap it there with no journey. Positions are measured
 * once, on the press becoming a drag; a list that changes under the drag cancels
 * it, and so does Escape. The caller decides which presses may start a drag.
 *
 * Window-level listeners rather than pointer capture: the drag must survive
 * the pointer leaving the list, and capture of untrusted pointers is exactly
 * the part that cannot be exercised in tests.
 */
export function usePointerDragReorder<Item>(input: PointerDragReorderInput<Item>): {
  drag: DragReorderState<Item> | null;
  beginDrag: (item: Item, event: React.PointerEvent) => void;
  suppressDragClick: (event: React.MouseEvent) => void;
} {
  const [drag, setDrag] = useState<DragReorderState<Item> | null>(null);
  const dragRef = useRef<DragReorderState<Item> | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const suppressClickRef = useRef(false);
  const layoutKeyAtStartRef = useRef(input.layoutKey);

  // One closure holds the whole listener machine, built once: its handlers
  // read refs, so they never go stale and never need re-attaching.
  const machineRef = useRef<{
    begin: (item: Item, event: React.PointerEvent) => void;
    cancel: () => void;
  } | null>(null);
  if (machineRef.current === null) {
    const pointerOf = (event: { clientX: number; clientY: number }) =>
      inputRef.current.axis === "x" ? event.clientX : event.clientY;
    const scrollOf = (element: HTMLElement | null) =>
      element === null ? 0 : inputRef.current.axis === "x" ? element.scrollLeft : element.scrollTop;

    let pending: { item: Item; startPointer: number } | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let pointer = 0;
    let startPointer = 0;
    let startScroll = 0;
    let scroller: HTMLElement | null = null;
    let autoScrollFrame: number | null = null;

    const commit = (state: DragReorderState<Item> | null) => {
      dragRef.current = state;
      setDrag(state);
    };
    const stopAutoScroll = () => {
      if (autoScrollFrame !== null) {
        cancelAnimationFrame(autoScrollFrame);
        autoScrollFrame = null;
      }
    };
    const detach = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      scroller?.removeEventListener("scroll", follow);
      stopAutoScroll();
    };
    // The click after a drag's pointerup dispatches synchronously; the flag
    // outlives exactly that and nothing else.
    const dropSuppressionAfterClick = () => {
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };
    const cancel = () => {
      pending = null;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      detach();
      if (dragRef.current !== null) {
        // The press this drag came from is still down: its click is still to come.
        if (suppressClickRef.current) {
          window.addEventListener("pointerup", dropSuppressionAfterClick, { once: true });
        }
        commit(null);
      }
    };

    /** Re-reads the drag from where the pointer and the scroller are now. */
    function follow() {
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
      const offset = Math.max(
        first.start - own.start,
        Math.min(
          last.start + last.size - (own.start + own.size),
          pointer - startPointer + scrollOf(scroller) - startScroll,
        ),
      );
      commit({ ...state, offset, to: dragTargetIndex(state.bounds, state.from, offset) });
    }

    /** Runs only while the pointer sits near an edge the scroller can still move past. */
    function autoScroll() {
      autoScrollFrame = null;
      if (scroller === null || dragRef.current === null || dragRef.current.settling) {
        return;
      }
      const box = scroller.getBoundingClientRect();
      const [low, high] =
        inputRef.current.axis === "x" ? [box.left, box.right] : [box.top, box.bottom];
      const intoLow = low + AUTO_SCROLL_EDGE_PX - pointer;
      const intoHigh = pointer - (high - AUTO_SCROLL_EDGE_PX);
      const depth = Math.max(intoLow, intoHigh);
      if (depth <= 0) {
        return;
      }
      const step =
        Math.ceil(Math.min(depth / AUTO_SCROLL_EDGE_PX, 1) * AUTO_SCROLL_MAX_STEP_PX) *
        (intoLow > intoHigh ? -1 : 1);
      const before = scrollOf(scroller);
      if (inputRef.current.axis === "x") {
        scroller.scrollLeft += step;
      } else {
        scroller.scrollTop += step;
      }
      if (scrollOf(scroller) !== before) {
        autoScrollFrame = requestAnimationFrame(autoScroll);
      }
    }

    function onPointerMove(event: PointerEvent) {
      pointer = pointerOf(event);
      if (dragRef.current === null) {
        if (pending === null || Math.abs(pointer - pending.startPointer) < DRAG_THRESHOLD_PX) {
          return;
        }
        const measured = inputRef.current.measure(pending.item);
        const from = measured?.order.indexOf(pending.item) ?? -1;
        if (measured === null || from === -1 || measured.order.length < 2) {
          pending = null;
          detach();
          return;
        }
        suppressClickRef.current = true;
        startPointer = pending.startPointer;
        scroller = inputRef.current.scrollContainer?.() ?? null;
        startScroll = scrollOf(scroller);
        scroller?.addEventListener("scroll", follow, { passive: true });
        window.addEventListener("keydown", onKeyDown, true);
        layoutKeyAtStartRef.current = inputRef.current.layoutKey;
        commit({
          item: pending.item,
          order: measured.order,
          bounds: measured.bounds,
          from,
          to: from,
          offset: 0,
          settling: false,
        });
        pending = null;
      }
      follow();
      if (scroller !== null && autoScrollFrame === null) {
        autoScrollFrame = requestAnimationFrame(autoScroll);
      }
    }

    function onPointerUp() {
      pending = null;
      detach();
      const state = dragRef.current;
      if (state === null || state.settling) {
        return;
      }
      dropSuppressionAfterClick();
      const settled: DragReorderState<Item> = {
        ...state,
        offset: dragSettleOffset(state.bounds, state.from, state.to, inputRef.current.gapPx ?? 0),
        settling: true,
      };
      commit(settled);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        // Reorder and release in one commit, so the new order never renders
        // under the old transforms.
        if (settled.to !== settled.from) {
          inputRef.current.onReorder?.(settled.item, settled.to);
        }
        commit(null);
      }, DRAG_SETTLE_MS);
    }

    function onPointerCancel() {
      dropSuppressionAfterClick();
      cancel();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    }

    machineRef.current = {
      begin: (item, event) => {
        if (inputRef.current.onReorder === undefined) {
          return;
        }
        if (event.button !== 0 || dragRef.current !== null) {
          return;
        }
        pointer = pointerOf(event);
        pending = { item, startPointer: pointer };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
      },
      cancel,
    };
  }
  const machine = machineRef.current;

  useEffect(() => () => machine.cancel(), [machine]);

  // A list that changed under the drag invalidates what was measured; drop the
  // drag rather than reorder against positions that are no longer true.
  useEffect(() => {
    if (dragRef.current !== null && layoutKeyAtStartRef.current !== input.layoutKey) {
      machine.cancel();
    }
  }, [machine, input.layoutKey]);

  const beginDrag = useCallback(
    (item: Item, event: React.PointerEvent) => machine.begin(item, event),
    [machine],
  );
  const suppressDragClick = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { drag, beginDrag, suppressDragClick };
}
