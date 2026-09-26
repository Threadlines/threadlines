/**
 * Folds a provider's flat subagent transcript into the shape a conversation
 * reads as. Providers report one entry per transcript record, so a tool call
 * and the result it produced arrive as two entries with nothing linking them:
 * an assistant entry carrying `toolUses`, then a text-less entry carrying the
 * batched `outputPreview`. Pairing them here keeps the rendering component a
 * straight map over items.
 */

import type { WorkLogEntry } from "../../session-logic";
import {
  activityStepForOrphanOutput,
  activityStepFromTranscriptTool,
  activityStepFromWorkLogEntry,
  type ActivityStep,
} from "./activitySteps";

export interface SubagentTranscriptEntryLike {
  readonly id?: string | undefined;
  readonly role: "user" | "assistant" | "system" | "thinking";
  readonly text: string;
  readonly toolUses: ReadonlyArray<{
    readonly name: string;
    readonly summary: string;
    readonly description?: string | undefined;
  }>;
  readonly outputPreview?: string | undefined;
  readonly outputIsError?: boolean | undefined;
  /** ISO timestamp, when the provider records one per entry. */
  readonly at?: string | undefined;
}

export interface SubagentTranscriptToolUse {
  /** Stable across refreshes: repeated identical calls in one batch are
   *  distinguished by how many of them came before. */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly description?: string | undefined;
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
      /** The provider marked the calls' results as errors. */
      readonly outputFailed: boolean;
      readonly at: string | null;
    };

interface MutableToolsItem {
  kind: "tools";
  id: string;
  tools: ReadonlyArray<SubagentTranscriptToolUse>;
  output: string | null;
  outputFailed: boolean;
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

  const attachOutput = (
    output: string,
    failed: boolean,
    at: string | null,
    entryKey: string,
  ): void => {
    if (openToolsItem) {
      openToolsItem.output =
        openToolsItem.output === null ? output : `${openToolsItem.output}\n${output}`;
      openToolsItem.outputFailed ||= failed;
      openToolsItem = null;
      return;
    }
    // A result with no call in this page (the call scrolled off the top, or the
    // provider emitted an unpaired record). Show it on its own rather than
    // dropping transcript content.
    items.push({
      kind: "tools",
      id: `${entryKey}:output`,
      tools: [],
      output,
      outputFailed: failed,
      at,
    });
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
        outputFailed: false,
        at,
      };
      items.push(toolsItem);
      openToolsItem = toolsItem;
    }

    if (output !== null) {
      attachOutput(output, entry.outputIsError === true, at, entryKey);
    }
  });

  return items;
}

function keyToolUses(
  entryKey: string,
  toolUses: SubagentTranscriptEntryLike["toolUses"],
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
      ...(toolUse.description ? { description: toolUse.description } : {}),
    };
  });
}

export type SubagentTranscriptToolsItem = Extract<SubagentTranscriptViewItem, { kind: "tools" }>;

/**
 * A stretch of back-to-back tool calls between two things the agent said. It
 * renders like the conversation's own activity: the looking around folded into
 * one line, the steps worth noticing on lines of their own.
 */
export interface SubagentTranscriptToolRun {
  readonly kind: "tool-run";
  readonly id: string;
  readonly steps: ReadonlyArray<ActivityStep>;
}

/** Child-owned activity that the parent event stream saw but the provider's
 * stored transcript did not. Codex code-mode `exec` calls currently have this
 * shape: they are durable work-log entries, while `thread/read` returns only
 * the child's prose. */
export interface SubagentTranscriptActivityRun {
  readonly kind: "activity-run";
  readonly id: string;
  readonly steps: ReadonlyArray<ActivityStep>;
  readonly running: boolean;
}

/** Everything that is not tool machinery: the agent's prose, its reasoning, and
 *  messages sent to it. Tool rows only reach the thread inside a run. */
export type SubagentTranscriptProseItem = Exclude<SubagentTranscriptViewItem, { kind: "tools" }>;

export type SubagentTranscriptStep =
  | { readonly kind: "item"; readonly id: string; readonly item: SubagentTranscriptProseItem }
  | SubagentTranscriptToolRun;

/**
 * Folds each run of consecutive tool rows into one activity group, leaving prose
 * and reasoning rows exactly where they are, so the transcript reads as the
 * agent's words with its steps summed up between them.
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

    grouped.push({
      kind: "tool-run",
      id: `${run[0]?.id ?? String(index)}:run`,
      steps: run.flatMap(toolsItemSteps),
    });
  }

  return grouped;
}

/** Tool runs the agent has written after, which read as one line, like the
 *  conversation's own stretches. */
