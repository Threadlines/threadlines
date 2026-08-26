/**
 * Streaming renderer benchmark. Dev-only page at `/bench/stream.html`.
 *
 * Streams a fixed markdown reply into ChatMarkdown the way the server does
 * (one flush every 50 ms) and records how often the main thread stalled.
 * Results land on `window.__streamBench` and at the foot of the page so a
 * Playwright script can record a clip and read the numbers.
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import ChatMarkdown from "../components/ChatMarkdown";
import { useStreamingTextReveal } from "../hooks/useStreamingTextReveal";
import fixture from "./streamFixture.md?raw";

const FLUSH_INTERVAL_MS = 50;
const MIN_CHUNK_CHARS = 24;
const MAX_CHUNK_CHARS = 72;
const STALL_FRAME_MS = 50;

interface BenchResult {
  readonly totalMs: number;
  readonly flushes: number;
  readonly frames: number;
  readonly stalls: number;
  readonly worstFrameMs: number;
  readonly longTasks: number;
  readonly longTaskTotalMs: number;
  readonly worstLongTaskMs: number;
  /** Long tasks of 100 ms or more, with how much text had streamed by then. */
  readonly longTaskLog: ReadonlyArray<{ atMs: number; ms: number; chars: number }>;
}

declare global {
  interface Window {
    __streamBench?: BenchResult;
  }
}

/** Deterministic chunk sizes so before/after runs stream the same bytes per tick. */
function createChunkSizes(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return MIN_CHUNK_CHARS + (state % (MAX_CHUNK_CHARS - MIN_CHUNK_CHARS + 1));
  };
}

function useBenchStream(source: string, autoStart: boolean) {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sourceDone, setSourceDone] = useState(false);
  const metricsRef = useRef<{
    startedAt: number;
    flushes: number;
    frames: number;
    stalls: number;
    worstFrameMs: number;
    longTasks: number;
    longTaskTotalMs: number;
    worstLongTaskMs: number;
    longTaskLog: Array<{ atMs: number; ms: number; chars: number }>;
    rafId: number;
    done: boolean;
    observer: PerformanceObserver | null;
  } | null>(null);

  useEffect(() => {
    if (!autoStart) return;

    const nextChunkSize = createChunkSizes(0x5eed);
    let cursor = 0;
    let lastFrameAt = performance.now();
    const metrics = {
      startedAt: performance.now(),
      flushes: 0,
      frames: 0,
      stalls: 0,
      worstFrameMs: 0,
      longTasks: 0,
      longTaskTotalMs: 0,
      worstLongTaskMs: 0,
      longTaskLog: [] as Array<{ atMs: number; ms: number; chars: number }>,
      rafId: 0,
      done: false,
      observer: null as PerformanceObserver | null,
    };

    const observer =
      typeof PerformanceObserver !== "undefined"
        ? new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              if (entry.duration >= 100) {
                metrics.longTaskLog.push({
                  atMs: Math.round(entry.startTime - metrics.startedAt),
                  ms: Math.round(entry.duration),
                  chars: cursor,
                });
              }
              metrics.longTasks += 1;
              metrics.longTaskTotalMs += entry.duration;
              metrics.worstLongTaskMs = Math.max(metrics.worstLongTaskMs, entry.duration);
            }
          })
        : null;
    metrics.observer = observer;
    metricsRef.current = metrics;
    try {
      observer?.observe({ type: "longtask", buffered: false });
    } catch {
      // longtask entries are Chromium-only; the frame gap metric still works elsewhere.
    }

    const tickFrame = (now: number) => {
      const gap = now - lastFrameAt;
      lastFrameAt = now;
      metrics.frames += 1;
      if (gap > STALL_FRAME_MS) metrics.stalls += 1;
      metrics.worstFrameMs = Math.max(metrics.worstFrameMs, gap);
      if (!metrics.done) metrics.rafId = requestAnimationFrame(tickFrame);
    };

    setText("");
    setStreaming(true);
    setSourceDone(false);
    metrics.rafId = requestAnimationFrame(tickFrame);

    const interval = setInterval(() => {
      if (cursor >= source.length) {
        clearInterval(interval);
        setText(source);
        setStreaming(false);
        setSourceDone(true);
        return;
      }
      cursor = Math.min(source.length, cursor + nextChunkSize());
      metrics.flushes += 1;
      setText(source.slice(0, cursor));
    }, FLUSH_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      cancelAnimationFrame(metrics.rafId);
      observer?.disconnect();
      metricsRef.current = null;
    };
  }, [autoStart, source]);

  const finish = useCallback((): BenchResult | null => {
    const metrics = metricsRef.current;
    if (!metrics || metrics.done) return null;
    metrics.done = true;
    cancelAnimationFrame(metrics.rafId);
    metrics.observer?.disconnect();
    const summary: BenchResult = {
      totalMs: Math.round(performance.now() - metrics.startedAt),
      flushes: metrics.flushes,
      frames: metrics.frames,
      stalls: metrics.stalls,
      worstFrameMs: Math.round(metrics.worstFrameMs),
      longTasks: metrics.longTasks,
      longTaskTotalMs: Math.round(metrics.longTaskTotalMs),
      worstLongTaskMs: Math.round(metrics.worstLongTaskMs),
      longTaskLog: metrics.longTaskLog,
    };
    window.__streamBench = summary;
    return summary;
  }, []);

  return { text, streaming, sourceDone, finish };
}

