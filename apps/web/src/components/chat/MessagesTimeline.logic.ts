import * as Equal from "effect/Equal";
import {
  type ModelFallbackState,
  type ForkContextEntry,
  type SubagentResultEntry,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@threadlines/contracts";
import { stripCodexInlineVisualizationDirectives } from "../../lib/codexInlineVisualization";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

/**
 * Lane-entry labels for subagent work rows. Subagent activity can interleave
 * with main-model rows (and with other agents' rows) mid-turn, so a row only
 * gets its agent label when the previous rendered row belongs to a different
 * lane — a main-model row, another agent, a group boundary. Contiguous
 * same-agent runs and rows directly under their own spawn row stay bare.
 */
export function deriveSubagentLaneLabels(
  entries: ReadonlyArray<WorkLogEntry>,
): ReadonlyArray<string | null> {
  const laneKeyOf = (entry: WorkLogEntry): string | null => {
    if (entry.subagentTask) {
      return entry.subagentTask.toolUseId ?? entry.subagentTask.subagentType ?? "subagent";
    }
    // A collab spawn/update row anchors the same lane as the rows it spawned.
    if (entry.itemType === "collab_agent_tool_call" && entry.toolCallId) {
      return entry.toolCallId;
    }
    return null;
  };

  return entries.map((entry, index) => {
    if (!entry.subagentTask) {
      return null;
    }
    const previous = index > 0 ? entries[index - 1] : undefined;
    if (previous && laneKeyOf(previous) === laneKeyOf(entry)) {
      return null;
    }
    return entry.subagentTask.subagentType ?? "subagent";
  });
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      /** Agent lifecycle entries this group swallowed. Never rendered and never
       *  counted, but kept so the group still exists on a turn that did nothing
       *  but delegate: the turn's agent tracker and its duration hang off it. */
      agentAnchorEntries: WorkLogEntry[];
      /** The turns this group shows the agent tracker for. A tracker summarizes
       *  a whole turn, so only the turn's first group carries it; a later group
       *  in the same turn would repeat the same bars and count. Empty means this
       *  group shows no tracker at all. */
      trackerTurnIds: TurnId[];
      /** Spawn call ids the tracker falls back to when the group has no turn to
       *  key on. A background agent keeps streaming after its spawning turn
       *  settles, and that activity arrives turnless — these ids let the tail
       *  group name an agent no turn claims. The selector ignores ids whose
       *  agent carries a turn attribution: that agent's tracker lives with the
       *  spawning turn's group, and repeating it here would double the "Agent
       *  working" row. Only populated when `trackerTurnIds` is empty. */
      trackerAgentSpawnIds: string[];
      isLive: boolean;
      liveStartedAt: string | null;
      /** True while the turn this group belongs to is still working. Groups in
       *  the active exchange keep their live-spine shape (frozen, no accent)
       *  instead of collapsing into a receipt mid-turn — the settle happens
       *  once, when the turn ends. */
      inActiveExchange: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      completionSummary: string | null;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnInProgress: boolean;
      assistantModelFallback?: ModelFallbackState | undefined;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "subagent-result";
      id: string;
      createdAt: string;
      result: SubagentResultEntry;
    }
  | {
      kind: "fork-context";
      id: string;
      createdAt: string;
      forkContext: ForkContextEntry;
    }
  | { kind: "working"; id: string; createdAt: string | null; label: string };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const copyText = text === null ? null : stripCodexInlineVisualizationDirectives(text);
  const hasText = copyText !== null && copyText.trim().length > 0;
  return {
    text: hasText ? copyText : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

const UNKEYED_TURN_SIGNAL = "__unkeyed_turn__";

function turnSignalKey(turnId: TurnId | null | undefined): string {
  return turnId ?? UNKEYED_TURN_SIGNAL;
}

function isRunningCommandWorkEntry(entry: WorkLogEntry): boolean {
  return (
    entry.executionState === "running" &&
    (entry.requestKind === "command" ||
      entry.itemType === "command_execution" ||
      entry.command !== undefined)
  );
}

function isCommandSupersedingWorkEntry(entry: WorkLogEntry): boolean {
  return entry.tone === "thinking";
}

function inferSupersededRunningCommandEntryIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): Set<string> {
  const supersededEntryIds = new Set<string>();
  const laterThinkingOrAssistantByTurn = new Set<string>();

  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "message") {
      if (timelineEntry.message.role === "assistant") {
        laterThinkingOrAssistantByTurn.add(turnSignalKey(timelineEntry.message.turnId));
      }
      continue;
    }

    if (timelineEntry.kind !== "work") {
      continue;
    }

    const { entry } = timelineEntry;
    if (
      isRunningCommandWorkEntry(entry) &&
      laterThinkingOrAssistantByTurn.has(turnSignalKey(entry.turnId))
    ) {
      supersededEntryIds.add(entry.id);
    }

    if (isCommandSupersedingWorkEntry(entry)) {
      laterThinkingOrAssistantByTurn.add(turnSignalKey(entry.turnId));
    }
  }

  return supersededEntryIds;
}

