/**
 * Folds a provider's flat subagent transcript into the shape a conversation
 * reads as. Providers report one entry per transcript record, so a tool call
 * and the result it produced arrive as two entries with nothing linking them:
 * an assistant entry carrying `toolUses`, then a text-less entry carrying the
 * batched `outputPreview`. Pairing them here keeps the rendering component a
 * straight map over items.
 */

export interface SubagentTranscriptEntryLike {
  readonly role: "user" | "assistant" | "system" | "thinking";
  readonly text: string;
  readonly toolUses: ReadonlyArray<{ readonly name: string; readonly summary: string }>;
  readonly outputPreview?: string | undefined;
  /** ISO timestamp, when the provider records one per entry. */
  readonly at?: string | undefined;
}

export interface SubagentTranscriptToolUse {
  /** Stable across refreshes: repeated identical calls in one batch are
   *  distinguished by how many of them came before. */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export type SubagentTranscriptViewItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      readonly at: string | null;
    }
  | {
      readonly kind: "thinking";
      readonly id: string;
      readonly text: string;
      readonly at: string | null;
    }
  | {
      readonly kind: "tools";
      readonly id: string;
      readonly tools: ReadonlyArray<SubagentTranscriptToolUse>;
      readonly output: string | null;
      readonly at: string | null;
    };

interface MutableToolsItem {
  kind: "tools";
  id: string;
  tools: ReadonlyArray<SubagentTranscriptToolUse>;
  output: string | null;
  at: string | null;
}

/**
 * @param entries Consecutive transcript entries in provider order.
 * @param offset Absolute index of the first entry, so item ids stay stable
 *  across pagination.
 */
export function buildSubagentTranscriptView(
  entries: ReadonlyArray<SubagentTranscriptEntryLike>,
  offset = 0,
): ReadonlyArray<SubagentTranscriptViewItem> {
  const items: Array<SubagentTranscriptViewItem> = [];
  let openToolsItem: MutableToolsItem | null = null;

  const attachOutput = (output: string, at: string | null): void => {
    if (openToolsItem) {
      openToolsItem.output =
        openToolsItem.output === null ? output : `${openToolsItem.output}\n${output}`;
      openToolsItem = null;
      return;
    }
    // A result with no call in this page (the call scrolled off the top, or the
    // provider emitted an unpaired record). Show it on its own rather than
    // dropping transcript content.
    items.push({ kind: "tools", id: `${offset + items.length}:output`, tools: [], output, at });
  };

  entries.forEach((entry, index) => {
    const position = offset + index;
    const at = entry.at?.trim() ? entry.at : null;
    const text = entry.text.trim();
    const output = entry.outputPreview?.trim() ? entry.outputPreview : null;

    if (entry.role === "thinking") {
      if (text.length > 0) {
        items.push({ kind: "thinking", id: `${position}:thinking`, text: entry.text, at });
      }
      return;
    }

    if (text.length > 0) {
      // Text after a tool call belongs to the next beat of the conversation.
      openToolsItem = null;
      items.push({
        kind: "message",
        id: `${position}:message`,
        role: entry.role,
        text: entry.text,
        at,
      });
    }

    if (entry.toolUses.length > 0) {
      const toolsItem: MutableToolsItem = {
        kind: "tools",
        id: `${position}:tools`,
        tools: keyToolUses(position, entry.toolUses),
        output: null,
        at,
      };
      items.push(toolsItem);
      openToolsItem = toolsItem;
    }

    if (output !== null) {
      attachOutput(output, at);
    }
  });

  return items;
}

function keyToolUses(
  position: number,
  toolUses: ReadonlyArray<{ readonly name: string; readonly summary: string }>,
): ReadonlyArray<SubagentTranscriptToolUse> {
  const occurrences = new Map<string, number>();
  return toolUses.map((toolUse) => {
    const contentKey = `${toolUse.name}\u0000${toolUse.summary}`;
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return {
      id: `${position}:${contentKey}:${occurrence}`,
      name: toolUse.name,
      summary: toolUse.summary,
    };
  });
}

/** The prompt an agent was spawned with is context, not a step it took, so it
 *  is lifted out of the thread and shown above it. Only the very first entry of
 *  the transcript qualifies: a later instruction is a mid-run message to the
 *  agent and belongs on the thread with everything else.
 *
 *  @param atTranscriptStart False when the page starts mid-transcript, where
 *   the first visible item is not the spawn prompt. */
export function splitSubagentTranscriptLead(
  items: ReadonlyArray<SubagentTranscriptViewItem>,
  atTranscriptStart: boolean,
): {
  readonly lead: Extract<SubagentTranscriptViewItem, { kind: "message" }> | null;
  readonly steps: ReadonlyArray<SubagentTranscriptViewItem>;
} {
  const [first] = items;
  if (!atTranscriptStart || first === undefined || first.kind !== "message") {
    return { lead: null, steps: items };
  }
  return first.role === "assistant"
    ? { lead: null, steps: items }
    : { lead: first, steps: items.slice(1) };
}

/** The provider only writes a transcript record once a message completes, so a
 *  running agent's newest words arrive on the event stream first. Show them as
 *  a tail until the transcript catches up, and drop the tail as soon as the
 *  last rendered message covers it. */
export function shouldShowSubagentLiveTail(
  items: ReadonlyArray<SubagentTranscriptViewItem>,
  liveBody: string | null,
): boolean {
  const live = liveBody?.trim();
  if (!live) {
    return false;
  }
  const lastMessage = items.findLast((item) => item.kind === "message");
  if (lastMessage === undefined || lastMessage.kind !== "message") {
    return true;
  }
  const rendered = lastMessage.text.trim();
  return !rendered.startsWith(live) && !live.startsWith(rendered);
}

/** Refreshes re-fetch the visible page, so every entry arrives as a new object
 *  even when nothing changed. Comparing content lets unchanged rows keep their
 *  rendered markdown instead of re-rendering on every poll. */
export function isSameSubagentTranscriptItem(
  left: SubagentTranscriptViewItem,
  right: SubagentTranscriptViewItem,
): boolean {
  if (left.kind !== right.kind || left.id !== right.id || left.at !== right.at) {
    return false;
  }
  if (left.kind === "message") {
    return left.text === (right as typeof left).text && left.role === (right as typeof left).role;
  }
  if (left.kind === "thinking") {
    return left.text === (right as typeof left).text;
  }
  const other = right as typeof left;
  return (
    left.output === other.output &&
    left.tools.length === other.tools.length &&
    left.tools.every((tool, index) => tool.id === other.tools[index]?.id)
  );
}

/** The provider falls back to `<tool>: <args>` for tools it has no preview
 *  for; the row already shows the name, so drop the repeat. */
export function formatSubagentToolPreview(toolUse: SubagentTranscriptToolUse): string {
  const summary = toolUse.summary.trim();
  const prefix = `${toolUse.name}:`;
  return summary.toLowerCase().startsWith(prefix.toLowerCase())
    ? summary.slice(prefix.length).trim()
    : summary;
}

/** Single-line label for tooltips and titles. */
export function formatSubagentToolLabel(toolUse: SubagentTranscriptToolUse): string {
  const preview = formatSubagentToolPreview(toolUse);
  return preview.length > 0 ? `${toolUse.name} - ${preview}` : toolUse.name;
}
