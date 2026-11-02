import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import {
  dragReorderVisual,
  usePointerDragReorder,
  type DragReorderVisual,
} from "../../hooks/usePointerDragReorder";
import { cn } from "../../lib/utils";
import { useThreadHoverCardHandle } from "./ThreadHoverCard";

/** What the list needs to let rows be dragged: the inbox's custom order. */
export interface InboxReorder {
  /** The rows this one can swap with, in the order they're drawn. */
  readonly peersOf: (threadKey: string) => readonly string[];
  readonly onMove: (threadKey: string, toIndex: number) => void;
}

/** What the list needs to let group headers be dragged, in any sort. */
export interface InboxGroupReorder {
  readonly onMove: (groupKey: string, toIndex: number) => void;
}

interface InboxDragContextValue {
  readonly visualOf: (threadKey: string) => DragReorderVisual | null;
  readonly beginDrag: (threadKey: string, event: React.PointerEvent) => void;
  readonly suppressDragClick: (event: React.MouseEvent) => void;
}

const InboxDragContext = createContext<InboxDragContextValue | null>(null);
const InboxGroupDragContext = createContext<InboxDragContextValue | null>(null);

/** Where each item sits, in the scroller's own coordinates, which scrolling doesn't change. */
function measureItems(
  order: readonly string[],
  elementByKey: ReadonlyMap<string | null, HTMLElement>,
  scroller: HTMLElement | null,
) {
  const origin = scroller === null ? 0 : scroller.getBoundingClientRect().top;
  const scrolled = scroller === null ? 0 : scroller.scrollTop;
  return {
    order,
    bounds: order.map((key) => {
      const box = elementByKey.get(key)!.getBoundingClientRect();
      return { start: box.top - origin + scrolled, size: box.height };
    }),
  };
}

function listItems(list: HTMLElement, attribute: string) {
  return new Map(
    Array.from(list.querySelectorAll<HTMLElement>(`[${attribute}]`)).map(
      (element) => [element.getAttribute(attribute), element] as const,
    ),
  );
}

// A drag owns the row, not its controls: a press on a button, a link or the
// rename box stays theirs, and so does a child thread's row under its parent.
const NOT_A_DRAG_HANDLE = "button, a, input, textarea";

/**
 * The inbox's live list. Owns the drag so its frames redraw only the rows that
 * move: the sidebar around it, and the rows themselves, don't render for them.
 */
export function InboxLiveList(props: {
  readonly reorder: InboxReorder | null;
  readonly groupReorder: InboxGroupReorder | null;
  /** Changes when a row's place or height does, which cancels a drag in progress. */
  readonly layoutKey: string;
  readonly children: ReactNode;
}) {
  const { reorder, groupReorder, layoutKey } = props;
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollContainer = () =>
    listRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
  const { drag, beginDrag, suppressDragClick } = usePointerDragReorder<string>({
    axis: "y",
    measure: (threadKey) => {
      const list = listRef.current;
      if (list === null || reorder === null) return null;
      const elementByKey = listItems(list, "data-inbox-reorder-row");
      return measureItems(
        reorder.peersOf(threadKey).filter((key) => elementByKey.has(key)),
        elementByKey,
        scrollContainer(),
      );
    },
    onReorder: reorder?.onMove,
    layoutKey,
    scrollContainer,
  });
  const groupDragListHeightRef = useRef(0);
  const groupDrag = usePointerDragReorder<string>({
    axis: "y",
    measure: (groupKey) => {
      const list = listRef.current;
      if (list === null) return null;
      groupDragListHeightRef.current = list.offsetHeight;
      const elementByKey = listItems(list, "data-inbox-reorder-group");
      const measured = measureItems(
        [...elementByKey.keys()].flatMap((key) => (key === null ? [] : [key])),
        elementByKey,
        scrollContainer(),
      );
      // The held group rides as just its header, so a long one doesn't cover the
      // list. Everything after it moves up by what that takes away.
      const from = measured.order.indexOf(groupKey);
      const own = measured.bounds[from];
      const header = elementByKey
        .get(groupKey)
        ?.querySelector("[data-inbox-group-header]")
        ?.getBoundingClientRect().height;
      if (own === undefined || header === undefined) return measured;
      return {
        order: measured.order,
        bounds: measured.bounds.map((box, index) =>
          index === from
            ? { start: box.start, size: header }
            : index > from
              ? { start: box.start - (own.size - header), size: box.size }
              : box,
        ),
      };
    },
    onReorder: groupReorder?.onMove,
    layoutKey,
    scrollContainer,
  });

  // A card already open would sit over the row being moved.
  const hoverCard = useThreadHoverCardHandle();
  const dragging = drag !== null || groupDrag.drag !== null;
  useEffect(() => {
    if (dragging) hoverCard?.close();
  }, [dragging, hoverCard]);

  const context = useMemo<InboxDragContextValue | null>(
    () =>
      reorder === null
        ? null
        : {
            visualOf: (threadKey) => dragReorderVisual(drag, threadKey),
            beginDrag,
            suppressDragClick,
          },
    [beginDrag, drag, reorder, suppressDragClick],
  );
  const groupContext = useMemo<InboxDragContextValue | null>(
    () =>
      groupReorder === null
        ? null
        : {
            visualOf: (groupKey) => dragReorderVisual(groupDrag.drag, groupKey),
            beginDrag: groupDrag.beginDrag,
            suppressDragClick: groupDrag.suppressDragClick,
          },
    [groupDrag.beginDrag, groupDrag.drag, groupDrag.suppressDragClick, groupReorder],
  );

  return (
    <InboxGroupDragContext.Provider value={groupContext}>
      <InboxDragContext.Provider value={context}>
        <ul
          ref={listRef}
          data-testid="inbox-thread-list"
          data-inbox-live-list
          // Rows ignore the pointer while one rides it: no hover fills or cards
          // firing underneath, and the list itself shows the grab.
          className={cn(dragging && "cursor-grabbing [&>*]:pointer-events-none")}
          // A group riding as its header leaves the list shorter. Holding the
          // height keeps the scroller from jumping, during the drag or after a cancel.
          {...(groupDrag.drag !== null
            ? { style: { minHeight: groupDragListHeightRef.current } }
            : {})}
        >
          {props.children}
        </ul>
      </InboxDragContext.Provider>
    </InboxGroupDragContext.Provider>
  );
}

