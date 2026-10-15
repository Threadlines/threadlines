/**
 * Find in chat on screen: the matches in the rows the list has drawn, painted
 * with the CSS Custom Highlight API (no DOM is changed, nothing re-renders).
 *
 * Paint only. Counts come from chatFindText's model of each row, never from
 * here: a folded plan, a long message's preview or a reply still typing out
 * shows only part of its text. This file groups drawn text exactly as that
 * model groups it (each text node belongs to its nearest FIND_BLOCK_TAGS
 * element, else to its body), so the n-th match of a block here is the n-th
 * match the model counted there.
 */
import {
  FIND_BLOCK_TAGS,
  FIND_BODY_ATTRIBUTE,
  FIND_FOLDED_ATTRIBUTE,
  FIND_IGNORE_ATTRIBUTE,
  SCREEN_READER_ONLY_CLASS,
} from "./chatFindText";
import { type ChatFindMatch, findPatternSpans } from "./chatFindModel";

export const CHAT_FIND_MATCH_HIGHLIGHT = "threadlines-chat-find-match";
export const CHAT_FIND_CURRENT_HIGHLIGHT = "threadlines-chat-find-current";

const ROW_SELECTOR = "[data-timeline-row-id]";
const BODY_SELECTOR = `[${FIND_BODY_ATTRIBUTE}]`;
const BLOCK_SELECTOR = [...FIND_BLOCK_TAGS].join(",");
const IGNORED_SELECTOR = `[${FIND_IGNORE_ATTRIBUTE}], .${SCREEN_READER_ONLY_CLASS}, svg, script, style, template`;
/** A row still typing out repaints at most this often. */
const STREAMING_REPAINT_MS = 250;

interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

function highlightRegistry(): HighlightRegistry | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  return registry && typeof globalThis.Highlight === "function" ? registry : null;
}

/** One piece of a block's text: a text node, or a line break a `<br>` draws. */
interface TextPiece {
  readonly node: Text | null;
  readonly start: number;
  readonly end: number;
}

/** The text of one block as drawn, with where each piece of it lives. */
interface DrawnBlock {
  readonly text: string;
  readonly pieces: ReadonlyArray<TextPiece>;
}

/** Every block a drawn row shows to find, in reading order (see chatFindText). */
export function readDrawnBlocks(row: Element): DrawnBlock[] {
  const blocks: DrawnBlock[] = [];
  for (const body of row.querySelectorAll<HTMLElement>(BODY_SELECTOR)) {
    const groups = new Map<Element, { text: string; pieces: TextPiece[] }>();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        const element = node instanceof Element ? node : node.parentElement;
        const ignored = element?.closest(IGNORED_SELECTOR);
        if (ignored && body.contains(ignored)) {
          return NodeFilter.FILTER_REJECT;
        }
        return node instanceof Text || (node instanceof HTMLElement && node.tagName === "BR")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node instanceof Text ? node.parentElement : (node as Element).parentElement;
      const nearest = parent?.closest(BLOCK_SELECTOR);
      const block = nearest && body.contains(nearest) ? nearest : body;
      const group = groups.get(block) ?? { text: "", pieces: [] };
      if (!groups.has(block)) groups.set(block, group);
      const value = node instanceof Text ? node.data : "\n";
      if (value.length === 0) continue;
      group.pieces.push({
        node: node instanceof Text ? node : null,
        start: group.text.length,
        end: group.text.length + value.length,
      });
      group.text += value;
    }
    for (const group of groups.values()) {
      if (group.text.trim().length > 0) blocks.push(group);
    }
  }
  return blocks;
}

function pieceAt(pieces: ReadonlyArray<TextPiece>, offset: number, edge: "start" | "end") {
  return pieces.find(
    (piece) =>
      piece.node !== null &&
      (edge === "start"
        ? piece.start <= offset && offset < piece.end
        : piece.start < offset && offset <= piece.end),
  );
}