function StreamBench() {
  const autoStart = new URLSearchParams(window.location.search).get("autostart") !== "0";
  const { text, streaming, sourceDone, finish } = useBenchStream(fixture, autoStart);
  const [result, setResult] = useState<BenchResult | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  // `?reveal=0` measures the renderer alone, without the per-frame reveal.
  const revealEnabled = new URLSearchParams(window.location.search).get("reveal") !== "0";
  const disabledRef = useRef<HTMLDivElement>(null);
  const { revealing } = useStreamingTextReveal(revealEnabled ? revealRef : disabledRef, streaming);
  const live = streaming || revealing;

  // The timeline sticks to the bottom while a reply streams; do the same so the
  // clip shows what a user watching the tail would see. Follow size changes of
  // the body (the reveal grows it between React commits) rather than polling
  // scrollHeight every frame, which would force a layout per frame.
  useEffect(() => {
    const el = scrollRef.current;
    const body = revealRef.current;
    if (!el || !body || !live) return;
    const observer = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [live]);

  useEffect(() => {
    if (!sourceDone || revealing || result) return;
    const firstFrame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const summary = finish();
        if (summary) setResult(summary);
      });
    });
    return () => cancelAnimationFrame(firstFrame);
  }, [finish, result, revealing, sourceDone]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 [scrollbar-gutter:stable_both-edges]"
        data-bench-scroll="true"
      >
        <div className="mx-auto w-full max-w-3xl py-4">
          <div ref={revealRef} data-transcript-message-streaming={live ? "true" : undefined}>
            <ChatMarkdown text={text} cwd={undefined} isStreaming={streaming} />
          </div>
        </div>
      </div>
      <div
        className="shrink-0 border-t border-border px-5 py-2 font-mono text-xs text-muted-foreground"
        data-bench-status={result ? "done" : live ? "streaming" : "idle"}
      >
        {result
          ? `done ${result.totalMs}ms · ${result.flushes} flushes · stalls(>${STALL_FRAME_MS}ms) ${result.stalls}/${result.frames} frames · worst frame ${result.worstFrameMs}ms · long tasks ${result.longTasks} (${result.longTaskTotalMs}ms, worst ${result.worstLongTaskMs}ms)`
          : live
            ? `streaming ${text.length}/${fixture.length} chars`
            : "idle"}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StreamBench />
  </StrictMode>,
);
