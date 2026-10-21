import type { MessageId } from "@threadlines/contracts";
import { CheckIcon, CopyIcon, SquarePenIcon } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import type { TranscriptHighlightContextSelection } from "~/lib/transcriptHighlightContext";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  handleTranscriptHighlightNoteFormSubmit,
  handleTranscriptHighlightNoteKeyDown,
} from "./TranscriptHighlightContextCard";
import {
  nextTranscriptSelection,
  placeTranscriptSelectionPopover,
  TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX,
  type TranscriptSelection,
} from "./TranscriptSelectionPopover.logic";

const TRANSCRIPT_SELECTION_TEXT_MAX_CHARS = 8_000;
const TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS = 800;
const TRANSCRIPT_NOTE_HIGHLIGHT_MAX_RECTS = 256;
const TRANSCRIPT_NOTE_POPOVER_WIDTH_PX = 320;
const TRANSCRIPT_SELECTION_POPOVER_SELECTOR = "[data-transcript-selection-popover='true']";
const TRANSCRIPT_MESSAGE_BODY_SELECTOR = "[data-transcript-message-body='true']";

// A scroller between the selected text and the timeline that can cut the
// text off, and on which axes it does.
type ClippingAncestor = { element: Element; clipsX: boolean; clipsY: boolean };

// One selected line fragment painted while the note editor holds focus,
// relative to the selection's bounding box.
type TranscriptNoteHighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * The copy and add-note popover over text selected in the transcript. Lives
 * inside the timeline container, listens to it for finished selections, and
 * keeps the popover beside its text as the list scrolls, streams and resizes.
 * It owns its state, so opening it or typing a note leaves the timeline alone.
 */