function settleSupersededRunningCommandEntry(
  entry: WorkLogEntry,
  supersededRunningCommandEntryIds: ReadonlySet<string>,
): WorkLogEntry {
  if (!supersededRunningCommandEntryIds.has(entry.id)) {
    return entry;
  }
  return { ...entry, executionState: "completed" };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

function deriveModelFallbackByTurn(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, ModelFallbackState> {
  const fallbackByTurn = new Map<string, ModelFallbackState>();
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "work" || !timelineEntry.entry.modelFallback) {
      continue;
    }
    fallbackByTurn.set(
      turnSignalKey(timelineEntry.entry.modelFallback.turnId),
      timelineEntry.entry.modelFallback,
    );
  }
  return fallbackByTurn;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  completionSummary?: string | null;
  isWorking: boolean;
  /** Agents still running or waiting, whichever turn spawned them. The working
   *  anchor stays up for them after the turn settles, so a background agent's
   *  live line keeps one home at the tail instead of vanishing. */
  liveAgentCount?: number | undefined;
  /** The turn settled but provider background work will wake it again. */
  isWaitingOnBackgroundTasks?: boolean | undefined;
  activeStatusLabel?: string | undefined;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const visibleTimelineEntries = hoistTrailingTurnWorkAboveResponse(
    deriveVisibleTimelineEntries(input),
    input.isWorking ? (input.activeTurnId ?? null) : null,
  );
  const durationStartByMessageId = computeMessageDurationStart(
    visibleTimelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(visibleTimelineEntries);
  const modelFallbackByTurn = deriveModelFallbackByTurn(visibleTimelineEntries);
  const supersededRunningCommandEntryIds =
    inferSupersededRunningCommandEntryIds(visibleTimelineEntries);
  /** Turns whose tracker has already been handed to an earlier group. */
  const trackedTurnIds = new Set<TurnId>();
  // Everything after the last user message is the active exchange. Reasoning
  // and lifecycle entries arrive without turn ids, so position is the reliable
  // signal across providers.
  const lastUserMessageIndex = visibleTimelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );

  for (let index = 0; index < visibleTimelineEntries.length; index += 1) {
    const timelineEntry = visibleTimelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries: WorkLogEntry[] = [];
      const agentAnchorEntries: WorkLogEntry[] = [];
      const collect = (entry: Extract<TimelineEntry, { kind: "work" }>) => {
        const settled = settleSupersededRunningCommandEntry(
          entry.entry,
          supersededRunningCommandEntryIds,
        );
        // Private thinking and provider lifecycle narration are status, not
        // history: the working anchor's label names them while they are
        // current, so a row that would vanish moments later never mounts at
        // all. Private thinking becomes a real row only if it settles into a
        // readable summary (the log drops the redacted flag) or fails.
        if (settled.redactedThinking && settled.executionState !== "failed") {
          return;
        }
        if (settled.providerLifecyclePhase) {
          return;
        }
        (isAgentLifecycleEntry(entry) ? agentAnchorEntries : groupedEntries).push(settled);
      };
      collect(timelineEntry);
      let cursor = index + 1;
      while (cursor < visibleTimelineEntries.length) {
        const nextEntry = visibleTimelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        collect(nextEntry);
        cursor += 1;
      }
      // First group of a turn wins its tracker: that is where the turn's story
      // starts, and while the turn runs it is where the live status line belongs.
      const trackerTurnIds: TurnId[] = [];
      for (const entry of [...groupedEntries, ...agentAnchorEntries]) {
        const turnId = entry.turnId;
        if (turnId === null || turnId === undefined || trackedTurnIds.has(turnId)) {
          continue;
        }
        trackedTurnIds.add(turnId);
        trackerTurnIds.push(turnId);
      }
      const trackerAgentSpawnIds =
        trackerTurnIds.length === 0
          ? deriveTrackerAgentSpawnIds(groupedEntries, agentAnchorEntries)
          : [];
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
        agentAnchorEntries,
        trackerTurnIds,
        trackerAgentSpawnIds,
        isLive: false,
        liveStartedAt: null,
        inActiveExchange: input.isWorking && index > lastUserMessageIndex,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "subagent-result") {
      nextRows.push({
        kind: "subagent-result",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        result: timelineEntry.result,
      });
      continue;
    }

    // A running agent's streamed commentary never reaches the conversation:
    // the turn's activity row summarizes what is running, and the rail carries
    // the detail. Filtered with the agent-attributed entries above; this arm
    // only narrows the type for the message handling below.
    if (timelineEntry.kind === "subagent-live") {
      continue;
    }

    if (timelineEntry.kind === "fork-context") {
      nextRows.push({
        kind: "fork-context",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        forkContext: timelineEntry.forkContext,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      timelineEntry.message.turnId === input.activeTurnId;
    const assistantTurnInProgress =
      timelineEntry.message.role === "assistant" &&
      (timelineEntry.message.streaming || assistantTurnStillInProgress);

    const showCompletionDivider =
      timelineEntry.message.role === "assistant" &&
      input.completionDividerBeforeEntryId === timelineEntry.id;
    const assistantTurnDiffSummary =
      timelineEntry.message.role === "assistant"
        ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
        : undefined;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider,
      completionSummary: showCompletionDivider ? (input.completionSummary ?? null) : null,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantCopyStreaming: assistantTurnInProgress,
      assistantTurnInProgress,
      assistantModelFallback:
        timelineEntry.message.role === "assistant"
          ? modelFallbackByTurn.get(turnSignalKey(timelineEntry.message.turnId))
          : undefined,
      assistantTurnDiffSummary:
        assistantTurnDiffSummary?.turnId === timelineEntry.message.turnId
          ? assistantTurnDiffSummary
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  const liveAgentCount = input.liveAgentCount ?? 0;
  if (input.isWorking) {
    // The working row is the turn's one fixed anchor: it renders for the whole
    // turn, whatever the tail is, so the live node, the timer, and the agent
    // tracker never teleport between homes. The tail work group still gets
    // marked live so the spine above it keeps its accent styling.
    markLatestLiveWorkRow(nextRows, input.activeTurnId ?? null, input.activeTurnStartedAt);
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      label: resolveWorkingAnchorLabel(visibleTimelineEntries, input.activeStatusLabel),
    });
  } else if (liveAgentCount > 0) {
    // The turn settled but agents it delegated to are still going: the anchor
    // stays as their tracker, without a turn timer, until the last one lands.
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: null,
      label: liveAgentCount === 1 ? "Agent working" : "Agents working",
    });
  } else if (input.isWaitingOnBackgroundTasks) {
    // The turn settled but a background task (a command, a cron) will wake
    // it: the anchor stays up as a plain wait, without a turn timer.
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: null,
      label: "Waiting",
    });
  }

  return nextRows;
}

