/**
 * Find in chat: the bar over the top right of the chat list, and everything
 * behind it while it is open. Mounted by MessagesTimeline, opened through
 * chatFindStore (the chat.find keybinding, the command palette).
 *
 * Counting reads every findable row's text (chatFindRows), built a slice at a
 * time so a long chat never stalls a frame and cached per message so it is
 * built once. Painting and jumping work on the rows the list has drawn
 * (chatFindDom, timelineReveal). Every async step checks it still belongs to
 * the open bar and the current query before it acts.
 */
import type { LegendListRef } from "@legendapp/list/react";
import type { SideTurnId } from "@threadlines/contracts";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useChatFindStore } from "../../../chatFindStore";
import { FindBar, type FindBarTally, findStepFromKey } from "../../FindBar";
import { resolveFindShortcutOwner } from "../../../lib/findShortcutOwner";
import type { MessagesTimelineRow } from "../MessagesTimeline.logic";
import { revealTimelineRow, scrollRectIntoTimelineView } from "../timelineReveal";
import {
  carryChatFindMatch,
  type ChatFindMatch,
  type ChatFindResult,
  type ChatFindRow,
  chatFindMatchNumber,
  createChatFindPattern,
  EMPTY_CHAT_FIND_RESULT,
  sameChatFindMatch,
  searchChatFindRows,
  stepChatFindMatch,
} from "./chatFindModel";
import { ChatFindPainter, staticRangeRect } from "./chatFindDom";
import { FIND_FOLDED_ATTRIBUTE } from "./chatFindText";
import { type ChatFindRowContext, chatFindContextKey, findableRowBlocks } from "./chatFindRows";

/** Typing settles this long before a query is searched. */
const QUERY_DEBOUNCE_MS = 100;
/** A slice of row reading runs this long before yielding the frame. */
const INDEX_SLICE_MS = 8;
/** Rows changing under an open bar (an agent writing) re-read at most this often. */
const INDEX_REFRESH_MS = 250;
/** Where a jumped-to row is aimed, from the top of the list. */
const MATCH_VIEW_POSITION = 0.3;
/** Room kept between the bar and a match scrolled under it. */
const BAR_CLEARANCE_PX = 12;
const BOTTOM_CLEARANCE_PX = 32;
const ROW_SCROLL_ATTEMPTS = 4;
const ROW_RENDER_ATTEMPTS = 60;
/** Frames a jumped-to match is re-aimed at while its row settles. */
const SETTLE_FRAMES = 3;

export interface ChatFindProps {
  /** The rows the list draws, in order. */
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  /** The rows find searches: `rows` plus any side answer folded out of them. */
  readonly findRows: ReadonlyArray<MessagesTimelineRow>;
  readonly rowContext: ChatFindRowContext;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** Opens a folded row (a long message, a plan), as a click would. */
  readonly onOpenRow: (rowId: string) => void;
  /** Opens a side answer folded to its status line. */
  readonly onOpenSideExchange: (sideTurnId: SideTurnId) => void;
  /** Stops the list following new output: the reader is looking back. */
  readonly onStopFollowing: () => void;
}

export function ChatFind(props: ChatFindProps) {
  const open = useChatFindStore((state) => state.open);
  const close = useChatFindStore((state) => state.close);
  // The bar belongs to this chat: it closes when the chat goes.
  useEffect(() => close, [close]);
  return open ? <ChatFindSession {...props} /> : null;
}

interface IndexedRows {
  readonly source: ReadonlyArray<MessagesTimelineRow>;
  readonly contextKey: string;
  readonly rows: ReadonlyArray<ChatFindRow>;
}

/**
 * Reads every findable row's text, a slice at a time. Null until the first
 * read completes; afterwards the last completed read, refreshed (at most every
 * INDEX_REFRESH_MS) as rows change.
 */