/**
 * Static ranges, so painting survives the streaming reveal: it rewrites a
 * text node's whole contents every frame, which would collapse a live Range,
 * but only ever grows the shown text, so earlier offsets stay valid.
 */
function blockRanges(block: DrawnBlock, pattern: RegExp): StaticRange[] {
  const ranges: StaticRange[] = [];
  for (const span of findPatternSpans(block.text, pattern)) {
    const start = pieceAt(block.pieces, span.start, "start");
    const end = pieceAt(block.pieces, span.end, "end");
    if (!start?.node || !end?.node) continue;
    ranges.push(
      new StaticRange({
        startContainer: start.node,
        startOffset: span.start - start.start,
        endContainer: end.node,
        endOffset: span.end - end.start,
      }),
    );
  }
  return ranges;
}

/** One row's painted matches, by block. */
interface PaintedRow {
  readonly rowId: string;
  readonly blocks: ReadonlyArray<ReadonlyArray<StaticRange>>;
  readonly paintedAt: number;
}

/**
 * Keeps the drawn matches painted while find is open with a query: rows the
 * list draws or rewrites are repainted on the next frame (a row still typing
 * out, at most every STREAMING_REPAINT_MS), and nothing runs while nothing
 * changes. Without the Highlight API it paints nothing; counts and jumps
 * still work.
 */
export class ChatFindPainter {
  private readonly registry = highlightRegistry();
  private readonly matchHighlight: Highlight | null;
  private readonly currentHighlight: Highlight | null;
  private readonly rows = new Map<Element, PaintedRow>();
  private readonly dirty = new Set<Element>();
  private observer: MutationObserver | null = null;
  private frame: number | null = null;
  private timer: number | null = null;
  private pattern: RegExp | null = null;
  private current: ChatFindMatch | null = null;
  private onCurrentPainted: ((range: StaticRange) => void) | null = null;

  constructor(private readonly container: HTMLElement) {
    this.matchHighlight = this.registry ? new Highlight() : null;
    this.currentHighlight = this.registry ? new Highlight() : null;
    if (this.currentHighlight) this.currentHighlight.priority = 1;
  }

  /** Starts painting `pattern`; null stops and clears everything. */
  setPattern(pattern: RegExp | null): void {
    if (pattern?.source === this.pattern?.source) return;
    this.pattern = pattern;
    this.clearPaint();
    if (pattern === null) {
      this.disconnect();
      return;
    }
    this.connect();
    for (const row of this.container.querySelectorAll(ROW_SELECTOR)) this.dirty.add(row);
    this.flush();
  }

  /**
   * Marks `match` as the current one. `onPainted` gets its range once the row
   * holding it has been drawn far enough to show it (fully expanded, its
   * streamed text revealed), whenever that is.
   */
  setCurrent(match: ChatFindMatch | null, onPainted: ((range: StaticRange) => void) | null): void {
    this.current = match;
    this.onCurrentPainted = onPainted;
    this.paintCurrent();
  }

  /** Rereads one row now (it was just expanded, or the reader is waiting on it). */
  refreshRow(rowId: string): void {
    const row = this.findRow(rowId);
    if (!row) return;
    this.dirty.add(row);
    this.lastPaint(row, 0);
    this.scheduleFlush();
  }

  dispose(): void {
    this.disconnect();
    this.clearPaint();
    this.pattern = null;
  }

  private findRow(rowId: string): Element | null {
    return this.container.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
  }

  private lastPaint(row: Element, paintedAt: number) {
    const painted = this.rows.get(row);
    if (painted) this.rows.set(row, { ...painted, paintedAt });
  }