/** Labels the lifecycle status may replace on the working anchor. Anything
 *  else — "Waiting for approval", "Reverting checkpoint", "Thinking" — names a
 *  more specific state and keeps priority. */
const GENERIC_ANCHOR_LABELS: ReadonlySet<string> = new Set([
  "Working",
  "Preparing turn",
  "Sending",
]);

const LIFECYCLE_ANCHOR_LABELS = {
  preparing: "Preparing turn",
  "waiting-for-model": "Waiting for model",
  // Dynamic: the entry carries the provider's own wording; this is the fallback.
  "provider-status": "Waiting for model",
} as const satisfies Record<NonNullable<WorkLogEntry["providerLifecyclePhase"]>, string>;

/**
 * Provider lifecycle entries render no rows of their own; the working anchor
 * is the one place connection state is narrated. The visibility pass has
 * already dropped stale lifecycle entries (anything superseded by later
 * concrete activity or a newer phase), so any one still present names the
 * connection's actual current state.
 */
function resolveWorkingAnchorLabel(
  visibleTimelineEntries: ReadonlyArray<TimelineEntry>,
  activeStatusLabel: string | undefined,
): string {
  const fallback = activeStatusLabel ?? "Working";
  if (!GENERIC_ANCHOR_LABELS.has(fallback)) {
    return fallback;
  }
  for (let index = visibleTimelineEntries.length - 1; index >= 0; index -= 1) {
    const timelineEntry = visibleTimelineEntries[index];
    if (timelineEntry?.kind !== "work") {
      continue;
    }
    const phase = timelineEntry.entry.providerLifecyclePhase;
    if (phase) {
      return timelineEntry.entry.providerLifecycleLabel ?? LIFECYCLE_ANCHOR_LABELS[phase];
    }
  }
  return fallback;
}

