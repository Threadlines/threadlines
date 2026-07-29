import type { ThreadId } from "@threadlines/contracts";

import { appendBlockToPrompt } from "./fileSelectionContext";
import { formatPickedElementDescriptor, type PickedElementContext } from "./pickedElementContext";

/**
 * Something the user drew on the page.
 *
 * One thing, not several. A drawing produces a picture and sometimes a list of
 * elements, but it is a single act and reads as one -- exploding it into an
 * image plus a chip per element buries a one-word note under four items the
 * user did not ask for.
 *
 * The picture is the part that always means something. Elements are only here
 * when a stroke actually closed around something; an arrow, an underline or a
 * sketch of what the thing should look like encloses nothing, and naming what
 * happened to fall inside its bounding box would be a confident guess at
 * something nobody said.
 */
export interface DrawingContext {
  /** Why this matters, in the user's words. */
  note: string | null;
  /** A PNG data URL of the page with the ink on it. */
  imageDataUrl: string;
  url: string;
  /** What the closed strokes went round. Empty for an arrow or a sketch. */
  elements: PickedElementContext[];
}

export interface DrawingContextDraft extends DrawingContext {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

/** The chip's label. A drawing has no name of its own, so it says what it is. */
export function formatDrawingDescriptor(context: DrawingContext): string {
  if (context.elements.length === 1) {
    return `Drawing · ${formatPickedElementDescriptor(context.elements[0]!)}`;
  }
  if (context.elements.length > 1) {
    return `Drawing · ${context.elements.length} elements`;
  }
  return "Drawing";
}

/**
 * The words that travel with the picture.
 *
 * The image goes as an image, so this only carries what a picture cannot: what
 * the user said about it, where it was, and -- when a stroke closed around
 * something -- which elements those were, so the agent can find them in the
 * source rather than only look at them.
 */
// Said plainly, because an agent that assumes the marks are part of the
// page would try to find them in the source.
const DRAWING_IMAGE_SENTENCE =
  "The attached image is a screenshot of this page with the user's drawing on top.";

export function formatDrawingContextBlock(context: DrawingContext): string {
  const lines = [
    ...(context.note === null ? [] : [`note: ${context.note}`]),
    `url: ${context.url}`,
    ...(context.elements.length === 0
      ? []
      : [
          `circled: ${context.elements
            .map((element) => `${formatPickedElementDescriptor(element)} (${element.selector})`)
            .join("; ")}`,
        ]),
    DRAWING_IMAGE_SENTENCE,
  ];
  return `<drawing>\n${lines.join("\n")}\n</drawing>`;
}

export function appendDrawingContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<DrawingContext>,
): string {
  return contexts.reduce(
    (current, context) => appendBlockToPrompt(current, formatDrawingContextBlock(context)),
    prompt,
  );
}

// The body must not cross a closing tag, or two adjacent blocks read as one.
const TRAILING_DRAWING_BLOCK_PATTERN =
  /\n*<drawing>\n((?:(?!<\/drawing>)[\s\S])*)\n<\/drawing>\s*$/;

/**
 * A drawing read back out of a sent message. The picture travelled as an
 * attachment, so the block only ever carried the words; this is those words,
 * with the circled elements kept as the labels they were written as.
 */
export interface ParsedDrawingContextEntry {
  note: string | null;
  url: string;
  /** `descriptor (selector)` labels, one per circled element. */
  circled: string[];
}

export interface ExtractedDrawingContexts {
  promptText: string;
  contexts: ParsedDrawingContextEntry[];
}

function parseDrawingContextBlock(block: string): ParsedDrawingContextEntry {
  let note: string | null = null;
  let url = "";
  let circled: string[] = [];
  let inNote = false;
  for (const line of block.split("\n")) {
    if (line === DRAWING_IMAGE_SENTENCE) {
      inNote = false;
    } else if (line.startsWith("url: ")) {
      url = line.slice("url: ".length);
      inNote = false;
    } else if (line.startsWith("circled: ")) {
      circled = line.slice("circled: ".length).split("; ");
      inNote = false;
    } else if (line.startsWith("note: ")) {
      note = line.slice("note: ".length);
      inNote = true;
    } else if (inNote) {
      // Only the note may span lines: it is the one field a person typed.
      note = `${note ?? ""}\n${line}`;
    }
  }
  return { note, url, circled };
}

/** Peel trailing <drawing> blocks off a sent message. */
export function extractTrailingDrawingContexts(prompt: string): ExtractedDrawingContexts {
  const contexts: ParsedDrawingContextEntry[] = [];
  let remaining = prompt;
  for (;;) {
    const match = TRAILING_DRAWING_BLOCK_PATTERN.exec(remaining);
    if (match === null) {
      break;
    }
    contexts.unshift(parseDrawingContextBlock(match[1] ?? ""));
    remaining = remaining.slice(0, match.index);
  }
  return {
    promptText: contexts.length === 0 ? prompt : remaining.replace(/\n+$/, ""),
    contexts,
  };
}

/** The chip's label for a drawing read back out of a sent message. */
export function formatParsedDrawingDescriptor(entry: ParsedDrawingContextEntry): string {
  if (entry.circled.length === 1) {
    return "Drawing · 1 element";
  }
  if (entry.circled.length > 1) {
    return `Drawing · ${entry.circled.length} elements`;
  }
  return "Drawing";
}
