import { ASSISTANT_STREAM_FLUSH_INTERVAL_MS } from "@threadlines/shared/threadLimits";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * Reveals streamed assistant text at a steady per-frame pace instead of in the
 * lumps the server flushes (one every ASSISTANT_STREAM_FLUSH_INTERVAL_MS). The
 * markdown keeps rendering the full text at flush cadence; this hook masks the
 * not-yet-shown tail straight in the DOM (truncating text nodes, hiding
 * trailing blocks), so nothing is re-parsed per frame. The shown text trails the real text by roughly one flush so the edge
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

  const disposeMask = () => {
    const current = maskRef.current;
    if (!current) return;
    maskRef.current = null;
    current.dispose();
  };

  // Create the DOM observer only when a message actually streams, and tear it
  // down once streaming ends and any trailing drain finishes so settled
  // history rows carry zero MutationObservers or DOM walks.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || prefersReducedMotion()) {
      disposeMask();
      setRevealing(false);
      return;
    }

    const existing = maskRef.current;
    if (existing && existing.container !== container) {
      disposeMask();
    }

    if (streaming && maskRef.current === null) {
      const mask = new RevealMask(
        container,
        () => streamingRef.current,
        setRevealing,
        () => {
          if (maskRef.current === mask) {
            maskRef.current = null;
            mask.dispose();
          }
        },
      );
      maskRef.current = mask;
      return;
    }

    if (!streaming && maskRef.current !== null) {
      maskRef.current.sync();
    }
  }, [containerRef, streaming]);

  useLayoutEffect(
    () => () => {
      disposeMask();
    },
    [],
  );

  // Mask each commit of a live message, and the final one that starts its
  // drain, before anything above it measures the new text. The chat's virtual
  // list reads a row's height in the same commit, ahead of the observer's
  // microtask, and would record the unrevealed tail: one line too tall, taken
  // back a moment later, which drops the text below.
  useLayoutEffect(() => {
    if (streaming || revealing) maskRef.current?.sync();
  });

  return { revealing };
}

/** Rendered characters per second assumed before the first flush is measured. */
const DEFAULT_RATE = 900;
/** The time one flush's text took to arrive, before two flushes measure it. */
const FLUSH_SECONDS = ASSISTANT_STREAM_FLUSH_INTERVAL_MS / 1_000;
/**
 * How far the shown text is allowed to trail the real text, in seconds of
 * arrival. Within this it reveals at the incoming rate; past the maximum it
 * catches up toward the target. Both scale with the flush interval: a backlog
 * shorter than one flush would catch up early and then wait on the next one.
 */
const TARGET_BACKLOG_SECONDS = 1.5 * FLUSH_SECONDS;
const MAX_BACKLOG_SECONDS = 3 * FLUSH_SECONDS;
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
  private disposed = false;
  private wasStreaming = false;
  private awaitingDeferredSettle = false;
  private appliedEntryIndex = 0;
  private appliedBlockIndex = 0;
  private entriesMasked = false;
  private blocksMasked = false;
  private readonly observer: MutationObserver;

  constructor(
    readonly container: HTMLElement,
    private readonly isStreaming: () => boolean,
    private readonly onActiveChange: (active: boolean) => void,
    private readonly onSettled: () => void,
  ) {
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(container, { childList: true, characterData: true, subtree: true });
    this.sync();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.restoreAll();
  }

  /** Re-reads the DOM after React (or a deferred render) committed new text. */
  sync() {
    if (this.disposed) return;
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
      this.appliedEntryIndex = 0;
      this.appliedBlockIndex = 0;
      this.entriesMasked = false;
      this.blocksMasked = false;
    } else if (streaming && this.total > previousTotal) {
      const grown = this.total - previousTotal;
      this.rate =
        this.lastGrowthAt === null
          ? updateIncomingRate(null, grown, FLUSH_SECONDS)
          : updateIncomingRate(this.rate, grown, (now - this.lastGrowthAt) / 1_000);
      this.lastGrowthAt = now;
    }

    if (streaming) {
      this.wasStreaming = true;
      this.awaitingDeferredSettle = false;
      this.drain = null;
    } else if (this.shown < this.total) {
      this.wasStreaming = false;
      this.awaitingDeferredSettle = false;
      if (this.drain === null) {
        this.drain = { startAt: now, from: this.shown };
      }
    } else if (this.wasStreaming) {
      // Markdown blocks defer their text via useDeferredValue, so the commit
      // that clears `streaming` can land one frame before the final suffix
      // appears in the DOM. Keep the observer alive for one frame to catch it.
      this.wasStreaming = false;
      this.awaitingDeferredSettle = true;
    }

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
    this.appliedEntryIndex = 0;
    this.appliedBlockIndex = 0;
    this.entriesMasked = false;
    this.blocksMasked = false;
  }

  private schedule() {
    const streaming = this.isStreaming();
    const needsFrame =
      this.shown !== null &&
      (this.shown < this.total || (!streaming && this.awaitingDeferredSettle));
    const active = this.shown !== null && (streaming || needsFrame);
    if (needsFrame) {
      if (this.frame === null) {
        this.frame = requestAnimationFrame(this.step);
      }
    } else {
      // Caught up to the latest flush: stop burning animation frames until more
      // text arrives, and restart the frame clock fresh when it does.
      if (this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      this.lastFrameAt = null;
    }
    this.setActive(active);
    if (!active && !streaming) {
      this.onSettled();
    }
  }

  private readonly step = (now: number) => {
    this.frame = null;
    if (this.disposed || this.shown === null) return;
    if (!this.isStreaming() && this.awaitingDeferredSettle) {
      this.awaitingDeferredSettle = false;
      this.collect();
      if (this.shown < this.total && this.drain === null) {
        this.drain = { startAt: now, from: this.shown };
      }
      this.apply();
      this.observer.takeRecords();
      this.schedule();
      return;
    }
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
    const entries = this.entries;
    for (let index = this.appliedEntryIndex; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const end = entry.start + entry.full.length;
      if (end <= shown) {
        if (entry.written !== entry.full) {
          entry.node.data = entry.full;
          entry.written = entry.full;
        }
        if (index === this.appliedEntryIndex) {
          this.appliedEntryIndex = index + 1;
        }
        continue;
      }
      if (entry.start >= shown) {
        if (this.entriesMasked) {
          break;
        }
        if (entry.written !== "") {
          entry.node.data = "";
          entry.written = "";
        }
        continue;
      }
      const next = entry.full.slice(0, safePrefixLength(entry.full, shown - entry.start));
      if (next !== entry.written) {
        entry.node.data = next;
        entry.written = next;
      }
    }
    this.entriesMasked = true;

    const blocks = this.blocks;
    for (let index = this.appliedBlockIndex; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.start < shown) {
        if (block.hidden) {
          block.element.style.display = "";
          block.hidden = false;
        }
        if (index === this.appliedBlockIndex) {
          this.appliedBlockIndex = index + 1;
        }
        continue;
      }
      if (this.blocksMasked) {
        break;
      }
      if (!block.hidden) {
        block.element.style.display = "none";
        block.hidden = true;
      }
    }
    this.blocksMasked = true;
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