/**
 * A spawned agent's own tool calls are not the conversation's activity, so they
 * never reach the chat: not as expanded rows, and not in the receipt's counts.
 * The turn's tracker row says how many agents ran and the rail's Agents tab owns
 * what each of them did. The entries themselves are untouched — every other
 * reader of the work log still sees them.
 */
function isSubagentAttributedEntry(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.sourceAgentThreadId !== undefined;
}

/**
 * Agent lifecycle plumbing: the spawn/poll/close tool calls the main model makes
 * to run an agent, and the provider's own task stream for one. None of it is
 * work the conversation should narrate — the turn's tracker row says how many
 * agents ran, each finished agent files exactly one receipt, and the Agents tab
 * owns the detail. So the entries never render and never count, but they are not
 * discarded either: they stay on the row as its anchor, because a turn that only
 * delegated still has to carry that tracker.
 *
 * Both signals are payload-level, not label text: `collab_agent_tool_call` is
 * the item type every provider's agent tool call projects under (Codex's
 * `spawnAgent`/`wait`/`sendInput`/`closeAgent`, Claude's `Agent`/`Task`), and a
 * task activity is only an agent's when it carries that agent's identity —
 * Claude's background bash tasks share the activity kinds and stay.
 */
function isAgentLifecycleEntry(entry: TimelineEntry): boolean {
  if (entry.kind !== "work") {
    return false;
  }
  const { itemType, activityKind, subagentTask } = entry.entry;
  if (itemType === "collab_agent_tool_call") {
    return true;
  }
  return (
    (activityKind === "task.progress" || activityKind === "task.completed") &&
    subagentTask !== undefined
  );
}

/** The spawn call ids a turnless group's rows reference: an agent's own task
 *  rows name their spawn through `subagentTask.toolUseId`, and the spawn's
 *  collab tool item names itself through `toolCallId`. */
function deriveTrackerAgentSpawnIds(
  groupedEntries: ReadonlyArray<WorkLogEntry>,
  agentAnchorEntries: ReadonlyArray<WorkLogEntry>,
): string[] {
  const spawnIds: string[] = [];
  for (const entry of [...groupedEntries, ...agentAnchorEntries]) {
    const spawnId =
      entry.subagentTask?.toolUseId ??
      (entry.itemType === "collab_agent_tool_call" ? entry.toolCallId : undefined);
    if (spawnId && !spawnIds.includes(spawnId)) {
      spawnIds.push(spawnId);
    }
  }
  return spawnIds;
}

