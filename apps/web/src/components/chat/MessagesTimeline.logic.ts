import * as Equal from "effect/Equal";
import {
  type ModelFallbackState,
  type ForkContextEntry,
  type SubagentLiveEntry,
  type SubagentResultEntry,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@threadlines/contracts";

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
      isLive: boolean;
      liveStartedAt: string | null;
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
      kind: "subagent-live";
      id: string;
      createdAt: string;
      live: SubagentLiveEntry;
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
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
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
  activeStatusLabel?: string | undefined;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const visibleTimelineEntries = deriveVisibleTimelineEntries(input);
  const durationStartByMessageId = computeMessageDurationStart(
    visibleTimelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(visibleTimelineEntries);
  const modelFallbackByTurn = deriveModelFallbackByTurn(visibleTimelineEntries);
  const supersededRunningCommandEntryIds =
    inferSupersededRunningCommandEntryIds(visibleTimelineEntries);

  for (let index = 0; index < visibleTimelineEntries.length; index += 1) {
    const timelineEntry = visibleTimelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [
        settleSupersededRunningCommandEntry(timelineEntry.entry, supersededRunningCommandEntryIds),
      ];
      let cursor = index + 1;
      while (cursor < visibleTimelineEntries.length) {
        const nextEntry = visibleTimelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(
          settleSupersededRunningCommandEntry(nextEntry.entry, supersededRunningCommandEntryIds),
        );
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
        isLive: false,
        liveStartedAt: null,
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

    if (timelineEntry.kind === "subagent-live") {
      nextRows.push({
        kind: "subagent-live",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        live: timelineEntry.live,
      });
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

  if (input.isWorking) {
    // The live work group renders its own terminal live node (the spine's
    // halo), so only fall back to a standalone working row when there is no
    // live work group to absorb it (e.g. a turn that has not emitted any tool
    // activity yet).
    const absorbedByLiveWorkRow = markLatestLiveWorkRow(
      nextRows,
      input.activeTurnId ?? null,
      input.activeTurnStartedAt,
    );
    if (!absorbedByLiveWorkRow) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: input.activeTurnStartedAt,
        label: input.activeStatusLabel ?? "Working",
      });
    }
  }

  return nextRows;
}

function deriveVisibleTimelineEntries(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly isWorking: boolean;
  readonly activeTurnId?: TurnId | null;
}): TimelineEntry[] {
  const visibleByIndex = Array.from({ length: input.timelineEntries.length }, () => true);
  let hasLaterProviderLifecycle = false;
  let hasLaterConcreteTurnActivity = false;
  const laterConcreteTurnIds = new Set<TurnId>();

  for (let index = input.timelineEntries.length - 1; index >= 0; index -= 1) {
    const timelineEntry = input.timelineEntries[index];
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

  return input.timelineEntries.filter((_, index) => visibleByIndex[index]);
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
  // the current activity — the standalone working row then anchors the live
  // node at the very bottom instead of stranding a halo on a finished step.
  const lastIndex = rows.length - 1;
  const lastRow = rows[lastIndex];
  if (!lastRow || lastRow.kind !== "work") {
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

    case "subagent-live":
      return a.live === (b as typeof a).live;

    case "fork-context":
      return a.forkContext === (b as typeof a).forkContext;

    case "work":
      return (
        a.isLive === (b as typeof a).isLive &&
        a.liveStartedAt === (b as typeof a).liveStartedAt &&
        Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries)
      );

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