/** How an item being dragged, or sliding out of its way, draws itself. */
function dragItemProps(visual: DragReorderVisual | null) {
  return {
    "data-dragging": visual?.kind === "dragged" ? "true" : undefined,
    className: cn(
      "relative",
      // The held item rides over its neighbours; everyone else slides. It only
      // transitions while settling: under the pointer it must track, not chase.
      // Its fill is see-through on its own, so it's laid over the sidebar's: what
      // it passes over must not show through.
      visual?.kind === "dragged" &&
        "z-10 rounded-md bg-sidebar bg-linear-to-b from-sidebar-accent to-sidebar-accent shadow-md",
      visual !== null &&
        (visual.kind === "shifted" || visual.settling) &&
        "transition-transform duration-150 ease-out",
    ),
    ...(visual ? { style: { transform: `translateY(${visual.offset}px)` } } : {}),
  };
}

/**
 * A group's header and everything under it, moving as one while the list is
 * grouped. The header is the handle: its whole row folds the group on a click,
 * and the travel a drag needs is what tells the two apart. Mouse and pen only,
 * since a finger on a header is scrolling; the header's press-and-hold menu has
 * Move up and Move down.
 */
export function InboxReorderGroup(props: {
  readonly groupKey: string;
  readonly children: ReactNode;
}) {
  const context = useContext(InboxGroupDragContext);
  if (context === null) {
    return <>{props.children}</>;
  }
  const { groupKey } = props;
  const visual = context.visualOf(groupKey);
  const itemProps = dragItemProps(visual);
  return (
    <li
      data-inbox-reorder-group={groupKey}
      {...itemProps}
      className={cn(
        itemProps.className,
        // Riding as its header; see the measure above. The rows stay mounted.
        visual?.kind === "dragged" && "[&>ul>*:not([data-inbox-group-header])]:hidden",
      )}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!(event.target as Element).closest("[data-inbox-group-header]")) return;
        context.beginDrag(groupKey, event);
      }}
      onClickCapture={context.suppressDragClick}
      onDragStart={(event) => event.preventDefault()}
    >
      <ul>{props.children}</ul>
    </li>
  );
}

/**
 * One top-level row and the child rows under it, moving as one while the custom
 * order is on. Otherwise it draws nothing of its own. Mouse and pen only: a
 * finger's swipes and press-and-hold menu already belong to the row, and the
 * menu's Move up and Move down are how a phone reorders.
 */
export function InboxReorderRow(props: {
  readonly threadKey: string;
  readonly children: ReactNode;
}) {
  const context = useContext(InboxDragContext);
  if (context === null) {
    return <>{props.children}</>;
  }
  const { threadKey } = props;
  return (
    <li
      data-inbox-reorder-row={threadKey}
      {...dragItemProps(context.visualOf(threadKey))}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") return;
        // Cmd, Ctrl and Shift clicks select rows.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.target as Element;
        if (target.closest(NOT_A_DRAG_HANDLE) || !target.closest("[data-inbox-live-row]")) return;
        context.beginDrag(threadKey, event);
      }}
      onClickCapture={context.suppressDragClick}
      // A project's picture would otherwise start the browser's own image drag.
      onDragStart={(event) => event.preventDefault()}
    >
      <ul>{props.children}</ul>
    </li>
  );
}