/**
 * A turn's response reads as its final word, but turn-end bookkeeping — the
 * checkpoint's changed-files activity, a tool event that settles late — is
 * recorded after the assistant message and would otherwise render below it.
 * For every settled turn, work entries trailing the turn's last assistant
 * message move to just above that message. The turn named by `activeTurnId`
 * keeps raw order: while it is still working, activity that starts after a
 * streamed commentary segment really is the newest thing and belongs below it.
 */
function hoistTrailingTurnWorkAboveResponse(
  entries: TimelineEntry[],
  activeTurnId: TurnId | null,
): TimelineEntry[] {
  const lastAssistantIndexByTurn = new Map<TurnId, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const turnId = entry.message.turnId;
    if (turnId != null && turnId !== activeTurnId) {
      lastAssistantIndexByTurn.set(turnId, index);
    }
  }
  if (lastAssistantIndexByTurn.size === 0) {
    return entries;
  }

  const hoistedByAnchorIndex = new Map<number, TimelineEntry[]>();
  const hoistedIndices = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind !== "work" || entry.entry.turnId == null) {
      continue;
    }
    const anchorIndex = lastAssistantIndexByTurn.get(entry.entry.turnId);
    if (anchorIndex === undefined || index <= anchorIndex) {
      continue;
    }
    const hoisted = hoistedByAnchorIndex.get(anchorIndex) ?? [];
    hoisted.push(entry);
    hoistedByAnchorIndex.set(anchorIndex, hoisted);
    hoistedIndices.add(index);
  }
  if (hoistedIndices.size === 0) {
    return entries;
  }

  const result: TimelineEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (hoistedIndices.has(index)) {
      continue;
    }
    const hoisted = hoistedByAnchorIndex.get(index);
    if (hoisted) {
      result.push(...hoisted);
    }
    result.push(entries[index]!);
  }
  return result;
}

function deriveVisibleTimelineEntries(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly isWorking: boolean;
  readonly activeTurnId?: TurnId | null;
}): TimelineEntry[] {
  // Agent lifecycle entries stay in this pass: they still count as concrete turn
  // activity for the provider-lifecycle row's own visibility, and the grouping
  // step below is what parks them out of sight. Live agent commentary leaves
  // here entirely: it renders nothing, and its timestamp moves with every
  // streamed update — left in, it would split and re-merge the turn's work
  // groups as the agent streams, flickering the activity receipt in and out.
  const timelineEntries = input.timelineEntries.filter(
    (entry) => !isSubagentAttributedEntry(entry) && entry.kind !== "subagent-live",
  );
  const visibleByIndex = Array.from({ length: timelineEntries.length }, () => true);
  let hasLaterProviderLifecycle = false;
  let hasLaterConcreteTurnActivity = false;
  const laterConcreteTurnIds = new Set<TurnId>();

  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work" && timelineEntry.entry.providerLifecyclePhase) {
      visibleByIndex[index] = shouldShowProviderLifecycleWorkEntry(timelineEntry.entry, input, {
        hasLaterProviderLifecycle,
        hasLaterConcreteTurnActivity,
        laterConcreteTurnIds,
      });
    }

    if (timelineEntry.kind === "work" && timelineEntry.entry.providerLifecyclePhase) {
      hasLaterProviderLifecycle = true;
    }

    const concreteTurnId = concreteTimelineEntryTurnId(timelineEntry);
    if (concreteTurnId !== undefined) {
      hasLaterConcreteTurnActivity = true;
      if (concreteTurnId !== null) {
        laterConcreteTurnIds.add(concreteTurnId);
      }
    }
  }

  return timelineEntries.filter((_, index) => visibleByIndex[index]);
}

