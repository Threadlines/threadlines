import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";

import { TOUCH_HOLD_SLOP_PX } from "./useTouchHoldMenu";

/**
 * Which way a finger travels to reach a row's action: "leading" sits under
 * the row's left edge and is reached by swiping right, "trailing" sits under
 * its right edge and is reached by swiping left.
 */
export type RowSwipeSide = "leading" | "trailing";

/** One side's action, as the swipe needs it. */
export interface RowSwipeHandler {
  /**
   * Whether the row leaves the list when the action runs (Wrap up, Reopen,
   * Archive): it slides the rest of the way out first. A row that stays
   * (Pin) springs back instead.
   */
  readonly leaves: boolean;
  readonly run: () => void;
}

/** Past this share of the row's width, letting go runs the action. */
const SWIPE_COMMIT_FRACTION = 0.4;
/** The commit point is never closer than this, so a narrow row still asks for a real swipe. */
const SWIPE_COMMIT_MIN_PX = 96;
/** Past this share of the width the row follows the finger at a quarter of its pace. */
const SWIPE_RESIST_FRACTION = 0.7;
const SWIPE_RESISTANCE = 0.25;
const SWIPE_SETTLE_MS = 180;
/** How long after a swipe a click is taken as that swipe's end, not a tap. */
const SWIPE_CLICK_GUARD_MS = 400;

/**
 * What a touch that has moved (dx, dy) since it went down is turning into.
 *
 * Nothing is decided inside the slop the press-and-hold menu allows, so a hold
 * and a swipe never both start. Past it, a mostly vertical move is a scroll
 * and stays the list's; a sideways one is the row's only when that side has an
 * action, and otherwise passes too.
 */
export function resolveRowSwipeIntent(input: {
  readonly dx: number;
  readonly dy: number;
  readonly leading: boolean;
  readonly trailing: boolean;
}): "pending" | "swipe" | "pass" {
  const across = Math.abs(input.dx);
  const along = Math.abs(input.dy);
  if (Math.max(across, along) <= TOUCH_HOLD_SLOP_PX) return "pending";
  if (along >= across) return "pass";
  return (input.dx > 0 ? input.leading : input.trailing) ? "swipe" : "pass";
}

/** How far the row must travel before letting go runs the action. */
export function rowSwipeCommitDistance(width: number): number {
  return Math.max(SWIPE_COMMIT_MIN_PX, width * SWIPE_COMMIT_FRACTION);
}

/**
 * Where the row sits for a finger that has travelled `travel` px since the
 * swipe took hold: with the finger, then resisting near the far edge, never
 * past the row's own width, and never toward a side that has no action.
 */
export function resolveRowSwipeOffset(input: {
  readonly travel: number;
  readonly width: number;
  readonly leading: boolean;
  readonly trailing: boolean;
}): number {
  const { travel, width } = input;
  if (travel === 0 || (travel > 0 ? !input.leading : !input.trailing)) return 0;
  const limit = width * SWIPE_RESIST_FRACTION;
  const distance = Math.abs(travel);
  const eased = distance <= limit ? distance : limit + (distance - limit) * SWIPE_RESISTANCE;
  return Math.sign(travel) * Math.min(eased, width);
}

interface SwipeGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  mode: "pending" | "swipe" | "pass";
  /** Where the finger was when the swipe took hold; travel counts from here, so the row doesn't jump. */
  holdX: number;
  offset: number;
  armed: boolean;
}

export interface RowSwipeView {
  /** The side being revealed, or null while the row rests. */
  readonly side: RowSwipeSide | null;
  /** Whether letting go now runs that side's action. */
  readonly armed: boolean;
}

const RESTING_VIEW: RowSwipeView = { side: null, armed: false };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Touch swipes on a list row that reveal an action on each side, the way a
 * mail list does. Only a touch pointer swipes; a mouse never moves the row.
 *
 * The row's content moves in `layerRef` while the finger drags, written
 * straight to its style so a drag never re-renders the row; `view` changes
 * only when the revealed side or its armed state does. Spread `handlers` on
 * the element holding the layer (`containerRef`). It takes the gesture only
 * once the finger has clearly gone sideways, so vertical scrolling, taps and
 * the press-and-hold menu behave as before, and it swallows the click a swipe
 * can end in.
 */
