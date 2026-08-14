/**
 * Folds a provider's flat subagent transcript into the shape a conversation
 * reads as. Providers report one entry per transcript record, so a tool call
 * and the result it produced arrive as two entries with nothing linking them:
 * an assistant entry carrying `toolUses`, then a text-less entry carrying the
 * batched `outputPreview`. Pairing them here keeps the rendering component a
 * straight map over items.
 */

import type { WorkLogEntry } from "../../session-logic";

export interface SubagentTranscriptEntryLike {
  readonly id?: string | undefined;
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

  const attachOutput = (output: string, at: string | null, entryKey: string): void => {
    if (openToolsItem) {
      openToolsItem.output =
        openToolsItem.output === null ? output : `${openToolsItem.output}\n${output}`;
      openToolsItem = null;
      return;
    }
    // A result with no call in this page (the call scrolled off the top, or the
    // provider emitted an unpaired record). Show it on its own rather than
    // dropping transcript content.
    items.push({ kind: "tools", id: `${entryKey}:output`, tools: [], output, at });
  };

  entries.forEach((entry, index) => {
    const position = offset + index;
    const entryKey = entry.id ?? String(position);
    const at = entry.at?.trim() ? entry.at : null;
    const text = entry.text.trim();
    const output = entry.outputPreview?.trim() ? entry.outputPreview : null;

    if (entry.role === "thinking") {
      if (text.length > 0) {
        items.push({ kind: "thinking", id: `${entryKey}:thinking`, text: entry.text, at });
      }
      return;
    }

    if (text.length > 0) {
      // Text after a tool call belongs to the next beat of the conversation.
      openToolsItem = null;
      items.push({
        kind: "message",
        id: `${entryKey}:message`,
        role: entry.role,
        text: entry.text,
        at,
      });
    }

    if (entry.toolUses.length > 0) {
      const toolsItem: MutableToolsItem = {
        kind: "tools",
        id: `${entryKey}:tools`,
        tools: keyToolUses(entryKey, entry.toolUses),
        output: null,
        at,
      };
      items.push(toolsItem);
      openToolsItem = toolsItem;
    }

    if (output !== null) {
      attachOutput(output, at, entryKey);
    }
  });

  return items;
}

function keyToolUses(
  entryKey: string,
  toolUses: ReadonlyArray<{ readonly name: string; readonly summary: string }>,
): ReadonlyArray<SubagentTranscriptToolUse> {
  const occurrences = new Map<string, number>();
  return toolUses.map((toolUse) => {
    const contentKey = `${toolUse.name}\u0000${toolUse.summary}`;
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return {
      id: `${entryKey}:${contentKey}:${occurrence}`,
      name: toolUse.name,
      summary: toolUse.summary,
    };
  });
}

export type SubagentTranscriptToolsItem = Extract<SubagentTranscriptViewItem, { kind: "tools" }>;

/**
 * A stretch of back-to-back tool calls, folded into one receipt. The agent's own
 * prose is what a reader is following; twenty Read rows between two paragraphs
 * are the machinery under it, and they push the prose off the screen.
 */
export interface SubagentTranscriptToolRun {
  readonly kind: "tool-run";
  readonly id: string;
  readonly items: ReadonlyArray<SubagentTranscriptToolsItem>;
  /** Total tool calls across the run, which is what the receipt counts. */
  readonly actionCount: number;
  /** `Read ×5, Edit ×8, Bash ×1`, busiest first, capped at three kinds. */
  readonly toolSummary: string;
  /** First call to last call, when the provider timestamped both. */
  readonly durationMs: number | null;
}

/** Child-owned activity that the parent event stream saw but the provider's
 * stored transcript did not. Codex code-mode `exec` calls currently have this
 * shape: they are durable work-log entries, while `thread/read` returns only
 * the child's prose. */
export interface SubagentTranscriptActivityRun extends Omit<SubagentTranscriptToolRun, "kind"> {
  readonly kind: "activity-run";
  readonly latestLabel: string;
  readonly latestPreview: string;
  readonly running: boolean;
}

/** Everything that is not tool machinery: the agent's prose, its reasoning, and
 *  messages sent to it. Tool rows only reach the thread inside a run. */
export type SubagentTranscriptProseItem = Exclude<SubagentTranscriptViewItem, { kind: "tools" }>;

export type SubagentTranscriptStep =
  | { readonly kind: "item"; readonly id: string; readonly item: SubagentTranscriptProseItem }
  | SubagentTranscriptToolRun;