function useIndexedRows(
  findRows: ReadonlyArray<MessagesTimelineRow>,
  rowContext: ChatFindRowContext,
): IndexedRows | null {
  const [indexed, setIndexed] = useState<IndexedRows | null>(null);
  const lastBuiltAtRef = useRef(0);
  const contextKey = chatFindContextKey(rowContext);
  useEffect(() => {
    if (indexed?.source === findRows && indexed.contextKey === contextKey) return;
    let cancelled = false;
    let timer: number | null = null;
    const built: ChatFindRow[] = [];
    let next = 0;
    const slice = () => {
      timer = null;
      if (cancelled) return;
      const deadline = performance.now() + INDEX_SLICE_MS;
      while (next < findRows.length) {
        const row = findRows[next]!;
        next += 1;
        const blocks = findableRowBlocks(row, rowContext, contextKey);
        if (blocks !== null && blocks.length > 0) built.push({ id: row.id, blocks });
        if (performance.now() >= deadline) {
          timer = window.setTimeout(slice, 0);
          return;
        }
      }
      lastBuiltAtRef.current = performance.now();
      setIndexed({ source: findRows, contextKey, rows: built });
    };
    // The first read starts at once; a refresh waits out the agent's typing.
    const wait =
      indexed === null
        ? 0
        : Math.max(0, lastBuiltAtRef.current + INDEX_REFRESH_MS - performance.now());
    timer = window.setTimeout(slice, wait);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [contextKey, findRows, indexed, rowContext]);
  return indexed;
}

/** Text the reader selected in the chat list, to search for. */
export function selectedChatText(container: Element | null): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) return null;
  const anchor = selection.getRangeAt(0).commonAncestorContainer;
  return container.contains(anchor) ? selection.toString() : null;
}

