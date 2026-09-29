import { type RefObject, useLayoutEffect } from "react";

/**
 * Keeps a streaming message from getting shorter until it is done.
 *
 * Half-written markdown can render taller than it ends up: a list item's bare
 * `- `, a code fence before its first line, a link whose raw address wraps
 * until its `)` arrives. The next delta takes that height back, and a chat
 * pinned to its bottom follows the shrink, so the text above it drops for a
 * moment and climbs back. Holding the tallest height seen turns that into a
 * little space under the last line, which the next words fill.
 *
 * Attach the ref to the element wrapping the markdown body and pass whether
 * the message is still being written. While active, the element contains its
 * children's margins (`flow-root`), so none can collapse out of it and shrink
 * the row around the floor. The floor starts over at the current height when
 * the width changes, and is released when the message is done.
 */
export function useStreamingHeightFloor(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!active || !container || typeof ResizeObserver === "undefined") {
      return;
    }
    container.style.display = "flow-root";
    let floor = 0;
    let width: number | null = null;
    let resetFrame: number | null = null;
    const hold = (height: number) => {
      floor = height;
      container.style.minHeight = `${floor}px`;
    };
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0];
      if (!box) return;
      if (width !== null && Math.abs(box.inlineSize - width) >= 1) {
        // Rewrapped text has a height of its own. Measure it in the next
        // frame: resizing the observed element inside its own callback is a
        // loop, and letting go without measuring would hold nothing until the
        // height happened to change again.
        resetFrame ??= requestAnimationFrame(() => {
          resetFrame = null;
          container.style.minHeight = "";
          hold(container.getBoundingClientRect().height);
        });
      }
      width = box.inlineSize;
      if (box.blockSize > floor) hold(box.blockSize);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resetFrame !== null) cancelAnimationFrame(resetFrame);
      container.style.minHeight = "";
      container.style.display = "";
    };
  }, [active, containerRef]);
}
