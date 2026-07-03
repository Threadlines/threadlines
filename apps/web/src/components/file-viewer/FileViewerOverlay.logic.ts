import type { SelectedLineRange } from "@pierre/diffs";

/**
 * Line-selection resolution for coarse pointers (touch), where pierre's
 * drag-for-range gesture is unavailable — a touch drag scrolls, so pierre
 * only ever reports single-line taps. Taps compose ranges instead:
 *
 * - first tap anchors a single-line selection;
 * - a tap outside the selection extends it from the original anchor
 *   (`start` is preserved, so ranges may be reversed — consumers already
 *   normalize with min/max);
 * - a tap inside the selection clears it.
 *
 * Multi-line input is passed through untouched: it is either a managed drag
 * pierre completed before scrolling took over, or a programmatic restore.
 */
export function resolveCoarseLineSelection(
  previous: SelectedLineRange | null,
  incoming: SelectedLineRange | null,
): SelectedLineRange | null {
  if (!incoming || incoming.start !== incoming.end) {
    return incoming;
  }
  if (!previous) {
    return incoming;
  }
  const tappedLine = incoming.start;
  const lowLine = Math.min(previous.start, previous.end);
  const highLine = Math.max(previous.start, previous.end);
  if (tappedLine >= lowLine && tappedLine <= highLine) {
    return null;
  }
  return { ...previous, end: tappedLine };
}
