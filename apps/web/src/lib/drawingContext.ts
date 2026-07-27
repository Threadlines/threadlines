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
    // Said plainly, because an agent that assumes the marks are part of the
    // page would try to find them in the source.
    "The attached image is a screenshot of this page with the user's drawing on top.",
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
