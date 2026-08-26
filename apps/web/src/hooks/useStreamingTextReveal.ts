import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Reveals streamed assistant text at a steady per-frame pace instead of in the
 * 50 ms lumps the server flushes. The markdown keeps rendering the full text at
 * flush cadence; this hook masks the not-yet-shown tail straight in the DOM
 * (truncating text nodes, hiding trailing blocks), so nothing is re-parsed per
 * frame. The shown text trails the real text by roughly one flush so the edge
 * never runs dry between arrivals. Attach the ref to the element wrapping the
 * markdown body and pass the message's live flag. Returns whether a reveal is
 * still in flight so a caller can wait for the last characters to land.
 */
export function useStreamingTextReveal(
  containerRef: RefObject<HTMLElement | null>,
  streaming: boolean,
): { revealing: boolean } {
  const [revealing, setRevealing] = useState(false);
  const streamingRef = useRef(streaming);
  const maskRef = useRef<RevealMask | null>(null);
  streamingRef.current = streaming;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || prefersReducedMotion()) return;
    const mask = new RevealMask(container, () => streamingRef.current, setRevealing);
    maskRef.current = mask;
    return () => {
      mask.dispose();
      maskRef.current = null;
    };
  }, [containerRef]);

  useEffect(() => {
    maskRef.current?.sync();
  }, [streaming]);

  return { revealing };
}

/** Rendered characters per second assumed before the first flush is measured. */
const DEFAULT_RATE = 900;
/** How far the shown text is allowed to trail the real text, in seconds of arrival. */
const TARGET_BACKLOG_SECONDS = 0.075;
const MAX_BACKLOG_SECONDS = 0.15;
/** Once the message completes, the remaining tail lands within this window. */
const DRAIN_MS = 120;
const MAX_FRAME_SECONDS = 0.05;
const EMA_WEIGHT = 0.35;
/** Elements hidden outright while none of their text is revealed yet. */
const BLOCK_SELECTOR = "p, li, tr, pre, h1, h2, h3, h4, h5, h6, table, blockquote, ul, ol";

interface RevealStepInput {
  readonly shown: number;
  readonly total: number;
  readonly rate: number;
  readonly dtSeconds: number;
}

/** Advances the shown length toward the total at the incoming rate, catching up faster when the backlog grows. */
export function computeRevealStep({ shown, total, rate, dtSeconds }: RevealStepInput): number {
  const backlog = total - shown;
  if (backlog <= 0) return total;
  const safeRate = Math.max(rate, 1);
  const targetBacklog = safeRate * TARGET_BACKLOG_SECONDS;
  const maxBacklog = safeRate * MAX_BACKLOG_SECONDS;
  const revealRate =
    backlog > maxBacklog
      ? Math.max(safeRate, (backlog - targetBacklog) / MAX_BACKLOG_SECONDS)
      : safeRate;
  return Math.min(total, shown + revealRate * Math.min(Math.max(dtSeconds, 0), MAX_FRAME_SECONDS));
}

