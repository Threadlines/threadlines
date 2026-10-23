import { useLayoutEffect, useRef, useState } from "react";

/**
 * The live list's "Show N more…" line: 20px controls under `pt-1 pb-1.5`.
 * Room is kept for it so the fold lands inside the column, not below it.
 */
const INBOX_FOLD_LINE_PX = 30;

/**
 * What the inbox column measures. None of it depends on how many live rows
 * the fold shows, so a fold limit worked out from it never chases its own
 * result (see `resolveInboxLiveFoldLimit`). Each is null until measured.
 */
export interface InboxColumnMeasures {
  /**
   * The live list's own height, scope menu to fold line: what it needs to
   * show without scrolling. The open Wrapped shelf leaves it that much, or
   * half the column if that is more.
   */
  readonly liveContentHeight: number | null;
  /**
   * The column's height for live rows: under the scope menu, drafts and
   * link requests, above the fold line and the Wrapped shelf's header.
   * Measured as if the shelf were closed even while it is open, so opening
   * it scrolls the list instead of folding rows away. Null while no live
   * list is drawn.
   */
  readonly liveRoomPx: number | null;
  /**
   * The heights of the kinds of live row: a plain row, a family's row (with
   * its summary line), and a family's shown children, on this computer and
   * on another (one line taller: it names the computer). Each is the last
   * one seen, so it stays put while none of its kind is drawn; null until
   * one has been.
   */
  readonly plainRowPx: number | null;
  readonly familyRowPx: number | null;
  readonly localChildRowPx: number | null;
  readonly remoteChildRowPx: number | null;
  /** A group header's height, the last one seen; null until one has been. */
  readonly groupHeaderPx: number | null;
  /** The tallest drawn Wrapped row; null while the shelf draws none. */
  readonly doneRowPx: number | null;
}

export interface InboxColumnLayout extends InboxColumnMeasures {
  /** Ref for the whole column under the search field, live list and shelf together. */
  readonly columnRef: (element: HTMLElement | null) => void;
  /**
   * Ref for the live list's scrolling content, which holds the
   * `data-inbox-live-list` list: `data-inbox-live-row` rows ("plain" or
   * "family"), `data-inbox-child-row` rows ("local" or "remote") and
   * `data-inbox-group-header` headers.
   */
  readonly liveContentRef: (element: HTMLElement | null) => void;
  /**
   * Ref for the Wrapped shelf, absent without wrapped threads: its
   * `data-inbox-shelf-header` header and `data-inbox-done-row` rows.
   */
  readonly shelfRef: (element: HTMLElement | null) => void;
}

const UNMEASURED: InboxColumnMeasures = {
  liveContentHeight: null,
  liveRoomPx: null,
  plainRowPx: null,
  familyRowPx: null,
  localChildRowPx: null,
  remoteChildRowPx: null,
  groupHeaderPx: null,
  doneRowPx: null,
};

function measuresEqual(left: InboxColumnMeasures, right: InboxColumnMeasures): boolean {
  return (
    left.liveContentHeight === right.liveContentHeight &&
    left.liveRoomPx === right.liveRoomPx &&
    left.plainRowPx === right.plainRowPx &&
    left.familyRowPx === right.familyRowPx &&
    left.localChildRowPx === right.localChildRowPx &&
    left.remoteChildRowPx === right.remoteChildRowPx &&
    left.groupHeaderPx === right.groupHeaderPx &&
    left.doneRowPx === right.doneRowPx
  );
}

function shortestHeight(elements: Iterable<HTMLElement>): number | null {
  let shortest: number | null = null;
  for (const element of elements) {
    const height = element.offsetHeight;
    if (height > 0 && (shortest === null || height < shortest)) shortest = height;
  }
  return shortest;
}

/**
 * Measures the inbox column. Re-measures when the window resizes, the list's
 * content or the shelf changes, or one of the measured parts mounts.
 */
export function useInboxColumnLayout(): InboxColumnLayout {
  const [measures, setMeasures] = useState(UNMEASURED);
  // Elements in state, not refs: the inbox mounts and unmounts as the
  // sidebar switches lists, and the shelf comes and goes with wrapped threads.
  const [column, columnRef] = useState<HTMLElement | null>(null);
  const [liveContent, liveContentRef] = useState<HTMLElement | null>(null);
  const [shelf, shelfRef] = useState<HTMLElement | null>(null);
  // The last height seen of each kind of row: a kind with nothing drawn
  // keeps its height, so the fold never depends on what it shows.
  const seenRef = useRef({
    plainRowPx: null as number | null,
    familyRowPx: null as number | null,
    localChildRowPx: null as number | null,
    remoteChildRowPx: null as number | null,
    groupHeaderPx: null as number | null,
  });

  useLayoutEffect(() => {
    if (column === null || liveContent === null) return;
    const measure = () => {
      const list = liveContent.querySelector<HTMLElement>("[data-inbox-live-list]");
      const seen = seenRef.current;
      let liveRoomPx: number | null = null;
      if (list !== null) {
        const remember = (key: keyof typeof seen, selector: string) => {
          seen[key] = shortestHeight(list.querySelectorAll<HTMLElement>(selector)) ?? seen[key];
        };
        remember("plainRowPx", '[data-inbox-live-row="plain"]');
        remember("familyRowPx", '[data-inbox-live-row="family"]');
        remember("localChildRowPx", '[data-inbox-child-row="local"]');
        remember("remoteChildRowPx", '[data-inbox-child-row="remote"]');
        remember("groupHeaderPx", "[data-inbox-group-header]");
        const listTop = list.getBoundingClientRect().top - liveContent.getBoundingClientRect().top;
        // The content's own bottom padding keeps the fold line clear of
        // the fade over the shelf.
        const bottomPadding = Number.parseFloat(getComputedStyle(liveContent).paddingBottom) || 0;
        const shelfHeaderPx =
          shelf?.querySelector<HTMLElement>("[data-inbox-shelf-header]")?.offsetHeight ?? 0;
        liveRoomPx =
          column.clientHeight - shelfHeaderPx - listTop - INBOX_FOLD_LINE_PX - bottomPadding;
      }
      let doneRowPx: number | null = null;
      for (const row of shelf?.querySelectorAll<HTMLElement>("[data-inbox-done-row]") ?? []) {
        if (row.offsetHeight > (doneRowPx ?? 0)) doneRowPx = row.offsetHeight;
      }
      const next: InboxColumnMeasures = {
        liveContentHeight: liveContent.offsetHeight,
        liveRoomPx,
        ...seen,
        doneRowPx,
      };
      setMeasures((current) => (measuresEqual(current, next) ? current : next));
    };
    // First measure before paint, so the list never shows a frame folded at
    // the old count; the observer takes it from there.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(liveContent);
    if (shelf !== null) observer.observe(shelf);
    return () => observer.disconnect();
  }, [column, liveContent, shelf]);

  return { ...measures, columnRef, liveContentRef, shelfRef };
}
