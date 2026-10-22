import { useCallback, useLayoutEffect, useRef } from "react";

// Two fingers count as spreading once they are this much further apart.
const SPREAD_TO_OPEN = 1.2;
// The rest of a trackpad pinch that already opened the viewer.
const OPENED_GESTURE_MS = 500;

/**
 * Pinching outward on a picture opens it in the image viewer, as clicking it
 * does. A trackpad pinch arrives as a wheel with Ctrl held; the rest of it
 * lands on the viewer, which goes on zooming. Two fingers spreading on a touch
 * screen open it too, and the reader pinches again there, since those fingers
 * stay with the picture they started on.
 *
 * Returns a ref for the picture's element. One finger still scrolls past the
 * picture (`touch-action: pan-x pan-y`); only a pinch that starts on it stops
 * zooming the whole page.
 */
export function usePinchToExpand(open: (() => void) | undefined) {
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });

  return useCallback((element: HTMLElement | null) => {
    if (!element) return;
    let openedAt = Number.NEGATIVE_INFINITY;
    const touches = new Map<number, { x: number; y: number }>();
    let startSpread = 0;
    const spread = () => {
      const [first, second] = [...touches.values()];
      return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
    };

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !openRef.current) return;
      // Not passive: the browser would zoom the whole app instead.
      event.preventDefault();
      if (event.deltaY >= 0 || performance.now() - openedAt < OPENED_GESTURE_MS) return;
      openedAt = performance.now();
      openRef.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      startSpread = touches.size === 2 ? spread() : 0;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size !== 2 || startSpread <= 0 || spread() < startSpread * SPREAD_TO_OPEN) return;
      touches.clear();
      startSpread = 0;
      openRef.current?.();
    };
    const onPointerEnd = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) startSpread = 0;
    };

    const touchAction = element.style.touchAction;
    element.style.touchAction = "pan-x pan-y";
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerEnd);
    element.addEventListener("pointercancel", onPointerEnd);
    return () => {
      element.style.touchAction = touchAction;
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
    };
  }, []);
}