/** Folds one flush's growth into the running chars-per-second estimate. */
export function updateIncomingRate(
  previousRate: number | null,
  grownChars: number,
  dtSeconds: number,
): number {
  const sample = grownChars / Math.max(dtSeconds, 0.016);
  return previousRate === null ? sample : previousRate * (1 - EMA_WEIGHT) + sample * EMA_WEIGHT;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function safePrefixLength(text: string, length: number): number {
  const clamped = Math.max(0, Math.min(text.length, Math.floor(length)));
  if (clamped > 0 && clamped < text.length) {
    const code = text.charCodeAt(clamped - 1);
    if (code >= 0xd800 && code <= 0xdbff) return clamped - 1;
  }
  return clamped;
}

interface TextEntry {
  readonly node: Text;
  /** Text React last wrote into the node. */
  full: string;
  /** Text this mask last wrote; differs from `full` while truncated. */
  written: string;
  start: number;
}

interface BlockEntry {
  readonly element: HTMLElement;
  readonly start: number;
  hidden: boolean;
}

class RevealMask {
  private entries: TextEntry[] = [];
  private blocks: BlockEntry[] = [];
  private readonly known = new WeakMap<Text, TextEntry>();
  private total = 0;
  private shown: number | null = null;
  private rate: number | null = null;
  private lastGrowthAt: number | null = null;
  private lastFrameAt: number | null = null;
  private drain: { startAt: number; from: number } | null = null;
  private frame: number | null = null;
  private active = false;
  private readonly observer: MutationObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly isStreaming: () => boolean,
    private readonly onActiveChange: (active: boolean) => void,
  ) {
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(container, { childList: true, characterData: true, subtree: true });
    this.sync();
  }

  dispose() {
    this.observer.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.restoreAll();
  }

  /** Re-reads the DOM after React (or a deferred render) committed new text. */
  sync() {
    const now = performance.now();
    const previousTotal = this.total;
    this.collect();

    const streaming = this.isStreaming();
    if (this.shown === null) {
      // First sight of this message: whatever is already there was never
      // "streamed in" for this viewer, so show it whole.
      this.shown = this.total;
    } else if (this.total < this.shown) {
      // Not an append (retry, edit, thread swap): never animate backwards.
      this.shown = this.total;
    } else if (streaming && this.total > previousTotal) {
      const grown = this.total - previousTotal;
      this.rate =
        this.lastGrowthAt === null
          ? updateIncomingRate(null, grown, 0.05)
          : updateIncomingRate(this.rate, grown, (now - this.lastGrowthAt) / 1_000);
      this.lastGrowthAt = now;
    }

    if (!streaming && this.drain === null && this.shown < this.total) {
      this.drain = { startAt: now, from: this.shown };
    }
    if (streaming) this.drain = null;

    this.apply();
    this.observer.takeRecords();
    this.schedule();
  }

  private collect() {
    const walker = document.createTreeWalker(this.container, NodeFilter.SHOW_TEXT);
    const entries: TextEntry[] = [];
    const startByNode = new Map<Text, number>();
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      let entry = this.known.get(text);
      if (!entry || text.data !== entry.written) {
        // Either a node we have never seen or one React rewrote since we
        // truncated it; its current data is the authoritative full text.
        entry = { node: text, full: text.data, written: text.data, start: offset };
        this.known.set(text, entry);
      }
      entry.start = offset;
      startByNode.set(text, offset);
      entries.push(entry);
      offset += entry.full.length;
    }
    this.entries = entries;
    this.total = offset;

    const blocks: BlockEntry[] = [];
    const hiddenBefore = new Set(this.blocks.filter((b) => b.hidden).map((b) => b.element));
    for (const element of this.container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
      const first = document
        .createTreeWalker(element, NodeFilter.SHOW_TEXT)
        .nextNode() as Text | null;
      if (!first) continue;
      const start = startByNode.get(first);
      if (start === undefined) continue;
      blocks.push({ element, start, hidden: hiddenBefore.has(element) });
      hiddenBefore.delete(element);
    }
    // Blocks React dropped or re-created come back visible.
    for (const element of hiddenBefore) element.style.display = "";
    this.blocks = blocks;
  }

  private schedule() {
    const pending = this.shown !== null && (this.isStreaming() || this.shown < this.total);
    if (pending && this.frame === null) {
      this.frame = requestAnimationFrame(this.step);
    }
    // Idle again: the next loop starts its clock fresh instead of counting the
    // pause as elapsed time.
    if (!pending) this.lastFrameAt = null;
    this.setActive(pending);
  }

  private readonly step = (now: number) => {
    this.frame = null;
    if (this.shown === null) return;
    const dtSeconds = this.lastFrameAt === null ? 0 : (now - this.lastFrameAt) / 1_000;
    this.lastFrameAt = now;

    if (this.isStreaming()) {
      this.shown = computeRevealStep({
        shown: this.shown,
        total: this.total,
        rate: this.rate ?? DEFAULT_RATE,
        dtSeconds,
      });
    } else if (this.drain) {
      const progress = Math.min((now - this.drain.startAt) / DRAIN_MS, 1);
      this.shown = this.drain.from + (this.total - this.drain.from) * progress;
      if (progress >= 1) this.drain = null;
    } else {
      this.shown = this.total;
    }

    this.apply();
    this.observer.takeRecords();
    this.schedule();
  };

  private apply() {
    const shown = this.shown ?? this.total;
    for (const entry of this.entries) {
      const end = entry.start + entry.full.length;
      const next =
        end <= shown
          ? entry.full
          : entry.start >= shown
            ? ""
            : entry.full.slice(0, safePrefixLength(entry.full, shown - entry.start));
      if (next !== entry.written) {
        entry.node.data = next;
        entry.written = next;
      }
    }
    for (const block of this.blocks) {
      const hidden = block.start >= shown;
      if (hidden !== block.hidden) {
        block.element.style.display = hidden ? "none" : "";
        block.hidden = hidden;
      }
    }
  }

  private restoreAll() {
    for (const entry of this.entries) {
      if (entry.written !== entry.full) {
        entry.node.data = entry.full;
        entry.written = entry.full;
      }
    }
    for (const block of this.blocks) {
      if (block.hidden) {
        block.element.style.display = "";
        block.hidden = false;
      }
    }
  }

  private setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.onActiveChange(active);
  }
}