export function useRowSwipe(input: {
  readonly leading: RowSwipeHandler | null;
  readonly trailing: RowSwipeHandler | null;
  readonly disabled?: boolean;
}) {
  const enabled = input.disabled !== true && (input.leading !== null || input.trailing !== null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<SwipeGesture | null>(null);
  const swipedAtRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A committed action waiting for the row to finish sliding out. Once the
  // finger has let go past the commit point the action is owed: a new touch
  // or the row going away runs it at once rather than dropping it.
  const pendingRunRef = useRef<(() => void) | null>(null);
  // The latest actions, so a commit runs what the row offers now even though
  // the handlers below never change identity.
  const handlersRef = useRef({ leading: input.leading, trailing: input.trailing });
  useLayoutEffect(() => {
    handlersRef.current = { leading: input.leading, trailing: input.trailing };
  });
  const [view, setView] = useState<RowSwipeView>(RESTING_VIEW);
  const viewRef = useRef<RowSwipeView>(RESTING_VIEW);

  const showView = useCallback((next: RowSwipeView) => {
    if (viewRef.current.side === next.side && viewRef.current.armed === next.armed) return;
    viewRef.current = next;
    setView(next);
  }, []);

  const placeLayer = useCallback((offset: number, animate: boolean) => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.style.transition =
      animate && !prefersReducedMotion() ? `transform ${SWIPE_SETTLE_MS}ms ease-out` : "";
    layer.style.transform = offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`;
  }, []);

  /** Ends a settle now: no more waiting, and an owed action runs. */
  const finishSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    const run = pendingRunRef.current;
    pendingRunRef.current = null;
    run?.();
  }, []);
  useEffect(() => finishSettle, [finishSettle]);

  /** Back to rest after `delay` ms (the settle animation), running `after` first. */
  const settle = useCallback(
    (delay: number, after?: () => void) => {
      finishSettle();
      pendingRunRef.current = after ?? null;
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        finishSettle();
        placeLayer(0, false);
        showView(RESTING_VIEW);
      }, delay);
    },
    [finishSettle, placeLayer, showView],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || event.pointerType !== "touch" || !event.isPrimary) return;
      const width = containerRef.current?.getBoundingClientRect().width ?? 0;
      if (width <= 0) return;
      // A new press is a new gesture: the last swipe's owed action runs now,
      // and its click guard is spent.
      finishSettle();
      swipedAtRef.current = 0;
      placeLayer(0, false);
      showView(RESTING_VIEW);
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width,
        mode: "pending",
        holdX: event.clientX,
        offset: 0,
        armed: false,
      };
    },
    [enabled, finishSettle, placeLayer, showView],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.mode === "pass") return;
      const leading = handlersRef.current.leading !== null;
      const trailing = handlersRef.current.trailing !== null;
      if (gesture.mode === "pending") {
        const intent = resolveRowSwipeIntent({
          dx: event.clientX - gesture.startX,
          dy: event.clientY - gesture.startY,
          leading,
          trailing,
        });
        if (intent === "pending") return;
        gesture.mode = intent;
        gesture.holdX = event.clientX;
        return;
      }
      const offset = resolveRowSwipeOffset({
        travel: event.clientX - gesture.holdX,
        width: gesture.width,
        leading,
        trailing,
      });
      const armed = Math.abs(offset) >= rowSwipeCommitDistance(gesture.width);
      if (armed && !gesture.armed && "vibrate" in navigator) {
        // A tick under the thumb where the device has one (not iPhone Safari).
        navigator.vibrate(8);
      }
      gesture.offset = offset;
      gesture.armed = armed;
      placeLayer(offset, false);
      showView({ side: offset > 0 ? "leading" : offset < 0 ? "trailing" : null, armed });
    },
    [placeLayer, showView],
  );

  const end = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, canCommit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (gesture.mode !== "swipe") return;
      swipedAtRef.current = performance.now();
      const side: RowSwipeSide | null =
        gesture.offset > 0 ? "leading" : gesture.offset < 0 ? "trailing" : null;
      const handler = side === null ? null : handlersRef.current[side];
      if (!canCommit || !gesture.armed || handler === null) {
        placeLayer(0, true);
        settle(SWIPE_SETTLE_MS);
        return;
      }
      if (handler.leaves) {
        // Out the rest of the way, then the row is filed elsewhere.
        placeLayer(Math.sign(gesture.offset) * gesture.width, true);
        settle(SWIPE_SETTLE_MS, handler.run);
        return;
      }
      handler.run();
      placeLayer(0, true);
      settle(SWIPE_SETTLE_MS);
    },
    [placeLayer, settle],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => end(event, true),
    [end],
  );
  // The browser took the touch (a scroll, the system's own gesture): nothing runs.
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => end(event, false),
    [end],
  );

  // Swallows the one click a swipe can end in, and only that one.
  const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (performance.now() - swipedAtRef.current > SWIPE_CLICK_GUARD_MS) return;
    swipedAtRef.current = 0;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    enabled,
    view,
    containerRef,
    layerRef,
    handlers: enabled
      ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture }
      : undefined,
  };
}
