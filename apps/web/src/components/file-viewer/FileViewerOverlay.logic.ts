import type { SelectedLineRange } from "@pierre/diffs";

export interface RevealLineNotice {
  requestedLine: number;
}

export interface RevealLineTarget {
  scrollRange: SelectedLineRange;
  selectedRange: SelectedLineRange | null;
  notice: RevealLineNotice | null;
}

export function countRenderableTextLines(content: string): number {
  const normalizedContent = content.endsWith("\n") ? content.slice(0, -1) : content;
  return Math.max(1, normalizedContent.split("\n").length);
}

export function resolveRevealLineRange({
  line,
  endLine,
  totalLines,
}: {
  line: number;
  endLine?: number | null;
  totalLines: number;
}): SelectedLineRange {
  const clampedTotalLines = Math.max(1, Math.floor(totalLines));
  const normalizedLine = Number.isFinite(line) ? Math.floor(line) : 1;
  const start = Math.min(Math.max(1, normalizedLine), clampedTotalLines);
  const normalizedEndLine =
    typeof endLine === "number" && Number.isFinite(endLine) ? Math.floor(endLine) : start;
  const end = Math.min(Math.max(start, normalizedEndLine), clampedTotalLines);
  return { start, end };
}

export function formatSelectedLineRangeLabel(range: SelectedLineRange): string {
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  return startLine === endLine ? `L${startLine} selected` : `L${startLine}-L${endLine} selected`;
}

export function formatRevealLineNoticeLabel(notice: RevealLineNotice): string {
  return `L${notice.requestedLine} is not available in this file`;
}

export function resolveRevealLineTarget({
  line,
  endLine,
  totalLines,
}: {
  line: number;
  endLine?: number | null;
  totalLines: number;
}): RevealLineTarget {
  const scrollRange = resolveRevealLineRange({
    line,
    totalLines,
    ...(endLine !== undefined ? { endLine } : {}),
  });
  const requestedLine = Number.isFinite(line) ? Math.floor(line) : 1;
  const notice = requestedLine === scrollRange.start ? null : { requestedLine };
  return {
    scrollRange,
    selectedRange: notice ? null : scrollRange,
    notice,
  };
}

const PIERRE_CONTAINER_SELECTOR = "diffs-container";

function queryPierreLineElement(root: ParentNode, lineIndex: number): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(`[data-line][data-line-index="${lineIndex}"]`) ??
    root.querySelector<HTMLElement>(`[data-column-number][data-line-index="${lineIndex}"]`)
  );
}

function getShadowRoot(root: ParentNode): ShadowRoot | null {
  return typeof HTMLElement !== "undefined" && root instanceof HTMLElement ? root.shadowRoot : null;
}

export function findRenderedPierreLineElement(
  root: ParentNode,
  lineIndex: number,
): HTMLElement | null {
  const directMatch = queryPierreLineElement(root, lineIndex);
  if (directMatch) {
    return directMatch;
  }

  const hostShadowRoot = getShadowRoot(root);
  const hostMatch = hostShadowRoot ? queryPierreLineElement(hostShadowRoot, lineIndex) : null;
  if (hostMatch) {
    return hostMatch;
  }

  for (const host of root.querySelectorAll<HTMLElement>(PIERRE_CONTAINER_SELECTOR)) {
    if (!host.shadowRoot) {
      continue;
    }
    const shadowMatch = queryPierreLineElement(host.shadowRoot, lineIndex);
    if (shadowMatch) {
      return shadowMatch;
    }
  }

  return null;
}

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
