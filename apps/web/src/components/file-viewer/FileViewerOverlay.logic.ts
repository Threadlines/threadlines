import type { SelectedLineRange } from "@pierre/diffs";

import type { FileEditSeed } from "../../fileViewerStore";

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
interface KeydownLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Whether a keydown produces a plain printable character: modifier chords
 * stay hotkeys and multi-character keys (Enter, Escape, arrows, F-keys)
 * keep their navigation meaning. This is the filter for buffering onto a
 * pending edit seed, where space is ordinary typing.
 */
export function isPrintableKeydown(event: KeydownLike): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return event.key.length === 1;
}

/**
 * Whether a view-mode keydown reads as typing intent, i.e. should flip the
 * preview into edit mode and replay the keystroke there. Space is excluded
 * on top of the printable filter so it remains available for scrolling.
 */
export function isTypeToEditKeydown(event: KeydownLike): boolean {
  return isPrintableKeydown(event) && event.key !== " ";
}

/**
 * Whether the (composed-path-innermost) event target already accepts text
 * input — the tree's search box, or any editable surface — so type-to-edit
 * must not steal the keystroke.
 */
export function isEditableEventTarget(target: EventTarget | null | undefined): boolean {
  const element = target as Partial<Element> | null | undefined;
  if (!element || typeof element.closest !== "function") {
    return false;
  }
  return element.closest("input, textarea, select, [contenteditable]") !== null;
}

export type DoubleClickEditTarget =
  | { kind: "code"; lineIndex: number | null }
  | { kind: "line-number-gutter" };

/**
 * Classify a double-click inside the preview from its composed event path
 * (pierre renders into a shadow root, so `event.target` alone is the host).
 * Line numbers and the gutter are the line-selection affordance and never
 * enter edit mode; clicks on code resolve the 0-based line they landed on,
 * or null when the click hit padding outside any rendered row.
 */
export function resolveDoubleClickEditTarget(
  eventPath: readonly EventTarget[],
): DoubleClickEditTarget {
  for (const target of eventPath) {
    const element = target as Partial<Element>;
    if (typeof element.getAttribute !== "function" || typeof element.hasAttribute !== "function") {
      continue;
    }
    if (element.hasAttribute("data-column-number") || element.hasAttribute("data-gutter")) {
      return { kind: "line-number-gutter" };
    }
    const lineIndexValue = element.getAttribute("data-line-index");
    if (lineIndexValue !== null) {
      const lineIndex = Number.parseInt(lineIndexValue, 10);
      return { kind: "code", lineIndex: Number.isNaN(lineIndex) ? null : lineIndex };
    }
  }
  return { kind: "code", lineIndex: null };
}

/** Character offset of the end of a 0-based line, clamped into the file. */
export function lineEndCharacter(content: string, lineIndex: number): number {
  const lines = content.split("\n");
  const clampedIndex = Math.min(Math.max(lineIndex, 0), lines.length - 1);
  return lines[clampedIndex]?.length ?? 0;
}

interface EditorCaretPosition {
  line: number;
  character: number;
}

/** The slice of pierre's `Editor` that seed application needs. */
export interface EditSeedEditor {
  setSelections(
    selections: {
      start: EditorCaretPosition;
      end: EditorCaretPosition;
      direction: "none" | "forward" | "backward";
    }[],
  ): void;
  applyEdits(
    edits: { range: { start: EditorCaretPosition; end: EditorCaretPosition }; newText: string }[],
    updateHistory?: boolean,
  ): void;
}

/**
 * Land the caret where the edit-mode entry gesture happened and replay the
 * keystroke that triggered it (as a normal, undoable edit).
 */
export function applyEditSeedToEditor(editor: EditSeedEditor, seed: FileEditSeed): void {
  const caret = { line: seed.line, character: seed.character };
  editor.setSelections([{ start: caret, end: caret, direction: "none" }]);
  if (seed.insertText !== undefined && seed.insertText.length > 0) {
    editor.applyEdits([{ range: { start: caret, end: caret }, newText: seed.insertText }], true);
    const afterInsert = { line: seed.line, character: seed.character + seed.insertText.length };
    editor.setSelections([{ start: afterInsert, end: afterInsert, direction: "none" }]);
  }
}

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
