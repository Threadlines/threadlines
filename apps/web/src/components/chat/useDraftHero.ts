import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useIsMobile } from "../../hooks/useMediaQuery";

/**
 * The new-thread screen's hero layout: the composer sits in the middle of the
 * chat column, under the question, and slides to the bottom on the first send.
 *
 * Whether the hero is showing is a fact about the page, not React state: the
 * timeline alone knows when it is empty, and it renders the element marked
 * `data-draft-hero` exactly then. The `draft-hero` variant in index.css styles
 * the column from that marker, and the slide below reads it.
 */

/** Smallest chat column the hero is laid out in. Below it the composer stays at the bottom. */
const HERO_MIN_WIDTH_PX = 560;
const HERO_MIN_HEIGHT_PX = 600;

/**
 * Whether the chat column has room for the hero. Measured on the column, not
 * the window: the browser split narrows it and the terminal shortens it while
 * the window stays the same size.
 */
export function useDraftHeroCapable(column: HTMLElement | null, enabled: boolean): boolean {
  const isMobile = useIsMobile();
  const [hasRoom, setHasRoom] = useState(false);

  useLayoutEffect(() => {
    if (!enabled || !column) {
      return;
    }
    // The border box, not the client box. The hero makes the column scroll,
    // and a scrollbar that takes up width would shrink the client box under
    // the minimum, drop the hero, lose the scrollbar and bring the hero back.
    const measure = () => {
      setHasRoom(
        column.offsetWidth >= HERO_MIN_WIDTH_PX && column.offsetHeight >= HERO_MIN_HEIGHT_PX,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [column, enabled]);

  // `hasRoom` is only read while there is a column being measured.
  return enabled && column !== null && hasRoom && !isMobile;
}

const SLIDE_DURATION_MS = 260;
const SLIDE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** The composer's width in the hero, and the width it grows back to. */
const HERO_COMPOSER_MAX_WIDTH = "45rem";
const THREAD_COMPOSER_MAX_WIDTH = "56rem";

/**
 * The slide in flight, kept outside any component: sending a draft swaps the
 * chat view for the server thread's own within a few hundred milliseconds,
 * and the composer that mounts there has to pick the motion up where the old
 * one was cut off instead of snapping to the bottom.
 */
let slideInFlight: { threadKey: string; deltaPx: number; startedAtMs: number } | null = null;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function playSlide(inputBar: HTMLElement, deltaPx: number, elapsedMs: number): Animation[] {
  const timing = { duration: SLIDE_DURATION_MS, easing: SLIDE_EASING };
  const animations = [
    inputBar.animate(
      [{ transform: `translateY(${deltaPx}px)` }, { transform: "translateY(0)" }],
      timing,
    ),
    // The composer and the row under it are narrower in the hero. They widen
    // over the same beat rather than jumping at the start of it.
    ...Array.from(inputBar.children, (child) =>
      child.animate(
        [{ maxWidth: HERO_COMPOSER_MAX_WIDTH }, { maxWidth: THREAD_COMPOSER_MAX_WIDTH }],
        timing,
      ),
    ),
  ];
  for (const animation of animations) {
    animation.currentTime = elapsedMs;
  }
  return animations;
}

/**
 * Slides the composer from the middle of the column to the bottom when the
 * first message of a draft is sent.
 *
 * It moves only for that: the hero giving way to the conversation while the
 * layout itself is unchanged. A pane resized under the hero's minimum drops
 * the marker too, and that is a relayout, not a send. A send that fails puts
 * the hero back, and the slide is cancelled so the composer is not left
 * travelling away from where it now sits.
 */
export function useDraftHeroComposerSlide(input: {
  /** The chat column and the bar holding the composer, once they are in the page. */
  column: HTMLElement | null;
  inputBar: HTMLElement | null;
  /** Stable across the draft and the server thread it becomes. */
  threadKey: string;
  isLocalDraft: boolean;
  heroCapable: boolean;
}): void {
  const { column, inputBar, threadKey, isLocalDraft, heroCapable } = input;
  const previousRef = useRef<{ heroShown: boolean; heroCapable: boolean; top: number } | null>(
    null,
  );
  const animationsRef = useRef<Animation[]>([]);

  // A chat view mounting for a thread whose composer is mid-slide: carry on.
  // Only where the slide still makes sense. A send that failed while no view
  // was mounted leaves the hero showing here, and its composer belongs in the
  // middle, not travelling away from it.
  useLayoutEffect(() => {
    const slide = slideInFlight;
    if (!column || !inputBar || slide === null || slide.threadKey !== threadKey) {
      return;
    }
    const elapsedMs = performance.now() - slide.startedAtMs;
    if (
      elapsedMs >= SLIDE_DURATION_MS ||
      column.querySelector("[data-draft-hero]") !== null ||
      prefersReducedMotion()
    ) {
      slideInFlight = null;
      return;
    }
    animationsRef.current = playSlide(inputBar, slide.deltaPx, elapsedMs);
  }, [column, inputBar, threadKey]);

  // Runs on every commit of a draft: the hero leaving the page is not a state
  // change this component can subscribe to, so each commit compares the page
  // against the one before it.
  useLayoutEffect(() => {
    if (!isLocalDraft || !column || !inputBar) {
      previousRef.current = null;
      return;
    }
    const heroShown = column.querySelector("[data-draft-hero]") !== null;
    const top = inputBar.getBoundingClientRect().top;
    const previous = previousRef.current;
    previousRef.current = { heroShown, heroCapable, top };
    if (previous === null) {
      return;
    }
    if (heroShown && !previous.heroShown) {
      for (const animation of animationsRef.current) {
        animation.cancel();
      }
      animationsRef.current = [];
      if (slideInFlight?.threadKey === threadKey) {
        slideInFlight = null;
      }
      return;
    }
    const sent = previous.heroShown && !heroShown && previous.heroCapable && heroCapable;
    const deltaPx = previous.top - top;
    if (!sent || Math.abs(deltaPx) < 4 || prefersReducedMotion()) {
      return;
    }
    slideInFlight = { threadKey, deltaPx, startedAtMs: performance.now() };
    animationsRef.current = playSlide(inputBar, deltaPx, 0);
  });

  // The window can be resized, and a short hero column scrolled, without this
  // component rendering, which would leave the remembered position stale for
  // the send that follows.
  useEffect(() => {
    if (!isLocalDraft || !column || !inputBar) {
      return;
    }
    const remeasure = () => {
      const previous = previousRef.current;
      if (previous) {
        previousRef.current = { ...previous, top: inputBar.getBoundingClientRect().top };
      }
    };
    window.addEventListener("resize", remeasure);
    column.addEventListener("scroll", remeasure, { passive: true });
    return () => {
      window.removeEventListener("resize", remeasure);
      column.removeEventListener("scroll", remeasure);
    };
  }, [column, inputBar, isLocalDraft]);
}
