import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Where the agent is on the page.
 *
 * An agent driving a browser the user is watching should be visible doing it.
 * Without this, a page changes under you with no way to tell whether the agent
 * did it, the page did it, or nothing happened at all -- and "did the click
 * land?" is the question every one of these turns ends on.
 *
 * It stays where it last acted rather than fading out. A mark that vanishes
 * answers that question only if you happened to be looking; one that rests
 * answers it whenever you look up. It travels between actions instead of
 * teleporting, because a jump reads as two separate marks appearing and a glide
 * reads as one thing moving, which is what actually happened.
 *
 * Drawn over the webview rather than inside the page: it is a thing our UI is
 * saying about the page, not a thing on the page. That also keeps it out of
 * screenshots, which should show what the user would see, not our annotations.
 */

/** How long after the last action the pointer settles to its resting state. */
const POINTER_SETTLE_MS = 900;

/**
 * How long the click ring runs.
 *
 * Deliberately finite. Tailwind's `animate-ping` loops forever, and a
 * perpetually animating SVG over a live webview is the exact shape of the idle
 * churn that cost this app a quarter of a core per window once already.
 */
const POINTER_PING_MS = 620;

/** Bounds on the glide. Below the floor it reads as a jump; above the ceiling
 *  the pointer is still travelling after the page has already changed. */
const POINTER_TRAVEL_MIN_MS = 140;
const POINTER_TRAVEL_MAX_MS = 320;
const POINTER_TRAVEL_MS_PER_PX = 0.55;

export interface AgentPointerPosition {
  /** Viewport coordinates, as the agent's input was dispatched. */
  readonly x: number;
  readonly y: number;
  /** Distinguishes two actions in the same spot, which should read as two. */
  readonly sequence: number;
}

export function travelDurationMs(
  from: { readonly x: number; readonly y: number } | null,
  to: { readonly x: number; readonly y: number },
): number {
  // The first appearance has nowhere to travel from, so it arrives rather than
  // flying in from the corner.
  if (from === null) {
    return 0;
  }
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(
    POINTER_TRAVEL_MAX_MS,
    Math.max(POINTER_TRAVEL_MIN_MS, distance * POINTER_TRAVEL_MS_PER_PX),
  );
}

export function AgentPointer({
  position,
  scale,
  className,
}: {
  position: AgentPointerPosition | null;
  /** Page pixels to panel pixels, so the mark lands where the user sees it. */
  scale: number;
  className?: string;
}) {
  const [settled, setSettled] = useState(false);
  const previous = useRef<{ x: number; y: number } | null>(null);

  const sequence = position?.sequence ?? null;
  useEffect(() => {
    if (sequence === null) {
      return;
    }
    // Every action resets the clock: the pointer only rests once the agent has
    // stopped moving it.
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), POINTER_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [sequence]);

  if (position === null) {
    previous.current = null;
    return null;
  }

  const point = { x: position.x * scale, y: position.y * scale };
  const duration = travelDurationMs(previous.current, point);
  previous.current = point;

  return (
    <div
      aria-hidden="true"
      data-testid="agent-pointer"
      data-settled={settled ? "true" : "false"}
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-30 ease-out",
        "transition-[transform,opacity] motion-reduce:transition-none",
        // Resting is dimmer, not gone. Enough to read as "the agent was here",
        // little enough to stop competing with the page underneath.
        settled ? "opacity-55" : "opacity-100",
        className,
      )}
      style={{
        transform: `translate3d(${point.x}px, ${point.y}px, 0)`,
        transitionDuration: `${duration}ms, 400ms`,
      }}
    >
      <ClickRing sequence={position.sequence} />
      {/* An arrow, because an arrow is what a pointer looks like and this
          should need no explaining. Filled in our colour with a rim around it,
          rather than the hollow outline every system cursor uses, so it reads
          at a glance as the agent's and not as your own cursor left behind.
          Round joins and caps take the hard mitres off that silhouette. */}
      <svg width="24" height="24" viewBox="0 0 24 24" className="relative">
        <path
          d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"
          className="fill-primary-readable stroke-background drop-shadow-[0_1px_3px_rgb(0_0_0/0.45)]"
          strokeWidth="3.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          // Stroke under fill, so the rim sits outside the shape instead of
          // eating it. This is what rounds the corners.
          paintOrder="stroke"
        />
      </svg>
    </div>
  );
}

/** The action itself, as a ring that expands once from where it landed. */
function ClickRing({ sequence }: { sequence: number }) {
  const [running, setRunning] = useState(true);

  useEffect(() => {
    setRunning(true);
    const timer = window.setTimeout(() => setRunning(false), POINTER_PING_MS);
    return () => window.clearTimeout(timer);
  }, [sequence]);

  if (!running) {
    return null;
  }
  return (
    <span
      key={sequence}
      className="absolute -left-3 -top-3 size-6 animate-ping rounded-full bg-primary-readable/30 motion-reduce:hidden"
    />
  );
}
