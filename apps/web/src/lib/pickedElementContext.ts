import type { DesktopPreviewPickedElement, ThreadId } from "@threadlines/contracts";

import { appendBlockToPrompt } from "./fileSelectionContext";

/**
 * An element the user pointed at in the browser preview, carried alongside the
 * message rather than pasted into it.
 *
 * Deliberately a description, not a handle. The node id that identified the
 * element while picking dies with the document, and by the time the agent acts
 * the page may have reloaded -- but a role, an accessible name and a selector
 * still find it, and they are how elements are identified everywhere else in
 * this feature.
 */
export interface PickedElementContext {
  tagName: string;
  role: string | null;
  name: string | null;
  selector: string;
  text: string | null;
  width: number;
  height: number;
  url: string;
}

export interface PickedElementContextDraft extends PickedElementContext {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export function pickedElementFromPreview(
  element: DesktopPreviewPickedElement,
): PickedElementContext {
  return {
    tagName: element.tagName,
    role: element.role,
    name: element.name,
    selector: element.selector,
    text: element.text,
    width: element.rect.width,
    height: element.rect.height,
    url: element.url,
  };
}

export function normalizePickedElementContextDraft(
  draft: PickedElementContextDraft,
): PickedElementContextDraft | null {
  const selector = draft.selector.trim();
  // Without a selector there is nothing to act on and nothing to show, which
  // makes the chip a promise the message cannot keep.
  if (selector === "") {
    return null;
  }
  return {
    ...draft,
    selector,
    tagName: draft.tagName.trim() === "" ? "element" : draft.tagName.trim(),
    role: draft.role?.trim() === "" ? null : (draft.role ?? null),
    name: draft.name?.trim() === "" ? null : (draft.name ?? null),
    text: draft.text?.trim() === "" ? null : (draft.text ?? null),
  };
}

/** Two picks of the same element on the same page are one context. */
export function pickedElementContextDedupKey(context: PickedElementContext): string {
  return `${context.url}::${context.selector}`;
}

/** Enough words to recognise a region by, without turning a chip into a paragraph. */
function firstWords(text: string, maxLength: number): string | null {
  // Only the first line: an element's opening line is what identifies it, and
  // everything after it belongs to its children.
  const collapsed = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") {
    return null;
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  // Break on a word so the label reads as language rather than a truncation,
  // and drop the punctuation left at the break -- "environment.…" reads worse
  // than the sentence it came from.
  const stem = (lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).replace(
    /[\s.,;:!?-]+$/,
    "",
  );
  return `${stem}…`;
}

/**
 * The chip's label.
 *
 * Role and name first, because that is how you would ask someone else to find
 * the thing on screen. Failing that, the element's own words -- a section is
 * recognisable by what it says, not by the path that reaches it. A CSS path is
 * the last thing a person wants to read, so it lives in the tooltip instead.
 */
export function formatPickedElementContextLabel(context: PickedElementContext): string {
  if (context.role !== null && context.name !== null) {
    return `${context.role} "${context.name}"`;
  }
  if (context.name !== null) {
    return `"${context.name}"`;
  }
  const snippet = context.text === null ? null : firstWords(context.text, 32);
  return snippet === null ? context.tagName : `${context.tagName} · "${snippet}"`;
}

export function formatPickedElementContextBlock(context: PickedElementContext): string {
  const lines = [
    `tag: ${context.tagName}`,
    ...(context.role === null ? [] : [`role: ${context.role}`]),
    ...(context.name === null ? [] : [`name: ${context.name}`]),
    `selector: ${context.selector}`,
    ...(context.text === null || context.text === context.name ? [] : [`text: ${context.text}`]),
    `size: ${context.width}x${context.height}`,
    `url: ${context.url}`,
  ];
  return `<selected_element>\n${lines.join("\n")}\n</selected_element>`;
}

export function appendPickedElementContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<PickedElementContext>,
): string {
  const seen = new Set<string>();
  return contexts.reduce((current, context) => {
    const key = pickedElementContextDedupKey(context);
    if (seen.has(key)) {
      return current;
    }
    seen.add(key);
    return appendBlockToPrompt(current, formatPickedElementContextBlock(context));
  }, prompt);
}
