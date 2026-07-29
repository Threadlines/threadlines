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
/** A style value tried on the page, kept as a proposal for the agent. */
export interface PickedElementStyleChange {
  property: string;
  from: string;
  to: string;
}

export interface PickedElementContext {
  /** Why this element matters, in the user's words. Optional: a bare element
   *  is still worth attaching, it just says less. */
  note: string | null;
  /** Tweaks made while annotating; the page was a scratch pad, not an edit. */
  styleChanges: PickedElementStyleChange[];
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
    note: element.note,
    styleChanges: element.styleChanges.map((change) => ({ ...change })),
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
  const note = draft.note?.trim();
  return {
    ...draft,
    note: note === undefined || note === "" ? null : note,
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
/** What the element is, independent of what was said about it. */
export function formatPickedElementDescriptor(context: PickedElementContext): string {
  if (context.role !== null && context.name !== null) {
    return `${context.role} "${context.name}"`;
  }
  if (context.name !== null) {
    return `"${context.name}"`;
  }
  const snippet = context.text === null ? null : firstWords(context.text, 32);
  return snippet === null ? context.tagName : `${context.tagName} · "${snippet}"`;
}

/** "16px → 18px", the form a person would write it in. */
export function formatStyleChange(change: PickedElementStyleChange): string {
  return `${change.property}: ${change.from} → ${change.to}`;
}

export function formatPickedElementContextBlock(context: PickedElementContext): string {
  const lines = [
    ...(context.note === null ? [] : [`note: ${context.note}`]),
    `tag: ${context.tagName}`,
    ...(context.role === null ? [] : [`role: ${context.role}`]),
    ...(context.name === null ? [] : [`name: ${context.name}`]),
    `selector: ${context.selector}`,
    ...(context.text === null || context.text === context.name ? [] : [`text: ${context.text}`]),
    `size: ${context.width}x${context.height}`,
    `url: ${context.url}`,
    // Labelled as proposed so the agent changes the source rather than
    // assuming the change is already made.
    ...(context.styleChanges.length === 0
      ? []
      : [`proposed styles: ${context.styleChanges.map(formatStyleChange).join("; ")}`]),
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

// The body must not cross a closing tag, or two adjacent blocks read as one
// with the earlier block's fields overwritten by the later's.
const TRAILING_SELECTED_ELEMENT_BLOCK_PATTERN =
  /\n*<selected_element>\n((?:(?!<\/selected_element>)[\s\S])*)\n<\/selected_element>\s*$/;

/** The keys formatPickedElementContextBlock writes, in the order it writes them. */
const SELECTED_ELEMENT_BLOCK_KEYS = [
  "note",
  "tag",
  "role",
  "name",
  "selector",
  "text",
  "size",
  "url",
  "proposed styles",
] as const;

type SelectedElementBlockKey = (typeof SELECTED_ELEMENT_BLOCK_KEYS)[number];

export interface ExtractedPickedElementContexts {
  promptText: string;
  contexts: PickedElementContext[];
}

function parseStyleChanges(value: string): PickedElementStyleChange[] {
  return value
    .split("; ")
    .map((entry) => /^(.+?): (.*?) → (.*)$/.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ property: match[1]!, from: match[2]!, to: match[3]! }));
}

/**
 * The inverse of formatPickedElementContextBlock, so a sent message can show
 * the element as the chip it was attached as rather than as the serialized
 * lines the agent reads.
 *
 * A line that opens with a known key starts that field; any other line
 * continues the one before it, because a note or an element's text is allowed
 * to span lines and nothing else is.
 */
export function parsePickedElementContextBlock(block: string): PickedElementContext | null {
  const fields = new Map<SelectedElementBlockKey, string>();
  let currentKey: SelectedElementBlockKey | null = null;
  for (const line of block.split("\n")) {
    const key = SELECTED_ELEMENT_BLOCK_KEYS.find((candidate) => line.startsWith(`${candidate}: `));
    if (key !== undefined) {
      currentKey = key;
      fields.set(key, line.slice(key.length + 2));
      continue;
    }
    if (currentKey !== null) {
      fields.set(currentKey, `${fields.get(currentKey) ?? ""}\n${line}`);
    }
  }
  const selector = fields.get("selector")?.trim() ?? "";
  // The same rule as normalizePickedElementContextDraft: without a selector
  // there is nothing to act on, and a chip would promise otherwise.
  if (selector === "") {
    return null;
  }
  const size = /^(\d+)x(\d+)$/.exec(fields.get("size")?.trim() ?? "");
  return {
    note: fields.get("note") ?? null,
    styleChanges: parseStyleChanges(fields.get("proposed styles") ?? ""),
    tagName: fields.get("tag")?.trim() || "element",
    role: fields.get("role") ?? null,
    name: fields.get("name") ?? null,
    selector,
    text: fields.get("text") ?? null,
    width: size === null ? 0 : Number(size[1]),
    height: size === null ? 0 : Number(size[2]),
    url: fields.get("url") ?? "",
  };
}

/**
 * Peel trailing <selected_element> blocks off a sent message.
 *
 * Stops at the first block it cannot represent as a chip: hiding text the chip
 * would not carry loses what the user said, so anything unparseable stays
 * visible as the text it always was.
 */
export function extractTrailingPickedElementContexts(
  prompt: string,
): ExtractedPickedElementContexts {
  const contexts: PickedElementContext[] = [];
  let remaining = prompt;
  for (;;) {
    const match = TRAILING_SELECTED_ELEMENT_BLOCK_PATTERN.exec(remaining);
    if (match === null) {
      break;
    }
    const parsed = parsePickedElementContextBlock(match[1] ?? "");
    if (parsed === null) {
      break;
    }
    contexts.unshift(parsed);
    remaining = remaining.slice(0, match.index);
  }
  return {
    promptText: contexts.length === 0 ? prompt : remaining.replace(/\n+$/, ""),
    contexts,
  };
}