function shouldShowProviderLifecycleWorkEntry(
  entry: WorkLogEntry,
  input: {
    readonly isWorking: boolean;
    readonly activeTurnId?: TurnId | null;
  },
  later: {
    readonly hasLaterProviderLifecycle: boolean;
    readonly hasLaterConcreteTurnActivity: boolean;
    readonly laterConcreteTurnIds: ReadonlySet<TurnId>;
  },
): boolean {
  if (!input.isWorking) {
    return false;
  }

  const activeTurnId = input.activeTurnId ?? null;
  if (entry.providerLifecyclePhase === "preparing") {
    return (
      !later.hasLaterProviderLifecycle && !hasLaterConcreteTurnActivityForTurn(later, activeTurnId)
    );
  }

  if (activeTurnId !== null && entry.turnId !== activeTurnId) {
    return false;
  }
  return !hasLaterConcreteTurnActivityForTurn(later, activeTurnId ?? entry.turnId ?? null);
}

function hasLaterConcreteTurnActivityForTurn(
  later: {
    readonly hasLaterConcreteTurnActivity: boolean;
    readonly laterConcreteTurnIds: ReadonlySet<TurnId>;
  },
  turnId: TurnId | null,
): boolean {
  if (turnId === null) {
    return later.hasLaterConcreteTurnActivity;
  }
  return later.laterConcreteTurnIds.has(turnId);
}

function concreteTimelineEntryTurnId(entry: TimelineEntry): TurnId | null | undefined {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : undefined;
  }
  if (entry.kind === "work" && !entry.entry.providerLifecyclePhase) {
    return entry.entry.turnId ?? null;
  }
  if (entry.kind === "subagent-result") {
    return entry.result.turnId ?? null;
  }
  return undefined;
}

function markLatestLiveWorkRow(
  rows: MessagesTimelineRow[],
  activeTurnId: TurnId | null,
  activeTurnStartedAt: string | null,
): boolean {
  // The live work group must be the tail of the timeline. Once the assistant
  // emits a message (or any other row) after the work, that work is no longer
  // the current activity — it freezes in place while the working row at the
  // very bottom keeps carrying the turn's live node.
  const lastIndex = rows.length - 1;
  const lastRow = rows[lastIndex];
  if (!lastRow || lastRow.kind !== "work") {
    return false;
  }
  // An anchor-only group has no step to hang the live node on — it renders as the
  // turn's agent tracker, not as a spine — so the standalone working row still
  // has to carry the live node at the bottom.
  if (lastRow.groupedEntries.length === 0) {
    return false;
  }
  // Reasoning and other lifecycle entries arrive without a turn id, so a tail
  // work group that carries no turn association is still treated as the live
  // one rather than handed off to a detached working row.
  const isActiveTurnWork =
    workRowMatchesActiveTurn(lastRow, activeTurnId) ||
    (activeTurnId !== null && lastRow.groupedEntries.every((entry) => entry.turnId === undefined));
  if (!isActiveTurnWork) {
    return false;
  }
  rows[lastIndex] = { ...lastRow, isLive: true, liveStartedAt: activeTurnStartedAt };
  return true;
}

function workRowMatchesActiveTurn(
  row: Extract<MessagesTimelineRow, { kind: "work" }>,
  activeTurnId: TurnId | null,
): boolean {
  if (activeTurnId === null) {
    return true;
  }
  return row.groupedEntries.some((entry) => entry.turnId === activeTurnId);
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt && a.label === (b as typeof a).label;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "subagent-result":
      return a.result === (b as typeof a).result;

    case "fork-context":
      return a.forkContext === (b as typeof a).forkContext;

    case "work": {
      const bw = b as typeof a;
      return (
        a.isLive === bw.isLive &&
        a.liveStartedAt === bw.liveStartedAt &&
        a.inActiveExchange === bw.inActiveExchange &&
        a.trackerTurnIds.length === bw.trackerTurnIds.length &&
        a.trackerTurnIds.every((turnId, index) => turnId === bw.trackerTurnIds[index]) &&
        a.trackerAgentSpawnIds.length === bw.trackerAgentSpawnIds.length &&
        a.trackerAgentSpawnIds.every(
          (spawnId, index) => spawnId === bw.trackerAgentSpawnIds[index],
        ) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries) &&
        Equal.equals(a.agentAnchorEntries, bw.agentAnchorEntries)
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.completionSummary === bm.completionSummary &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnInProgress === bm.assistantTurnInProgress &&
        a.assistantModelFallback === bm.assistantModelFallback &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