function ChatFindSession(props: ChatFindProps) {
  const { rows, findRows, rowContext, listRef, containerRef } = props;
  const query = useChatFindStore((state) => state.query);
  const setQuery = useChatFindStore((state) => state.setQuery);
  const close = useChatFindStore((state) => state.close);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Focus goes back where it was when the bar closes.
  const returnFocusRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current = active && active !== document.body ? active : null;
    const bar = barRef.current;
    return () => {
      // Runs before the bar leaves the page, so focus may still be in it.
      const target = returnFocusRef.current;
      const focus = document.activeElement;
      const focusGoesWithBar =
        focus === null ||
        focus === document.body ||
        !focus.isConnected ||
        (bar !== null && bar.contains(focus));
      if (focusGoesWithBar && target instanceof HTMLElement && target.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, []);
  // The field takes focus on opening and on every later open request (Cmd+F
  // pressed again while the bar is open).
  useEffect(() => {
    const focusField = () => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    };
    focusField();
    return useChatFindStore.subscribe((state, previous) => {
      if (state.focusRequest !== previous.focusRequest) focusField();
    });
  }, []);

  const [searchedQuery, setSearchedQuery] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchedQuery(query), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const pattern = useMemo(() => createChatFindPattern(searchedQuery), [searchedQuery]);

  const indexed = useIndexedRows(findRows, rowContext);
  const result = useMemo<ChatFindResult>(
    () => (pattern && indexed ? searchChatFindRows(indexed.rows, pattern) : EMPTY_CHAT_FIND_RESULT),
    [indexed, pattern],
  );

  // The painter paints the drawn matches for as long as the bar is open.
  const painterRef = useRef<ChatFindPainter | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const painter = new ChatFindPainter(container);
    painterRef.current = painter;
    return () => {
      painter.dispose();
      painterRef.current = null;
    };
  }, [containerRef]);
  useEffect(() => {
    painterRef.current?.setPattern(pattern);
  }, [pattern]);

  // Read by jumps that outlive a render (rows move while the list scrolls),
  // and the timeline's callbacks, read when a jump runs rather than captured.
  const rowsRef = useRef(rows);
  const findRowsRef = useRef(findRows);
  const callbacksRef = useRef(props);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    findRowsRef.current = findRows;
    callbacksRef.current = props;
  });

  const [current, setCurrentState] = useState<ChatFindMatch | null>(null);
  const currentRef = useRef<ChatFindMatch | null>(null);
  const setCurrent = useCallback((match: ChatFindMatch | null) => {
    currentRef.current = match;
    setCurrentState(match);
  }, []);
  /** A jump waiting for its row to be drawn (a side answer being opened). */
  const pendingJumpRef = useRef<ChatFindMatch | null>(null);
  const cancelJumpRef = useRef<(() => void) | null>(null);
  /**
   * Bumped whenever a jump is replaced or abandoned (a new jump, a new query,
   * the bar closing): a scroll or a paint still in flight for an older one
   * checks it and stands down.
   */
  const navigationRef = useRef(0);
  const cancelNavigation = useCallback(() => {
    navigationRef.current += 1;
    cancelJumpRef.current?.();
    cancelJumpRef.current = null;
    pendingJumpRef.current = null;
  }, []);

  const settleOnMatch = useCallback(
    (range: StaticRange) => {
      const navigation = navigationRef.current;
      let frames = SETTLE_FRAMES;
      const settle = () => {
        if (navigationRef.current !== navigation) return;
        const rect = staticRangeRect(range);
        if (!rect) return;
        const barBottom = barRef.current?.getBoundingClientRect().bottom ?? 0;
        const listTop = listRef.current?.getScrollableNode?.()?.getBoundingClientRect().top ?? 0;
        scrollRectIntoTimelineView(listRef.current, rect, {
          viewPosition: MATCH_VIEW_POSITION,
          topInsetPx: Math.max(0, barBottom - listTop) + BAR_CLEARANCE_PX,
          bottomInsetPx: BOTTOM_CLEARANCE_PX,
        });
        frames -= 1;
        if (frames > 0) window.requestAnimationFrame(settle);
      };
      settle();
    },
    [listRef],
  );

  /** Brings `match` on screen and paints it as current. */
  const jumpTo = useCallback(
    (match: ChatFindMatch) => {
      cancelNavigation();
      const navigation = navigationRef.current;
      const settleIfCurrent = (range: StaticRange) => {
        if (navigationRef.current === navigation) settleOnMatch(range);
      };
      const painter = painterRef.current;
      const findRow = findRowsRef.current.find((row) => row.id === match.rowId);
      if (!painter || !findRow) return;
      const callbacks = callbacksRef.current;
      callbacks.onStopFollowing();
      const drawnIndex = rowsRef.current.findIndex((row) => row.id === match.rowId);
      if (drawnIndex < 0) {
        // Folded out of the list (a side answer still being written): open
        // its exchange, and jump once the list draws it.
        if (findRow.kind === "message" && findRow.message.sideTurnId !== undefined) {
          callbacks.onOpenSideExchange(findRow.message.sideTurnId);
          pendingJumpRef.current = match;
        }
        return;
      }
      const container = containerRef.current;
      const drawn = container?.querySelector(`[data-timeline-row-id="${CSS.escape(match.rowId)}"]`);
      // A folded row opens to show the match; one not drawn yet may be folded.
      if (!drawn || drawn.querySelector(`[${FIND_FOLDED_ATTRIBUTE}]`) !== null) {
        callbacks.onOpenRow(match.rowId);
      }
      if (drawn) {
        painter.refreshRow(match.rowId);
        painter.setCurrent(match, settleIfCurrent);
        return;
      }
      painter.setCurrent(match, null);
      cancelJumpRef.current = revealTimelineRow({
        getList: () => listRef.current,
        resolveIndex: () => rowsRef.current.findIndex((row) => row.id === match.rowId),
        findRow: () =>
          containerRef.current?.querySelector<HTMLElement>(
            `[data-timeline-row-id="${CSS.escape(match.rowId)}"]`,
          ) ?? null,
        viewPosition: MATCH_VIEW_POSITION,
        animated: () => false,
        scrollAttempts: ROW_SCROLL_ATTEMPTS,
        renderAttempts: ROW_RENDER_ATTEMPTS,
        onRow: () => {
          if (navigationRef.current !== navigation) return;
          painterRef.current?.refreshRow(match.rowId);
          painterRef.current?.setCurrent(match, settleIfCurrent);
        },
      });
    },
    [cancelNavigation, containerRef, listRef, settleOnMatch],
  );
  // Typing a new query abandons the jump to the old one's match; so does
  // closing the bar.
  useEffect(() => {
    const unsubscribe = useChatFindStore.subscribe((state, previous) => {
      if (state.query !== previous.query) cancelNavigation();
    });
    return () => {
      unsubscribe();
      cancelNavigation();
    };
  }, [cancelNavigation]);

  // A pending jump goes ahead once its row is in the list.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (pending === null || !rows.some((row) => row.id === pending.rowId)) return;
    jumpTo(pending);
  }, [jumpTo, rows]);

  // A new query lands on the first match from the top of the screen down;
  // the same query with new results keeps the current match where it is.
  const lastResultRef = useRef<{
    readonly pattern: RegExp | null;
    readonly result: ChatFindResult;
  }>({
    pattern: null,
    result: EMPTY_CHAT_FIND_RESULT,
  });
  useEffect(() => {
    // Nothing is known before the chat has been read once.
    if (indexed === null) return;
    const last = lastResultRef.current;
    lastResultRef.current = { pattern, result };
    if (pattern === null || result.total === 0) {
      if (currentRef.current !== null) setCurrent(null);
      painterRef.current?.setCurrent(null, null);
      return;
    }
    // A new query lands on the first match from the top of the screen down,
    // unless the reader has typed on since (those results are already stale).
    if (last.pattern?.source !== pattern.source) {
      const first = firstMatchFromScreenTop(result, findRowsRef.current, containerRef.current);
      setCurrent(first);
      if (first && useChatFindStore.getState().query === searchedQuery) jumpTo(first);
      return;
    }
    // The first match of a query that had none (an agent just wrote it): it
    // becomes current where it is, without pulling the reader there.
    if (currentRef.current === null) {
      const first = firstMatchFromScreenTop(result, findRowsRef.current, containerRef.current);
      setCurrent(first);
      painterRef.current?.setCurrent(first, null);
      return;
    }
    const previous = currentRef.current;
    const carried = carryChatFindMatch({
      previous: last.result,
      next: result,
      current: previous,
      rowOrder: findRowsRef.current.map((row) => row.id),
    });
    if (!sameChatFindMatch(carried, previous)) {
      setCurrent(carried);
      painterRef.current?.setCurrent(carried, null);
    }
  }, [containerRef, indexed, jumpTo, pattern, result, searchedQuery, setCurrent]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const next = stepChatFindMatch(result, currentRef.current, direction);
      setCurrent(next);
      if (next) jumpTo(next);
    },
    [jumpTo, result, setCurrent],
  );

  // Next and previous from the keyboard while the chat, not the bar, has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (barRef.current?.contains(event.target as Node)) return;
      const direction = findStepFromKey(event);
      if (direction === null || resolveFindShortcutOwner() !== "chat") return;
      event.preventDefault();
      event.stopPropagation();
      step(direction);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [step]);

  // Pending while a query is being typed or the chat is still being read;
  // a refresh under the same query keeps showing the last count.
  const tally: FindBarTally | null =
    query.trim().length === 0
      ? null
      : query !== searchedQuery || indexed === null
        ? { kind: "pending" }
        : { kind: "matches", current: chatFindMatchNumber(result, current), total: result.total };

  return (
    <div ref={barRef} className="absolute top-2 right-3 z-20 max-w-[calc(100%-1.5rem)]">
      <FindBar
        query={query}
        onQueryChange={setQuery}
        onStep={step}
        onClose={close}
        tally={tally}
        placeholder="Find in chat"
        inputRef={inputRef}
        testIdPrefix="chat-find"
      />
    </div>
  );
}

/**
 * The first match at or below the top row on screen, else the first in the
 * chat: typing a query does not throw the reader back to the top of a long
 * chat when there is a match where they are reading.
 */
function firstMatchFromScreenTop(
  result: ChatFindResult,
  findRows: ReadonlyArray<MessagesTimelineRow>,
  container: HTMLElement | null,
): ChatFindMatch | null {
  const first = stepChatFindMatch(result, null, 1);
  if (!container || first === null) return first;
  const containerTop = container.getBoundingClientRect().top;
  let topRowId: string | null = null;
  for (const row of container.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    if (row.getBoundingClientRect().bottom > containerTop) {
      topRowId = row.getAttribute("data-timeline-row-id");
      break;
    }
  }
  if (topRowId === null) return first;
  const order = new Map(findRows.map((row, index) => [row.id, index]));
  const topIndex = order.get(topRowId) ?? -1;
  if (topIndex < 0) return first;
  const row = result.rows.find((candidate) => (order.get(candidate.id) ?? -1) >= topIndex);
  if (!row) return first;
  const blockIndex = row.blockCounts.findIndex((count) => count > 0);
  return { rowId: row.id, blockIndex, occurrence: 0 };
}