export function foldedToolRunIds(
  steps: ReadonlyArray<SubagentTranscriptStep>,
): ReadonlySet<string> {
  const folded = new Set<string>();
  let agentWroteAfter = false;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "tool-run") {
      if (agentWroteAfter) folded.add(step.id);
    } else if (step.item.kind === "message") {
      if (step.item.role === "assistant") agentWroteAfter = true;
      else if (step.item.role === "user") agentWroteAfter = false;
    }
  }
  return folded;
}

/** One provider record's calls as steps. A record's output belongs to its calls
 *  as a batch, so only a lone call can claim it (and its error flag). */
function toolsItemSteps(item: SubagentTranscriptToolsItem): ReadonlyArray<ActivityStep> {
  if (item.tools.length === 0) {
    // A result whose call is on an earlier page: keep its output reachable.
    return item.output ? [activityStepForOrphanOutput(item.id, item.output)] : [];
  }
  const lone = item.tools.length === 1;
  return item.tools.map((tool) =>
    activityStepFromTranscriptTool({
      id: tool.id,
      name: tool.name,
      summary: tool.summary,
      description: tool.description,
      output: lone ? (item.output ?? undefined) : undefined,
      failed: lone && item.outputFailed,
    }),
  );
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
  const steps: ActivityStep[] = [];
  for (const entry of actions) {
    const name = activityToolName(entry);
    const summary = activityToolSummary(entry);
    if (transcriptToolSignatures.has(normalizedToolSignature(name, summary))) {
      continue;
    }
    const step = activityStepFromWorkLogEntry(entry);
    if (step) {
      steps.push(step);
    }
  }

  const firstStep = steps[0];
  if (!firstStep) {
    return null;
  }
  return {
    kind: "activity-run",
    id: `activity-run:${firstStep.id}`,
    steps,
    running: steps.some((step) => step.running),
  };
}

export type SubagentTranscriptLead = Extract<SubagentTranscriptViewItem, { kind: "message" }>;

/** The prompt an agent was spawned with is context, not a step it took, so it
 *  is lifted out of the thread and shown above it. Only the very first entry of
 *  the transcript qualifies: a later instruction is a mid-run message to the
 *  agent and belongs on the thread with everything else.
 *
 *  @param atTranscriptStart False when the page starts mid-transcript, where
 *   the first visible item is not the spawn prompt.
 *  @param firstEntry The transcript's first record, read separately when the
 *   page starts mid-transcript. The panel opens on the newest page, and a
 *   working agent's transcript is far longer than one page, so without this
 *   the prompt would only ever surface after paging all the way back. */
export function splitSubagentTranscriptLead(
  items: ReadonlyArray<SubagentTranscriptViewItem>,
  atTranscriptStart: boolean,
  firstEntry?: SubagentTranscriptEntryLike | null,
): {
  readonly lead: SubagentTranscriptLead | null;
  readonly steps: ReadonlyArray<SubagentTranscriptViewItem>;
} {
  if (!atTranscriptStart) {
    const lead = firstEntry
      ? splitSubagentTranscriptLead(buildSubagentTranscriptView([firstEntry], 0), true).lead
      : null;
    return { lead, steps: items };
  }
  const [first] = items;
  if (first === undefined || first.kind !== "message" || first.role === "assistant") {
    return { lead: null, steps: items };
  }
  return { lead: first, steps: items.slice(1) };
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
 * The block sits above the thread as the setup for whatever page is showing,
 * so which page is showing does not decide whether it appears.
 */
export function resolveSubagentTranscriptInstruction(
  lead: SubagentTranscriptLead | null,
  objective: string | null | undefined,
): SubagentTranscriptInstruction | null {
  if (lead) {
    return {
      text: lead.text,
      at: lead.at,
      label: lead.role === "user" ? "Instruction" : "System",
    };
  }
  const trimmedObjective = objective?.trim();
  return trimmedObjective ? { text: trimmedObjective, at: null, label: "Instruction" } : null;
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
    left.outputFailed === other.outputFailed &&
    left.tools.length === other.tools.length &&
    left.tools.every((tool, index) => tool.id === other.tools[index]?.id)
  );
}
