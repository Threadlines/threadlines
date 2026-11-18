/**
 * Where each thread's chat was scrolled to when it was left, so coming back
 * (by tab, sidebar, palette, back or forward) opens it there instead of at
 * the end. In memory only, per window: a reload opens every chat at the end.
 *
 * What is kept is an anchor, not a pixel offset: the key of the row at the
 * top of the view and how far into that row the view starts. The chat is a
 * virtualized list whose rows change height and grow, so a raw scroll
 * position would land somewhere else.
 *
 * The timeline reads the anchor once when it mounts and writes it once when
 * it is left; nothing here runs while scrolling.
 */

/** The row at the top of the view, and how far into it the view starts. */
export interface ScrollAnchor {
  readonly rowKey: string;
  readonly offsetPx: number;
}

/** Threads remembered at once; the one left longest ago goes first. */
export const THREAD_SCROLL_MEMORY_LIMIT = 300;

// Insertion order is recency: a write moves the thread to the end.
const anchors = new Map<string, ScrollAnchor>();

/**
 * Keeps where `threadKey` was left, or forgets it (null): a chat left at the
 * end is not remembered, so it opens at the end and follows new output.
 */
export function rememberThreadScroll(threadKey: string, anchor: ScrollAnchor | null): void {
  anchors.delete(threadKey);
  if (anchor === null) return;
  anchors.set(threadKey, anchor);
  while (anchors.size > THREAD_SCROLL_MEMORY_LIMIT) {
    const oldest = anchors.keys().next().value;
    if (oldest === undefined) break;
    anchors.delete(oldest);
  }
}

/** Where `threadKey` was left, if it was left above the end. */
export function readThreadScroll(threadKey: string): ScrollAnchor | null {
  return anchors.get(threadKey) ?? null;
}

export function forgetThreadScroll(threadKey: string): void {
  anchors.delete(threadKey);
}

/** Where a list is, as the anchor is read from it. */
export interface ListPlace {
  /** The list is at its end (LegendList's own `isAtEnd`). */
  readonly isAtEnd: boolean;
  /** The key of the first row in view; undefined when there is none. */
  readonly firstRowKey: string | undefined;
  /**
   * How far the top of the view is below that row's top, in pixels, as drawn
   * on screen; undefined when the row is not drawn.
   */
  readonly viewTopBelowRowTop: number | undefined;
}

/** The anchor a list's place amounts to; null at the end or when it can't be read. */
export function anchorFromListPlace(place: ListPlace): ScrollAnchor | null {
  if (place.isAtEnd || place.firstRowKey === undefined) return null;
  const offset = place.viewTopBelowRowTop;
  if (offset === undefined || !Number.isFinite(offset)) return null;
  return { rowKey: place.firstRowKey, offsetPx: Math.max(0, Math.round(offset)) };
}

/** How a chat opens: at the end (following it), or at a remembered row. */
export type InitialScroll =
  | { readonly kind: "end" }
  | { readonly kind: "anchor"; readonly index: number; readonly offsetPx: number };

/**
 * Where a chat opens when it is opened. A find target is handled before
 * this. The end, and the anchor forgotten, when:
 * - nothing was remembered (it was left at the end, or never left);
 * - the thread has something new to show (`hasNews`: an unseen completion or
 *   failure, or a status that needs the user), since opening it marks it seen;
 * - the remembered row is gone (a revert, a rewrite).
 */
export function initialScrollForThread(input: {
  readonly threadKey: string;
  readonly hasNews: boolean;
  readonly indexOfRowKey: (rowKey: string) => number;
}): InitialScroll {
  const anchor = readThreadScroll(input.threadKey);
  if (anchor === null) return { kind: "end" };
  const index = input.hasNews ? -1 : input.indexOfRowKey(anchor.rowKey);
  if (index < 0) {
    forgetThreadScroll(input.threadKey);
    return { kind: "end" };
  }
  return { kind: "anchor", index, offsetPx: anchor.offsetPx };
}
