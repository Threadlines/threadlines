/**
 * Entrances for the live parts of the timeline: a row settles in with a short
 * rise, and a detail that arrives after its row exists fades in rather than
 * popping. Pass one of these as the element's `ref`; it plays once, when the
 * element mounts, and stops if the ref is detached first.
 *
 * They are script animations on purpose. The virtual list re-sorts its row
 * elements in the DOM once positions settle, and moving an element restarts
 * its CSS animations: a reply already on screen would blink out and rise again
 * mid-sentence. An animation started from script keeps its own clock across a
 * move and never replays.
 */

/** Tags every entrance, so a test can wait for them to finish. */
export const TIMELINE_ENTRANCE_ANIMATION_ID = "timeline-entrance";

// From-only keyframes end at each element's own opacity, so dimmed rows land
// on their dim level, not full strength.
const ROW_ENTRANCE: Keyframe[] = [{ offset: 0, opacity: 0, transform: "translateY(3px)" }];
const DETAIL_ENTRANCE: Keyframe[] = [{ offset: 0, opacity: 0 }];

function playEntrance(
  element: HTMLElement | null,
  keyframes: Keyframe[],
  duration: number,
): (() => void) | undefined {
  if (
    !element ||
    typeof element.animate !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return undefined;
  }
  const animation = element.animate(keyframes, {
    duration,
    easing: "ease-out",
    id: TIMELINE_ENTRANCE_ANIMATION_ID,
  });
  return () => animation.cancel();
}

/** A live row settling into the timeline. */
export function rowEntranceRef(element: HTMLElement | null) {
  return playEntrance(element, ROW_ENTRANCE, 180);
}

/** A detail that arrives after its row already exists. */
export function detailEntranceRef(element: HTMLElement | null) {
  return playEntrance(element, DETAIL_ENTRANCE, 240);
}
