import type { MessageId } from "@threadlines/contracts";

import type { TranscriptHighlightSourceRole } from "~/lib/transcriptHighlightContext";

/** Text selected in one transcript message, and what its popover is showing. */
export interface TranscriptSelection {
  readonly sourceMessageId: MessageId;
  readonly sourceRole: TranscriptHighlightSourceRole;
  readonly selectedText: string;
  // Where the selection starts and ends in the message body's text, counted
  // the way Range.toString() counts it. The virtual list redraws a row that
  // scrolls far enough away, and these find the same text in the new one.
  readonly textStart: number;
  readonly textEnd: number;
  readonly mode: "actions" | "note";
  readonly note: string;
}

/**
 * The selection after the reader finishes a click, drag or key press in the
 * transcript, given what is selected now. A note with text in it stays until
 * it is added or cancelled; the actions and an empty note follow the page's
 * selection, so a click elsewhere closes them and a new selection replaces
 * them.
 */
export function nextTranscriptSelection(
  current: TranscriptSelection | null,
  selected: TranscriptSelection | null,
): TranscriptSelection | null {
  if (current?.mode === "note" && current.note.trim().length > 0) {
    return current;
  }
  return selected;
}

/** A box in timeline-container coordinates. */
export interface TranscriptSelectionBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface TranscriptSelectionPlacement {
  readonly left: number;
  readonly top: number;
  readonly visible: boolean;
}

export const TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX = 12;
export const TRANSCRIPT_SELECTION_POPOVER_GAP_PX = 8;

/**
 * Where the selection popover goes in the timeline container. It sits below
 * the visible part of its text, or above when below has no room, and stays
 * inside the visible list. `clips` are the boxes of scrollers inside the list
 * that cut the text off, such as a code block scrolled sideways. Once none of
 * the text shows, the actions hide. A note keeps a place at the nearest edge
 * so it can still be typed, and keeps its last place while the list has not
 * drawn its text (`text` is null).
 */
export function placeTranscriptSelectionPopover(input: {
  readonly text: TranscriptSelectionBox | null;
  readonly clips: ReadonlyArray<TranscriptSelectionBox>;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly popover: { readonly width: number; readonly height: number };
  readonly pinned: boolean;
  readonly previous: { readonly left: number; readonly top: number } | null;
}): TranscriptSelectionPlacement {
  const { text, clips, viewport, popover, pinned, previous } = input;
  const margin = TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX;
  const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
  const maxTop = Math.max(margin, viewport.height - popover.height - margin);
  const hidden = { left: previous?.left ?? 0, top: previous?.top ?? 0, visible: false };
  const shown =
    text === null
      ? null
      : clips.reduce(intersectBoxes, {
          top: Math.max(text.top, 0),
          bottom: Math.min(text.bottom, viewport.height),
          left: Math.max(text.left, 0),
          right: Math.min(text.right, viewport.width),
        });
  const textInView = shown !== null && shown.bottom > shown.top && shown.right >= shown.left;
  if (!textInView && !pinned) {
    return hidden;
  }
  const anchor = textInView ? shown : text;
  if (anchor === null) {
    return previous
      ? {
          left: clamp(previous.left, margin, maxLeft),
          top: clamp(previous.top, margin, maxTop),
          visible: true,
        }
      : hidden;
  }
  const below = anchor.bottom + TRANSCRIPT_SELECTION_POPOVER_GAP_PX;
  const above = anchor.top - TRANSCRIPT_SELECTION_POPOVER_GAP_PX - popover.height;
  const fits = (top: number) => top >= margin && top <= maxTop;
  const top = fits(below) ? below : fits(above) ? above : clamp(below, margin, maxTop);
  const left = clamp((anchor.left + anchor.right - popover.width) / 2, margin, maxLeft);
  return { left, top, visible: true };
}

function intersectBoxes(
  a: TranscriptSelectionBox,
  b: TranscriptSelectionBox,
): TranscriptSelectionBox {
  return {
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