  private connect() {
    if (this.observer || !this.registry) return;
    this.registry.set(CHAT_FIND_MATCH_HIGHLIGHT, this.matchHighlight!);
    this.registry.set(CHAT_FIND_CURRENT_HIGHLIGHT, this.currentHighlight!);
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const row = target?.closest(ROW_SELECTOR);
        if (row) this.dirty.add(row);
        for (const added of record.addedNodes) {
          if (!(added instanceof Element)) continue;
          if (added.matches(ROW_SELECTOR)) this.dirty.add(added);
          for (const inner of added.querySelectorAll(ROW_SELECTOR)) this.dirty.add(inner);
        }
      }
      this.scheduleFlush();
    });
    this.observer.observe(this.container, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-timeline-row-id"],
    });
  }

  private disconnect() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.frame = null;
    this.timer = null;
    this.dirty.clear();
    if (this.registry) {
      this.registry.delete(CHAT_FIND_MATCH_HIGHLIGHT);
      this.registry.delete(CHAT_FIND_CURRENT_HIGHLIGHT);
    }
  }

  private clearPaint() {
    this.rows.clear();
    this.matchHighlight?.clear();
    this.currentHighlight?.clear();
  }

  private scheduleFlush() {
    if (this.frame !== null || this.pattern === null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush() {
    const pattern = this.pattern;
    if (pattern === null) return;
    const now = performance.now();
    let waitMs: number | null = null;
    for (const row of this.dirty) {
      const painted = this.rows.get(row);
      if (!row.isConnected) {
        this.dirty.delete(row);
        this.unpaint(row);
        continue;
      }
      const sinceLast = painted ? now - painted.paintedAt : Number.POSITIVE_INFINITY;
      if (sinceLast < STREAMING_REPAINT_MS) {
        waitMs = Math.min(waitMs ?? STREAMING_REPAINT_MS, STREAMING_REPAINT_MS - sinceLast);
        continue;
      }
      this.dirty.delete(row);
      this.paintRow(row, pattern, now);
    }
    // Rows the list dropped since the last pass.
    for (const row of this.rows.keys()) {
      if (!row.isConnected) this.unpaint(row);
    }
    this.paintCurrent();
    if (waitMs !== null && this.timer === null) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.flush();
      }, waitMs);
    }
  }

  private unpaint(row: Element) {
    const painted = this.rows.get(row);
    if (!painted) return;
    for (const ranges of painted.blocks) {
      for (const range of ranges) this.matchHighlight?.delete(range);
    }
    this.rows.delete(row);
  }

  private paintRow(row: Element, pattern: RegExp, now: number) {
    this.unpaint(row);
    const rowId = row.getAttribute("data-timeline-row-id");
    if (rowId === null) return;
    const blocks = readDrawnBlocks(row).map((block) => blockRanges(block, pattern));
    for (const ranges of blocks) {
      for (const range of ranges) this.matchHighlight?.add(range);
    }
    this.rows.set(row, { rowId, blocks, paintedAt: now });
  }

  private paintCurrent() {
    this.currentHighlight?.clear();
    const match = this.current;
    if (match === null || this.pattern === null) return;
    const row = this.findRow(match.rowId);
    // A folded row draws only part of its text, so its blocks do not line up
    // with the counted ones yet: the current match waits for it to open.
    if (!row || row.querySelector(`[${FIND_FOLDED_ATTRIBUTE}]`) !== null) return;
    const painted = this.rows.get(row);
    const range = painted?.blocks[match.blockIndex]?.[match.occurrence];
    if (!range) return;
    this.currentHighlight?.add(range);
    const onPainted = this.onCurrentPainted;
    this.onCurrentPainted = null;
    onPainted?.(range);
  }
}

/** Where a painted range sits on screen, for scrolling it into view. */
export function staticRangeRect(range: StaticRange): DOMRect | null {
  const live = document.createRange();
  try {
    live.setStart(range.startContainer, range.startOffset);
    live.setEnd(range.endContainer, range.endOffset);
  } catch {
    return null;
  }
  const rects = live.getClientRects();
  for (const rect of rects) {
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}
