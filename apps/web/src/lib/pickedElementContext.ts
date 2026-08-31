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
  /** Ties elements attached in one act to the note they share, so they show
   *  as one chip and serialize as one block. Absent on a lone pick. */
  groupId?: string;
}

export interface PickedElementContextDraft extends PickedElementContext {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export function pickedElementFromPreview(
  element: DesktopPreviewPickedElement,
  groupId?: string,
): PickedElementContext {
  return {
    // The key is present only when set: persisted drafts must not carry an
    // explicit undefined through the schema.
    ...(groupId === undefined ? {} : { groupId }),
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

/**
 * Two picks are one context only when the second adds nothing: the same
 * element on the same page, carrying the same note, grouping and style
 * tweaks. That still collapses the miss-click and the re-check, but a
 * re-pick that says something new is a new statement about the element,
 * and silently dropping it would lose what the user said.
 */
export function pickedElementContextDedupKey(context: PickedElementContext): string {
  return [
    context.url,
    context.selector,
    context.groupId ?? "",
    context.note ?? "",
    context.styleChanges.map(formatStyleChange).join(";"),
  ].join("::");
}

/**
 * Clusters contexts the way the user attached them: elements sharing a
 * groupId travel together, everything else stands alone. Cluster order
 * follows each cluster's first appearance, so nothing visibly reorders.
 */
export function groupPickedElementContexts<T extends PickedElementContext>(
  contexts: ReadonlyArray<T>,
): T[][] {
  const clusters: T[][] = [];
  const byGroup = new Map<string, T[]>();
  for (const context of contexts) {
    if (context.groupId === undefined) {
      clusters.push([context]);
      continue;
    }
    const cluster = byGroup.get(context.groupId);
    if (cluster === undefined) {
      const opened = [context];
      byGroup.set(context.groupId, opened);
      clusters.push(opened);
    } else {
      cluster.push(context);
    }
  }
  return clusters;
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

/**
 * One block for elements that share a note: the note said once over the
 * list, rather than repeated on every element as if it were several
 * requests. The elements share one page by construction, so the url is
 * group-level too; "element:" opens each member.
 */
export function formatPickedElementGroupBlock(
  contexts: ReadonlyArray<PickedElementContext>,
): string {
  const note = contexts.find((context) => context.note !== null)?.note ?? null;
  const lines = [
    ...(note === null ? [] : [`note: ${note}`]),
    `url: ${contexts[0]?.url ?? ""}`,
    ...contexts.flatMap((context) => [
      `element: ${context.tagName}`,
      ...(context.role === null ? [] : [`role: ${context.role}`]),
      ...(context.name === null ? [] : [`name: ${context.name}`]),
      `selector: ${context.selector}`,
      ...(context.text === null || context.text === context.name ? [] : [`text: ${context.text}`]),
      `size: ${context.width}x${context.height}`,
      ...(context.styleChanges.length === 0
        ? []
        : [`proposed styles: ${context.styleChanges.map(formatStyleChange).join("; ")}`]),
    ]),
  ];
  return `<selected_elements>\n${lines.join("\n")}\n</selected_elements>`;
}

export function appendPickedElementContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<PickedElementContext>,
): string {
  const seen = new Set<string>();
  const deduped = contexts.filter((context) => {
    const key = pickedElementContextDedupKey(context);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return groupPickedElementContexts(deduped).reduce((current, cluster) => {
    const [first] = cluster;
    if (first === undefined) {
      return current;
    }
    const block =
      cluster.length === 1
        ? formatPickedElementContextBlock(first)
        : formatPickedElementGroupBlock(cluster);
    return appendBlockToPrompt(current, block);
  }, prompt);
}

// The body must not cross a closing tag, or two adjacent blocks read as one
// with the earlier block's fields overwritten by the later's.
const TRAILING_SELECTED_ELEMENT_BLOCK_PATTERN =
  /\n*<selected_element>\n((?:(?!<\/selected_element>)[\s\S])*)\n<\/selected_element>\s*$/;

// The two patterns cannot take each other's blocks: the singular pattern
// needs "<selected_element>\n" exactly, which the plural tag's trailing "s"
// breaks, and vice versa.
const TRAILING_SELECTED_ELEMENTS_GROUP_BLOCK_PATTERN =
  /\n*<selected_elements>\n((?:(?!<\/selected_elements>)[\s\S])*)\n<\/selected_elements>\s*$/;

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

/** The keys formatPickedElementGroupBlock writes; "element" opens a member. */
const SELECTED_ELEMENTS_GROUP_BLOCK_KEYS = [
  "note",
  "url",
  "element",
  "role",
  "name",
  "selector",
  "text",
  "size",
  "proposed styles",
] as const;

type SelectedElementsGroupBlockKey = (typeof SELECTED_ELEMENTS_GROUP_BLOCK_KEYS)[number];

/**
 * The inverse of formatPickedElementGroupBlock. Fields before the first
 * "element:" line belong to the group; each "element:" opens a member that
 * owns the fields after it. The members come back sharing a fresh groupId,
 * so they render as the one chip they were attached as.
 */
export function parsePickedElementGroupBlock(block: string): PickedElementContext[] | null {
  const groupFields = new Map<SelectedElementsGroupBlockKey, string>();
  const members: Array<Map<SelectedElementsGroupBlockKey, string>> = [];
  let fields = groupFields;
  let currentKey: SelectedElementsGroupBlockKey | null = null;
  for (const line of block.split("\n")) {
    const key = SELECTED_ELEMENTS_GROUP_BLOCK_KEYS.find((candidate) =>
      line.startsWith(`${candidate}: `),
    );
    if (key === "element") {
      fields = new Map();
      members.push(fields);
    }
    if (key !== undefined) {
      currentKey = key;
      fields.set(key, line.slice(key.length + 2));
      continue;
    }
    if (currentKey !== null) {
      fields.set(currentKey, `${fields.get(currentKey) ?? ""}\n${line}`);
    }
  }
  const groupId = crypto.randomUUID();
  const note = groupFields.get("note") ?? null;
  const url = groupFields.get("url") ?? "";
  const contexts = members.flatMap((member): PickedElementContext[] => {
    // The same rule as the single block: without a selector there is nothing
    // to act on, and a chip would promise otherwise.
    const selector = member.get("selector")?.trim() ?? "";
    if (selector === "") {
      return [];
    }
    const size = /^(\d+)x(\d+)$/.exec(member.get("size")?.trim() ?? "");
    return [
      {
        groupId,
        note,
        styleChanges: parseStyleChanges(member.get("proposed styles") ?? ""),
        tagName: member.get("element")?.trim() || "element",
        role: member.get("role") ?? null,
        name: member.get("name") ?? null,
        selector,
        text: member.get("text") ?? null,
        width: size === null ? 0 : Number(size[1]),
        height: size === null ? 0 : Number(size[2]),
        url,
      },
    ];
  });
  return contexts.length === 0 ? null : contexts;
}

/**
 * Peel trailing <selected_element> and <selected_elements> blocks off a sent
 * message.
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
    const single = TRAILING_SELECTED_ELEMENT_BLOCK_PATTERN.exec(remaining);
    if (single !== null) {
      const parsed = parsePickedElementContextBlock(single[1] ?? "");
      if (parsed === null) {
        break;
      }
      contexts.unshift(parsed);
      remaining = remaining.slice(0, single.index);
      continue;
    }
    const group = TRAILING_SELECTED_ELEMENTS_GROUP_BLOCK_PATTERN.exec(remaining);
    if (group === null) {
      break;
    }
    const parsed = parsePickedElementGroupBlock(group[1] ?? "");
    if (parsed === null) {
      break;
    }
    contexts.unshift(...parsed);
    remaining = remaining.slice(0, group.index);
  }
  return {
    promptText: contexts.length === 0 ? prompt : remaining.replace(/\n+$/, ""),
    contexts,
  };
}
