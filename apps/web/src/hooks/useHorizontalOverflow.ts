import { useCallback, useLayoutEffect, useState, type RefCallback } from "react";

const OVERFLOW_MEASUREMENT_EPSILON_PX = 1;

function hasHorizontalOverflow(element: HTMLElement): boolean {
  return element.scrollWidth - element.clientWidth > OVERFLOW_MEASUREMENT_EPSILON_PX;
}

/**
 * Report whether a single-line element's content is wider than the element,
 * i.e. whether `truncate` is currently clipping it. Attach `elementRef` to the
 * clipped element. Re-measures when `contentKey` changes, when the element or
 * its parent resizes, and on window resize. Pass `enabled: false` to skip
 * measuring while the element is not clipped (e.g. an expanded state).
 */
export function useHorizontalOverflow(
  contentKey: string,
  enabled: boolean,
): {
  elementRef: RefCallback<HTMLElement>;
  overflows: boolean;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const elementRef = useCallback<RefCallback<HTMLElement>>((node) => {
    setElement(node);
  }, []);

  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    if (!element) {
      setOverflows(false);
      return;
    }

    let frameId: number | null = null;

    const measure = () => {
      frameId = null;
      const nextOverflows = hasHorizontalOverflow(element);
      setOverflows((current) => (current === nextOverflows ? current : nextOverflows));
    };

    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(measure);
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [contentKey, element, enabled]);

  return { elementRef, overflows };
}