const MAX_SUMMARIZED_TOOL_KINDS = 3;

/**
 * Folds each run of consecutive tool rows into one receipt, leaving prose and
 * reasoning rows exactly where they are. Every run gets a receipt, down to a
 * single call: the transcript then reads as prose with receipts between it, and
 * a lone tool row can no longer sit on the thread in a shape of its own.
 */
export function groupSubagentTranscriptSteps(
  steps: ReadonlyArray<SubagentTranscriptViewItem>,
): ReadonlyArray<SubagentTranscriptStep> {
  const grouped: Array<SubagentTranscriptStep> = [];
  let index = 0;

  while (index < steps.length) {
    const step = steps[index];
    if (step === undefined) {
      index += 1;
      continue;
    }
    if (step.kind !== "tools") {
      grouped.push({ kind: "item", id: step.id, item: step });
      index += 1;
      continue;
    }

    const run: Array<SubagentTranscriptToolsItem> = [];
    while (index < steps.length) {
      const candidate = steps[index];
      if (candidate === undefined || candidate.kind !== "tools") {
        break;
      }
      run.push(candidate);
      index += 1;
    }

    const actionCount = run.reduce((total, item) => total + item.tools.length, 0);
    grouped.push({
      kind: "tool-run",
      id: `${run[0]?.id ?? String(index)}:run`,
      items: run,
      actionCount,
      toolSummary: summarizeToolRunNames(run),
      durationMs: toolRunDurationMs(run),
    });
  }

  return grouped;
}

/** The receipt's leading count, in the conversation's wording: `1 action`,
 *  `14 actions`. A run can carry no calls at all -- a result whose call sits on
 *  an earlier page -- and "0 actions" would read as if nothing happened. */
export function formatSubagentToolRunActions(run: { readonly actionCount: number }): string {
  if (run.actionCount === 0) {
    return "Tool output";
  }
  return `${run.actionCount.toLocaleString()} ${run.actionCount === 1 ? "action" : "actions"}`;
}

/**
 * Where the spine's node belongs on a step: the row's own top padding plus half
 * its first text line, so the dot reads as belonging to the words rather than to
 * the line above them. Agent prose renders at 12px/18px; every other row leads
 * with a 20px meta line (a receipt, reasoning, a folded message header).
 *
 * Mirrors the row padding and line heights in `SubagentTranscript.tsx`, which
 * the transcript's geometry test measures against the rendered panel.
 */
const TRANSCRIPT_ROW_PADDING_TOP_PX = 4;
const TRANSCRIPT_PROSE_LINE_PX = 18;
const TRANSCRIPT_META_LINE_PX = 20;

export function subagentStepNodeOffsetPx(step: SubagentTranscriptStep): number {
  const firstLinePx =
    step.kind === "item" && step.item.kind === "message" && step.item.role === "assistant"
      ? TRANSCRIPT_PROSE_LINE_PX
      : TRANSCRIPT_META_LINE_PX;
  return TRANSCRIPT_ROW_PADDING_TOP_PX + firstLinePx / 2;
}