export function TranscriptSelectionLayer({
  containerRef,
  onAddHighlight,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  onAddHighlight: (selection: TranscriptHighlightContextSelection) => void;
}) {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const listeners = new AbortController();
    let gesture: AbortController | null = null;
    let frameId: number | null = null;
    const refresh = () => {
      frameId = null;
      const selected = readTranscriptSelection(container);
      setSelection((current) => nextTranscriptSelection(current, selected));
    };
    const scheduleRefresh = () => {
      frameId ??= window.requestAnimationFrame(refresh);
    };
    // A drag that scrolls the list ends wherever the pointer stopped, often
    // over the composer or past the window's edge, so the release is heard on
    // the window. A press on a scrollbar selects nothing and changes nothing.
    container.addEventListener(
      "mousedown",
      (event) => {
        if (
          event.button !== 0 ||
          isInsideTranscriptSelectionPopover(event.target) ||
          isScrollbarPress(event)
        ) {
          return;
        }
        gesture?.abort();
        const current = new AbortController();
        gesture = current;
        window.addEventListener(
          "mouseup",
          () => {
            current.abort();
            scheduleRefresh();
          },
          { capture: true, signal: current.signal },
        );
      },
      { capture: true, signal: listeners.signal },
    );
    container.addEventListener(
      "keyup",
      (event) => {
        if (!isInsideTranscriptSelectionPopover(event.target)) {
          scheduleRefresh();
        }
      },
      { capture: true, signal: listeners.signal },
    );
    return () => {
      listeners.abort();
      gesture?.abort();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [containerRef]);

  // The actions belong to the page's selection: once it is gone (a click
  // anywhere, focus moving to the composer, or the list dropping the row it
  // was in) they go too.
  const actionsOpen = selection?.mode === "actions";
  useEffect(() => {
    if (!actionsOpen) {
      return;
    }
    const handleSelectionChange = () => {
      const pageSelection = document.getSelection();
      if (pageSelection && pageSelection.rangeCount > 0 && !pageSelection.isCollapsed) {
        return;
      }
      setSelection((current) => (current?.mode === "actions" ? null : current));
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [actionsOpen]);

  const dismiss = useCallback(() => {
    setSelection(null);
  }, []);
  const openNote = useCallback(() => {
    setSelection((current) => (current ? { ...current, mode: "note" } : current));
  }, []);
  const changeNote = useCallback((note: string) => {
    setSelection((current) => (current ? { ...current, note } : current));
  }, []);
  const submitNote = useCallback(() => {
    if (!selection) {
      return;
    }
    const note = selection.note.trim();
    if (note.length === 0) {
      return;
    }
    onAddHighlight({
      sourceMessageId: selection.sourceMessageId,
      sourceRole: selection.sourceRole,
      selectedText: selection.selectedText,
      note,
    });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [onAddHighlight, selection]);

  if (!selection) {
    return null;
  }
  return (
    <TranscriptSelectionPopover
      key={`${selection.sourceMessageId}:${selection.textStart}:${selection.textEnd}`}
      selection={selection}
      containerRef={containerRef}
      onCopied={dismiss}
      onOpenNote={openNote}
      onNoteChange={changeNote}
      onSubmitNote={submitNote}
      onCancel={dismiss}
    />
  );
}

function TranscriptSelectionPopover({
  selection,
  containerRef,
  onCopied,
  onOpenNote,
  onNoteChange,
  onSubmitNote,
  onCancel,
}: {
  selection: TranscriptSelection;
  containerRef: RefObject<HTMLDivElement | null>;
  onCopied: () => void;
  onOpenNote: () => void;
  onNoteChange: (note: string) => void;
  onSubmitNote: () => void;
  onCancel: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastPlacementRef = useRef<{ left: number; top: number } | null>(null);
  const highlightShapeRef = useRef<{ range: Range; width: number; height: number } | null>(null);
  const [highlightRects, setHighlightRects] = useState<readonly TranscriptNoteHighlightRect[]>([]);
  // timeout: 0 keeps the checkmark painted until the delayed dismiss unmounts
  // the popover, so it never flips back to the copy icon mid-animation.
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 0 });
  const { sourceMessageId, textStart, textEnd } = selection;
  const noting = selection.mode === "note";
  const noteIsEmpty = selection.note.trim().length === 0;

  // Opening the note form cancels the close a copy scheduled, so a quick
  // Copy then Add note does not lose the note.
  useEffect(() => {
    if (!isCopied || noting) {
      return;
    }
    const timeoutId = window.setTimeout(onCopied, TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isCopied, noting, onCopied]);

  useEffect(() => {
    if (!noting) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      noteInputRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [noting]);

  // Placement is written straight to the DOM on each scroll frame, so
  // following the text never re-renders React.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const popover = popoverRef.current;
    if (!container || !popover) {
      return;
    }
    let frameId: number | null = null;
    let reshapeHighlight = true;
    // The live range over the selected text, and the scrollers that clip it.
    // Found again when the list redraws the row, or when anything inside the
    // message changes (a re-highlighted code block can swap one end's text
    // node and leave the range covering the wrong text).
    let anchor: {
      body: HTMLElement;
      range: Range;
      clips: ReadonlyArray<ClippingAncestor>;
    } | null = null;
    const bodyObserver = new MutationObserver(() => {
      anchor = null;
      reshapeHighlight = true;
      scheduleUpdate();
    });
    const resolveAnchor = () => {
      if (anchor?.body.isConnected) {
        return anchor;
      }
      anchor = null;
      bodyObserver.disconnect();
      const body = findTranscriptMessageBodyById(container, sourceMessageId);
      const range = body ? rangeAtTextOffsets(body, textStart, textEnd) : null;
      if (body && range) {
        bodyObserver.observe(body, { childList: true, characterData: true, subtree: true });
        anchor = { body, range, clips: findClippingAncestors(range, container) };
      }
      return anchor;
    };
    const update = () => {
      frameId = null;
      const resolved = resolveAnchor();
      const range = resolved?.range ?? null;
      const containerRect = container.getBoundingClientRect();
      const toContainerBox = (rect: DOMRect) => ({
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top,
        left: rect.left - containerRect.left,
        right: rect.right - containerRect.left,
      });
      const textRect = range?.getBoundingClientRect() ?? null;
      const text =
        textRect && (textRect.width > 0 || textRect.height > 0) ? toContainerBox(textRect) : null;
      const clips = (resolved?.clips ?? []).map(({ element, clipsX, clipsY }) => {
        const box = toContainerBox(element.getBoundingClientRect());
        return {
          top: clipsY ? box.top : -Infinity,
          bottom: clipsY ? box.bottom : Infinity,
          left: clipsX ? box.left : -Infinity,
          right: clipsX ? box.right : Infinity,
        };
      });
      const placement = placeTranscriptSelectionPopover({
        text,
        clips,
        viewport: { width: containerRect.width, height: containerRect.height },
        popover: { width: popover.offsetWidth, height: popover.offsetHeight },
        pinned: noting,
        previous: lastPlacementRef.current,
      });
      if (placement.visible) {
        lastPlacementRef.current = { left: placement.left, top: placement.top };
      }
      popover.style.transform = `translate(${placement.left}px, ${placement.top}px)`;
      popover.style.visibility = placement.visible ? "visible" : "hidden";

      const highlight = highlightRef.current;
      if (!highlight) {
        return;
      }
      if (!range || !textRect || !text) {
        highlight.style.visibility = "hidden";
        return;
      }
      const shape = highlightShapeRef.current;
      if (
        reshapeHighlight ||
        shape?.range !== range ||
        shape.width !== textRect.width ||
        shape.height !== textRect.height
      ) {
        reshapeHighlight = false;
        highlightShapeRef.current = { range, width: textRect.width, height: textRect.height };
        setHighlightRects(measureNoteHighlightRects(range, textRect));
      }
      // Placed by left/top, not transform: a transform starts a stacking
      // context, and the highlight's blend mode would then have no text to
      // blend with and paint over it.
      highlight.style.left = `${text.left}px`;
      highlight.style.top = `${text.top}px`;
      highlight.style.visibility = "visible";
    };
    const scheduleUpdate = () => {
      frameId ??= window.requestAnimationFrame(update);
    };
    update();
    // Scroll events do not bubble, but a capturing listener on the container
    // hears the list's own scrolling.
    container.addEventListener("scroll", scheduleUpdate, { capture: true, passive: true });
    const resizeObserver = new ResizeObserver(() => {
      reshapeHighlight = true;
      scheduleUpdate();
    });
    resizeObserver.observe(container);
    resizeObserver.observe(popover);
    return () => {
      container.removeEventListener("scroll", scheduleUpdate, { capture: true });
      resizeObserver.disconnect();
      bodyObserver.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [containerRef, noting, sourceMessageId, textStart, textEnd]);

  return (
    <>
      {noting ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div ref={highlightRef} className="absolute top-0 left-0">
            {highlightRects.map((rect) => (
              <div
                key={`${rect.top}:${rect.left}:${rect.width}`}
                className="transcript-note-highlight absolute"
                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div
        ref={popoverRef}
        // Capped to the list's height: in a short list the note form scrolls
        // inside itself, so Add and Cancel stay on screen.
        className="absolute top-0 left-0 z-40 flex flex-col"
        style={{
          width: noting ? TRANSCRIPT_NOTE_POPOVER_WIDTH_PX : undefined,
          maxWidth: `calc(100% - ${TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX * 2}px)`,
          maxHeight: `calc(100% - ${TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX * 2}px)`,
        }}
        data-transcript-selection-popover="true"
        onMouseDown={(event) => {
          if (!noting) {
            event.preventDefault();
          }
          event.stopPropagation();
        }}
      >
        {noting ? (
          <form
            className="min-h-0 overflow-y-auto rounded-lg border border-border/75 bg-popover/96 p-2 text-popover-foreground shadow-lg shadow-black/10 backdrop-blur"
            onSubmit={(event) => handleTranscriptHighlightNoteFormSubmit(event, onSubmitNote)}
          >
            <p className="mb-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {selection.selectedText}
            </p>
            <Textarea
              ref={noteInputRef}
              size="sm"
              value={selection.note}
              onChange={(event) => onNoteChange(event.currentTarget.value)}
              placeholder="Add context for this highlight"
              className="text-xs"
              onKeyDown={(event) =>
                handleTranscriptHighlightNoteKeyDown(event, {
                  onSubmit: onSubmitNote,
                  onCancel,
                })
              }
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" size="xs" disabled={noteIsEmpty}>
                Add
              </Button>
            </div>
          </form>
        ) : (
          <div className="inline-flex items-center gap-1 rounded-lg border border-border/75 bg-popover/96 px-1.5 py-1 text-popover-foreground shadow-lg shadow-black/10 backdrop-blur">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Copy selected text"
                    onClick={() => copyToClipboard(selection.selectedText, undefined)}
                  />
                }
              >
                {isCopied ? (
                  <CheckIcon className="copy-check-pop size-3 text-success" />
                ) : (
                  <CopyIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">Copy selected text</TooltipPopup>
            </Tooltip>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onOpenNote}
              className="h-6 px-2 text-xs"
            >
              <SquarePenIcon className="size-3" />
              Add note
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function isInsideTranscriptSelectionPopover(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(TRANSCRIPT_SELECTION_POPOVER_SELECTOR) !== null
  );
}

// A press past an element's client area lands on its scrollbar. Inline
// elements report no client area at all, so they never count.
function isScrollbarPress(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement) || (target.clientWidth === 0 && target.clientHeight === 0)) {
    return false;
  }
  const bounds = target.getBoundingClientRect();
  const x = event.clientX - bounds.left - target.clientLeft;
  const y = event.clientY - bounds.top - target.clientTop;
  return x >= target.clientWidth || y >= target.clientHeight;
}

/** The page's selection, when it covers text inside one finished transcript message. */
function readTranscriptSelection(container: HTMLElement): TranscriptSelection | null {
  const pageSelection = window.getSelection();
  if (!pageSelection || pageSelection.rangeCount === 0 || pageSelection.isCollapsed) {
    return null;
  }
  const selectedText = pageSelection.toString().trim();
  if (selectedText.length === 0) {
    return null;
  }
  const range = pageSelection.getRangeAt(0);
  const body = findTranscriptMessageBody(range.startContainer);
  if (
    !body ||
    body !== findTranscriptMessageBody(range.endContainer) ||
    !container.contains(body)
  ) {
    return null;
  }
  if (body.dataset.transcriptMessageStreaming === "true") {
    return null;
  }
  const sourceMessageId = body.dataset.transcriptMessageId;
  const sourceRole = body.dataset.transcriptMessageRole;
  if (!sourceMessageId || (sourceRole !== "assistant" && sourceRole !== "user")) {
    return null;
  }
  return {
    sourceMessageId: sourceMessageId as MessageId,
    sourceRole,
    selectedText: selectedText.slice(0, TRANSCRIPT_SELECTION_TEXT_MAX_CHARS),
    textStart: textOffsetWithin(body, range.startContainer, range.startOffset),
    textEnd: textOffsetWithin(body, range.endContainer, range.endOffset),
    mode: "actions",
    note: "",
  };
}

function findTranscriptMessageBody(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(TRANSCRIPT_MESSAGE_BODY_SELECTOR) ?? null;
}

function findClippingAncestors(range: Range, container: HTMLElement): ClippingAncestor[] {
  const clips: ClippingAncestor[] = [];
  const start = range.commonAncestorContainer;
  for (
    let element = start instanceof Element ? start : start.parentElement;
    element && element !== container;
    element = element.parentElement
  ) {
    const style = window.getComputedStyle(element);
    const clipsX = style.overflowX !== "visible";
    const clipsY = style.overflowY !== "visible";
    if (clipsX || clipsY) {
      clips.push({ element, clipsX, clipsY });
    }
  }
  return clips;
}

function findTranscriptMessageBodyById(
  container: HTMLElement,
  messageId: MessageId,
): HTMLElement | null {
  for (const body of container.querySelectorAll<HTMLElement>(TRANSCRIPT_MESSAGE_BODY_SELECTOR)) {
    if (body.dataset.transcriptMessageId === messageId) {
      return body;
    }
  }
  return null;
}

// How much of `root`'s text comes before a boundary point inside it.
function textOffsetWithin(root: Node, node: Node, offset: number): number {
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

// The range over `root`'s text from `start` to `end`, the inverse of
// textOffsetWithin. A start on a boundary between text nodes opens the next
// node and an end there closes the previous one, so the range never reaches
// into a neighbouring line.
function rangeAtTextOffsets(root: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const next = consumed + text.data.length;
    if (!startNode && start < next) {
      startNode = text;
      startOffset = start - consumed;
    }
    if (startNode && end <= next) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(text, end - consumed);
      return range;
    }
    consumed = next;
  }
  return null;
}

// The native selection stops painting once the note textarea takes focus, so
// the selected range is re-painted as overlay rects while the note is open.
// CSS ::highlight() can't be used here: Chromium paints custom highlights at
// the font's ascent/descent height while native selection fills the whole
// line box, so the two visibly disagree. Expanding each text fragment's rect
// to its element's line-height reproduces the native selection geometry.
function measureNoteHighlightRects(range: Range, origin: DOMRect): TranscriptNoteHighlightRect[] {
  const rects: TranscriptNoteHighlightRect[] = [];
  for (const textNode of collectRangeTextNodes(range)) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);
    if (textNode === range.startContainer) {
      nodeRange.setStart(textNode, range.startOffset);
    }
    if (textNode === range.endContainer) {
      nodeRange.setEnd(textNode, range.endOffset);
    }
    const lineHeight = textNode.parentElement
      ? Number.parseFloat(window.getComputedStyle(textNode.parentElement).lineHeight)
      : Number.NaN;
    const fragmentRects = nodeRange.getClientRects();
    for (let index = 0; index < fragmentRects.length; index += 1) {
      const rect = fragmentRects[index];
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const expansion =
        Number.isFinite(lineHeight) && lineHeight > rect.height
          ? (lineHeight - rect.height) / 2
          : 0;
      rects.push({
        left: rect.left - origin.left,
        top: rect.top - origin.top - expansion,
        width: rect.width,
        height: rect.height + expansion * 2,
      });
      if (rects.length >= TRANSCRIPT_NOTE_HIGHLIGHT_MAX_RECTS) {
        return rects;
      }
    }
  }
  return rects;
}

function collectRangeTextNodes(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root instanceof Text) {
    return [root];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}