function summarizeToolRunNames(run: ReadonlyArray<SubagentTranscriptToolsItem>): string {
  const counts = new Map<string, number>();
  for (const item of run) {
    for (const tool of item.tools) {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
  }
  // Busiest kinds lead; insertion order breaks ties so the line is stable
  // across refreshes rather than reshuffling equal counts.
  const ordered = [...counts.entries()].toSorted((left, right) => right[1] - left[1]);
  const shown = ordered.slice(0, MAX_SUMMARIZED_TOOL_KINDS);
  const hiddenKinds = ordered.length - shown.length;
  const parts = shown.map(([name, count]) => `${name} ×${count}`);
  if (hiddenKinds > 0) {
    parts.push(`+${hiddenKinds} more`);
  }
  return parts.join(", ");
}

function toolRunDurationMs(run: ReadonlyArray<SubagentTranscriptToolsItem>): number | null {
  const timestamps = run
    .map((item) => (item.at === null ? null : Date.parse(item.at)))
    .filter((value): value is number => value !== null && !Number.isNaN(value));
  const first = timestamps[0];
  const last = timestamps.at(-1);
  if (first === undefined || last === undefined || last <= first) {
    return null;
  }
  return last - first;
}

function normalizedToolSignature(name: string, summary: string): string {
  return `${name.trim().toLowerCase()}\u0000${summary.trim().replace(/\s+/gu, " ")}`;
}

function activityToolName(entry: WorkLogEntry): string {
  switch (entry.itemType) {
    case "command_execution":
      return "shell_command";
    case "file_change":
      return "apply_patch";
    case "web_search":
      return "web_search";
    case "image_view":
      return "view_image";
    default:
      return entry.toolTitle?.trim() || entry.label.trim() || "tool";
  }
}

function activityToolSummary(entry: WorkLogEntry): string {
  return (
    entry.rawCommand?.trim() ||
    entry.command?.trim() ||
    entry.detail?.trim() ||
    entry.toolTitle?.trim() ||
    ""
  );
}

function activityLatestLabel(entry: WorkLogEntry): string {
  if (entry.executionState !== "running") {
    return entry.label.trim() || "Used tool";
  }
  switch (entry.itemType) {
    case "command_execution":
      return "Running command";
    case "file_change":
      return "Editing files";
    case "web_search":
      return "Searching the web";
    default:
      return entry.label.trim() || "Using tool";
  }
}

/**
 * Builds the one expandable activity receipt the inspector owns for child work
 * that is absent from the provider transcript. Existing transcript tools win;
 * matching activity rows are removed so providers that do persist their calls
 * do not render the same command twice.
 */
export function buildSubagentTranscriptActivityRun(
  entries: ReadonlyArray<WorkLogEntry>,
  transcriptItems: ReadonlyArray<SubagentTranscriptViewItem>,
): SubagentTranscriptActivityRun | null {
  const transcriptToolSignatures = new Set(
    transcriptItems.flatMap((item) =>
      item.kind === "tools"
        ? item.tools.map((tool) => normalizedToolSignature(tool.name, tool.summary))
        : [],
    ),
  );
  const actions = entries.filter(
    (entry) =>
      entry.sourceAgentThreadId !== undefined &&
      entry.tone !== "thinking" &&
      entry.itemType !== undefined,
  );
  const items: SubagentTranscriptToolsItem[] = [];
  const retainedEntries: WorkLogEntry[] = [];

  for (const entry of actions) {
    const name = activityToolName(entry);
    const summary = activityToolSummary(entry);
    if (transcriptToolSignatures.has(normalizedToolSignature(name, summary))) {
      continue;
    }
    retainedEntries.push(entry);
    items.push({
      kind: "tools",
      id: `activity:${entry.toolCallId ?? entry.id}`,
      tools: [
        {
          id: `activity:${entry.toolCallId ?? entry.id}:tool`,
          name,
          summary,
        },
      ],
      output: entry.outputPreview?.trim() || null,
      at: entry.createdAt.trim() || null,
    });
  }

  const latestEntry = retainedEntries.at(-1);
  if (!latestEntry || items.length === 0) {
    return null;
  }

  return {
    kind: "activity-run",
    id: `activity-run:${items[0]?.id ?? latestEntry.id}`,
    items,
    actionCount: items.length,
    toolSummary: summarizeToolRunNames(items),
    durationMs: toolRunDurationMs(items),
    latestLabel: activityLatestLabel(latestEntry),
    latestPreview: activityToolSummary(latestEntry),
    running: retainedEntries.some((entry) => entry.executionState === "running"),
  };
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

export interface SubagentTranscriptInstruction {
  readonly text: string;
  readonly at: string | null;
  readonly label: "Instruction" | "System";
}

/**
 * What the block above the thread shows as the instruction the agent was given.
 *
 * A Claude child's first stored record is its spawn prompt, so its transcript
 * carries its own instruction. Codex spawns a child by forking the parent, and
 * a forked child's transcript starts at its first real turn, so it carries no
 * leading message at all: the objective the agent was spawned with stands in,
 * being the same information from the only place that still holds it.
 *
 * @param atTranscriptStart False when the page starts mid-transcript, where an
 *  instruction of any kind would be claiming a beginning that is not on screen.
 */
export function resolveSubagentTranscriptInstruction(
  lead: Extract<SubagentTranscriptViewItem, { kind: "message" }> | null,
  objective: string | null | undefined,
  atTranscriptStart: boolean,
): SubagentTranscriptInstruction | null {
  if (lead) {
    return {
      text: lead.text,
      at: lead.at,
      label: lead.role === "user" ? "Instruction" : "System",
    };
  }
  const trimmedObjective = objective?.trim();
  if (!atTranscriptStart || !trimmedObjective) {
    return null;
  }
  return { text: trimmedObjective, at: null, label: "Instruction" };
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
