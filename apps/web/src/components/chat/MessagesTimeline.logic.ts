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
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import {
  activityStepFromWorkLogEntry,
  commandCheckKey,
  isSilentWorkLogEntry,
  liveActivityLabel,
  liveThoughtText,
} from "./activitySteps";

/** What a finished turn's footer says under its last message. */
export interface TurnSummary {
  /** Time spent working, without the wait before a Retry or a resumed turn. */
  readonly workedMs: number | null;
  readonly editedFileCount: number;
  /** Latest result of each check the turn ran; a rerun replaces a failure. */
  readonly checks: { readonly passed: number; readonly failed: number } | null;
  /** The turn's agents. The working row carried them while the turn ran, and
   *  the footer takes its place, so they stay at the tail. */
  readonly trackerTurnIds: ReadonlyArray<TurnId>;
  readonly trackerAgentSpawnIds: ReadonlyArray<string>;
}

/**
 * Where a row sits in its turn's work tray: the recessed surface behind the
 * agent's notes and steps, so the answer below it lands on the page. A tray
 * spans consecutive rows, rounded at its first and last visible row.
 */
export type TrayPlacement = "single" | "first" | "middle" | "last";

export interface TimelineRowPlacement {
  /** Null for rows on the page: your messages, answers, plans. */
  readonly tray: TrayPlacement | null;
  /** Room above the row, which is how an answer keeps page space above it once
   *  it leaves the tray. Decided by what the row is and what sits above it,
   *  never by the tray, so a turn ending moves nothing. */
  readonly padTop: boolean;
}

const UNPLACED: TimelineRowPlacement = { tray: null, padTop: false };

export type MessagesTimelineRow = TimelineRowPlacement &
  (
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
        /** A note from a finished turn that is not its last message: it fades so
         *  the turn's answer reads first. */
        settledNote: boolean;
        /** Set on a finished turn's last message, which carries the turn's footer. */
        turnSummary: TurnSummary | null;
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
    | {
        kind: "working";
        id: string;
        createdAt: string | null;
        label: string;
        /** What the agent is thinking right now, in its own summary's words. */
        thought: string | null;
      }
  );

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
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
  // Turn-request markers are hidden once a turn settles, so read them from
  // the full entry list rather than the visible one.
  const turnRequestedAts = input.timelineEntries
    .flatMap((entry) =>
      entry.kind === "work" && entry.entry.providerLifecyclePhase === "preparing"
        ? [entry.createdAt]
        : [],
    )
    .toSorted();
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
        ...UNPLACED,
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
        ...UNPLACED,
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "subagent-result") {
      nextRows.push({
        ...UNPLACED,
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
        ...UNPLACED,
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

    const assistantTurnDiffSummary =
      timelineEntry.message.role === "assistant"
        ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
        : undefined;

    nextRows.push({
      ...UNPLACED,
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      settledNote: false,
      turnSummary: null,
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
    markLatestLiveWorkRow(nextRows, input.activeTurnId ?? null, input.activeTurnStartedAt);
  }
  const rows = settleFinishedTurns(nextRows, {
    isWorking: input.isWorking,
    activeTurnId: input.activeTurnId ?? null,
    turnRequestedAts,
  });
  if (input.isWorking) {
    // The working row is the turn's one fixed anchor: it renders for the whole
    // turn, whatever the tail is, so the live node, the timer, and the agent
    // tracker never teleport between homes. Its word is the step running now.
    rows.push({
      ...UNPLACED,
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      label: resolveLiveAnchorLabel(nextRows, visibleTimelineEntries, input.activeStatusLabel),
      thought: resolveLiveThought(visibleTimelineEntries),
    });
  } else if (liveAgentCount > 0) {
    // The turn settled but agents it delegated to are still going: the anchor
    // stays as their tracker, without a turn timer, until the last one lands.
    rows.push({
      ...UNPLACED,
      kind: "working",
      id: "working-indicator-row",
      createdAt: null,
      label: liveAgentCount === 1 ? "Agent working" : "Agents working",
      thought: null,
    });
  } else if (input.isWaitingOnBackgroundTasks) {
    // The turn settled but a background task (a command, a cron) will wake
    // it: the anchor stays up as a plain wait, without a turn timer.
    rows.push({
      ...UNPLACED,
      kind: "working",
      id: "working-indicator-row",
      createdAt: null,
      label: "Waiting",
      thought: null,
    });
  }

  return placeRows(rows, input.isWorking);
}

type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;

/** Rows the agent produced, as opposed to your messages and the page between
 *  turns. */
function isAgentRow(row: MessagesTimelineRow): boolean {
  return (
    row.kind === "work" ||
    row.kind === "subagent-result" ||
    row.kind === "working" ||
    (row.kind === "message" && row.message.role === "assistant")
  );
}

/** The agent's work in progress or on record: everything a turn does before
 *  its answer. A finished turn's answer, your messages, and plans sit on the
 *  page; the working row belongs to the tray only while the turn runs. */
function belongsInTray(row: MessagesTimelineRow, isWorking: boolean): boolean {
  switch (row.kind) {
    case "work":
    case "subagent-result":
      return true;
    case "working":
      return isWorking;
    case "message":
      return row.message.role === "assistant" && row.turnSummary === null;
    default:
      return false;
  }
}

/** A step group with nothing to draw (only running steps, which the working
 *  row names, or agent plumbing whose tracker moved to the footer) takes no
 *  room, so it cannot carry the tray's rounded edge or set the room above the
 *  row after it. */
function drawsNothing(row: MessagesTimelineRow, isWorking: boolean): boolean {
  if (row.kind !== "work") {
    return false;
  }
  const showsTracker =
    (row.trackerTurnIds.length > 0 || row.trackerAgentSpawnIds.length > 0) &&
    !(isWorking && row.inActiveExchange);
  return (
    !showsTracker &&
    row.groupedEntries.every(
      (entry) => entry.executionState === "running" || isSilentWorkLogEntry(entry),
    )
  );
}

/**
 * Places each row: in a work tray or on the page, and with or without room
 * above it. Messages always keep that room, so whichever message turns out to
 * be the answer has page space above it when it leaves the tray. Other rows
 * keep it where the agent's work meets the page: the first step after your
 * message, or your next message after the agent's work. Rows that draw nothing
 * are skipped, so right after you send, the working row keeps its room even
 * with the turn request's empty group above it.
 */
function placeRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
  isWorking: boolean,
): MessagesTimelineRow[] {
  const inTray = rows.map((row) => belongsInTray(row, isWorking));
  const visible = rows.map((row) => !drawsNothing(row, isWorking));
  const tray: Array<TrayPlacement | null> = rows.map(() => null);
  for (let start = 0; start < rows.length; start += 1) {
    if (!inTray[start] || (start > 0 && inTray[start - 1])) {
      continue;
    }
    let end = start;
    while (end + 1 < rows.length && inTray[end + 1]) {
      end += 1;
    }
    const first = visible.indexOf(true, start);
    const last = visible.lastIndexOf(true, end);
    if (first === -1 || first > end || last < start) {
      continue;
    }
    // Rows past the visible ends take no room, so they stay off the edges.
    for (let index = start; index <= end; index += 1) {
      tray[index] =
        first === last && index === first
          ? "single"
          : index === first
            ? "first"
            : index === last
              ? "last"
              : "middle";
    }
  }
  // The nearest row above that draws something.
  let above: MessagesTimelineRow | undefined;
  return rows.map((row, index) => {
    const padTop =
      row.kind === "message" && row.message.role === "assistant"
        ? true
        : isAgentRow(row)
          ? above === undefined ||
            !isAgentRow(above) ||
            (above.kind === "message" && above.turnSummary !== null)
          : above !== undefined && isAgentRow(above);
    if (visible[index]) {
      above = row;
    }
    return row.tray === tray[index] && row.padTop === padTop
      ? row
      : { ...row, tray: tray[index] ?? null, padTop };
  });
}

/**
 * A finished turn keeps its story where it is: nothing folds, so nothing above
 * the answer moves when the turn ends. The turn's last message becomes its
 * answer and carries the turn's footer, which takes the working row's place at
 * the tail, and the notes before it fade. Settling goes turn by turn, so a turn
 * resumed after a background task leaves the earlier turn's footer in place.
 * A turn that ended without a message has no footer, and its first group keeps
 * the agent tracker.
 */
function settleFinishedTurns(
  rows: ReadonlyArray<MessagesTimelineRow>,
  options: {
    readonly isWorking: boolean;
    readonly activeTurnId: TurnId | null;
    readonly turnRequestedAts: ReadonlyArray<string>;
  },
): MessagesTimelineRow[] {
  const result = [...rows];
  const requestTimes = options.turnRequestedAts
    .map((requestedAt) => Date.parse(requestedAt))
    .filter(Number.isFinite);
  const lastUserIndex = result.findLastIndex(
    (row) => row.kind === "message" && row.message.role === "user",
  );
  let spanStart = 0;
  let userMessageAt: string | null = null;
  let previousAnswerEndMs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < result.length; index += 1) {
    const row = result[index]!;
    if (row.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      spanStart = index + 1;
      userMessageAt = row.message.createdAt;
      previousAnswerEndMs = Number.NEGATIVE_INFINITY;
      continue;
    }
    // The same signal that keeps the working row up, so the row and the footer
    // swap in one render. A reply the provider did not tie to a turn stays
    // live until the exchange it belongs to ends.
    const running =
      row.message.streaming ||
      (options.isWorking &&
        index > lastUserIndex &&
        (!row.message.turnId || row.message.turnId === options.activeTurnId));
    if (row.message.role !== "assistant" || !row.showAssistantCopyButton || running) {
      continue;
    }

    const span = result.slice(spanStart, index);
    const work = summarizeTurnWork(span);
    span.forEach((spanRow, offset) => {
      if (spanRow.kind === "message" && spanRow.message.role === "assistant") {
        result[spanStart + offset] = { ...spanRow, settledNote: true };
      } else if (
        spanRow.kind === "work" &&
        (spanRow.trackerTurnIds.length > 0 || spanRow.trackerAgentSpawnIds.length > 0)
      ) {
        result[spanStart + offset] = { ...spanRow, trackerTurnIds: [], trackerAgentSpawnIds: [] };
      }
    });
    const startedAtMs =
      userMessageAt !== null
        ? Date.parse(userMessageAt)
        : resumedTurnStartMs(span, row, requestTimes, previousAnswerEndMs);
    result[index] = {
      ...row,
      turnSummary: {
        workedMs: workedDurationMs(startedAtMs, span, row, requestTimes),
        // The checkpoint diff lands a beat after the turn; until then the
        // turn's own edits are the count.
        editedFileCount: row.assistantTurnDiffSummary?.files.length ?? work.editedFileCount,
        checks: work.checks,
        trackerTurnIds: work.trackerTurnIds,
        trackerAgentSpawnIds: work.trackerAgentSpawnIds,
      },
    };
    spanStart = index + 1;
    userMessageAt = null;
    previousAnswerEndMs = Date.parse(row.message.completedAt ?? row.message.createdAt);
  }
  return result;
}

/**
 * When a turn with no message of its own started (a Retry, a turn resumed
 * after a background task): at its first request or first activity, whichever
 * came first, so the wait before it is not work.
 */
function resumedTurnStartMs(
  span: ReadonlyArray<MessagesTimelineRow>,
  answer: MessageRow,
  requestTimes: ReadonlyArray<number>,
  previousAnswerEndMs: number,
): number {
  let startedAt = Date.parse(answer.message.createdAt);
  const firstRequest = requestTimes[firstIndexAfter(requestTimes, previousAnswerEndMs)];
  if (firstRequest !== undefined && firstRequest < startedAt) {
    startedAt = firstRequest;
  }
  // Rows run in time order, so the turn's first activity opens its first row.
  const firstRowAt = span[0]?.createdAt ? Date.parse(span[0].createdAt) : Number.NaN;
  return firstRowAt < startedAt ? firstRowAt : startedAt;
}

/**
 * How long the agent worked from the turn's start to its answer. A later turn
 * request in between (a Retry, a turn resumed after a background task) starts
 * the clock again: the wait before it, back to the last thing that happened,
 * is not work.
 */
function workedDurationMs(
  startedAt: number,
  rows: ReadonlyArray<MessagesTimelineRow>,
  answer: MessageRow,
  requestTimes: ReadonlyArray<number>,
): number | null {
  const endedAt = Date.parse(answer.message.completedAt ?? answer.message.createdAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return null;
  }
  let idleMs = 0;
  let clockStartedAt = startedAt;
  for (
    let requestIndex = firstIndexAfter(requestTimes, startedAt);
    requestIndex < requestTimes.length && requestTimes[requestIndex]! <= endedAt;
    requestIndex += 1
  ) {
    const requestedAt = requestTimes[requestIndex]!;
    idleMs += requestedAt - lastActivityAtOrBefore(rows, requestedAt, clockStartedAt);
    clockStartedAt = requestedAt;
  }
  return endedAt - startedAt - idleMs;
}

/** The latest thing that happened in `rows` at or before `at`, and no earlier
 *  than `floor`. Rows and their steps run in time order, so the scan stops at
 *  the first one that starts after `at`. A turn request marker is the clock
 *  restarting, not activity. */
function lastActivityAtOrBefore(
  rows: ReadonlyArray<MessagesTimelineRow>,
  at: number,
  floor: number,
): number {
  let latest = floor;
  const consider = (time: string | null | undefined): number => {
    const parsed = time ? Date.parse(time) : Number.NaN;
    if (parsed > latest && parsed <= at) {
      latest = parsed;
    }
    return parsed;
  };
  for (const row of rows) {
    if (row.kind === "work") {
      for (const entry of row.groupedEntries) {
        if (entry.providerLifecyclePhase) {
          continue;
        }
        if (consider(entry.createdAt) > at) {
          return latest;
        }
        consider(entry.completedAt);
      }
      continue;
    }
    if (consider(row.kind === "message" ? row.message.createdAt : row.createdAt) > at) {
      return latest;
    }
    if (row.kind === "message") {
      consider(row.message.completedAt);
    }
  }
  return latest;
}

/** The index of the first time after `after` in ascending `times`. */
function firstIndexAfter(times: ReadonlyArray<number>, after: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle]! > after) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/** What a turn's steps add up to: the files it edited, how its checks ended,
 *  and the agents its groups track. */
function summarizeTurnWork(
  rows: ReadonlyArray<MessagesTimelineRow>,
): Omit<TurnSummary, "workedMs"> {
  const editedFiles = new Set<string>();
  const checkResults = new Map<string, boolean>();
  const trackerTurnIds = new Set<TurnId>();
  const trackerAgentSpawnIds = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "work") {
      continue;
    }
    row.trackerTurnIds.forEach((turnId) => trackerTurnIds.add(turnId));
    row.trackerAgentSpawnIds.forEach((spawnId) => trackerAgentSpawnIds.add(spawnId));
    for (const entry of row.groupedEntries) {
      if (entry.executionState !== "failed") {
        for (const path of entry.changedFiles ?? []) {
          editedFiles.add(path.replaceAll("\\", "/").toLowerCase());
        }
      }
      // A rerun of the same check replaces the earlier result.
      const checkKey =
        entry.command && entry.executionState !== "running" ? commandCheckKey(entry.command) : null;
      if (checkKey) {
        checkResults.set(checkKey, entry.executionState !== "failed");
      }
    }
  }
  const results = [...checkResults.values()];
  return {
    editedFileCount: editedFiles.size,
    checks:
      results.length > 0
        ? {
            passed: results.filter((passed) => passed).length,
            failed: results.filter((passed) => !passed).length,
          }
        : null,
    trackerTurnIds: [...trackerTurnIds],
    trackerAgentSpawnIds: [...trackerAgentSpawnIds],
  };
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
 * What the working row says: a specific state when there is one ("Waiting for
 * approval", "Thinking"), else the step running right now in the active
 * exchange ("Reading service.ts"), else "Working".
 */
function resolveLiveAnchorLabel(
  rows: ReadonlyArray<MessagesTimelineRow>,
  visibleTimelineEntries: ReadonlyArray<TimelineEntry>,
  activeStatusLabel: string | undefined,
): string {
  const label = resolveWorkingAnchorLabel(visibleTimelineEntries, activeStatusLabel);
  if (label !== "Working") {
    return label;
  }
  const lastUserIndex = rows.findLastIndex(
    (row) => row.kind === "message" && row.message.role === "user",
  );
  const runningSteps = rows.slice(lastUserIndex + 1).flatMap((row) =>
    row.kind === "work"
      ? row.groupedEntries.flatMap((entry) => {
          if (entry.executionState !== "running") return [];
          const step = activityStepFromWorkLogEntry(entry);
          return step ? [step] : [];
        })
      : [],
  );
  return liveActivityLabel(runningSteps) ?? label;
}

/** The newest words of the thought running right now, when the newest step in
 *  view is one. A step or reply after it means the thought is over. */
function resolveLiveThought(visibleTimelineEntries: ReadonlyArray<TimelineEntry>): string | null {
  const newest = visibleTimelineEntries.findLast(
    (timelineEntry) => timelineEntry.kind !== "work" || !timelineEntry.entry.providerLifecyclePhase,
  );
  return newest?.kind === "work" ? liveThoughtText(newest.entry) : null;
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
  if (a.kind !== b.kind || a.id !== b.id || a.tray !== b.tray || a.padTop !== b.padTop) {
    return false;
  }

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.label === (b as typeof a).label &&
        a.thought === (b as typeof a).thought
      );

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
        a.settledNote === bm.settledNote &&
        isTurnSummaryUnchanged(a.turnSummary, bm.turnSummary) &&
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

function isTurnSummaryUnchanged(a: TurnSummary | null, b: TurnSummary | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.workedMs === b.workedMs &&
    a.editedFileCount === b.editedFileCount &&
    a.checks?.passed === b.checks?.passed &&
    a.checks?.failed === b.checks?.failed &&
    a.trackerTurnIds.length === b.trackerTurnIds.length &&
    a.trackerTurnIds.every((turnId, index) => turnId === b.trackerTurnIds[index]) &&
    a.trackerAgentSpawnIds.length === b.trackerAgentSpawnIds.length &&
    a.trackerAgentSpawnIds.every((spawnId, index) => spawnId === b.trackerAgentSpawnIds[index])
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

/** A long message of yours shows folded, behind a fade and a way to open it. */
export function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

// How tall a row draws, guessed from its data, for the rows the list has not
// drawn yet. Left alone, the list guesses from the average of the rows it has
// measured: long answers make it guess high for a step or a message that just
// started streaming, which then shrinks as soon as it lands, and a phone
// scrolled to the bottom snaps back by the difference. The average also moves
// with every row measured, shifting every undrawn row above the reader. These
// guesses stay put, and follow how the rows render in MessagesTimeline.tsx
// closely enough; the list measures each row once it draws it.
const TEXT_LINE_PX = 23;
const TEXT_CHAR_PX = 6.5;
const STEP_LINE_PX = 20;

const rowHeightEstimates = new WeakMap<
  MessagesTimelineRow,
  { readonly width: number; readonly height: number }
>();

/** The guessed height of `row` in a timeline `width` pixels wide. */
export function estimateTimelineRowHeight(row: MessagesTimelineRow, width: number): number {
  const cached = rowHeightEstimates.get(row);
  if (cached?.width === width) {
    return cached.height;
  }
  const content = estimateRowContentHeight(row, width);
  // A row that draws nothing drops its padding too.
  const height = content > 0 && row.padTop ? content + 8 : content;
  rowHeightEstimates.set(row, { width, height });
  return height;
}

function estimateRowContentHeight(row: MessagesTimelineRow, width: number): number {
  // The list's side padding, then the rows' 56rem column and its own padding.
  const column = Math.min(width - (width < 640 ? 24 : 40), 896) - 16;
  switch (row.kind) {
    case "message": {
      if (row.message.role === "assistant") {
        const hasChangedFiles =
          !row.assistantTurnInProgress && (row.assistantTurnDiffSummary?.files.length ?? 0) > 0;
        return (
          8 +
          estimateTextLines(row.message.text, column - 8) * TEXT_LINE_PX +
          (row.turnSummary ? 38 : 0) +
          // The turn's changes, a card whose header wraps on a phone.
          (hasChangedFiles ? (column < 430 ? 110 : 88) : 0)
        );
      }
      if (row.message.role === "user") {
        const text = deriveDisplayedUserMessageState(row.message.text).visibleText;
        const images = row.message.attachments?.some((attachment) => attachment.type === "image")
          ? 228
          : 0;
        if (shouldCollapseUserMessage(text)) {
          return 252 + images;
        }
        // The bubble takes 80% of the column, less its padding.
        return 78 + estimateTextLines(text, column * 0.8 - 34) * TEXT_LINE_PX + images;
      }
      return 0;
    }
    case "work": {
      // A running step shows on the working row, not here, and the looking
      // around folds into one line, so a group rarely shows more than three.
      let settledSteps = 0;
      for (const entry of row.groupedEntries) {
        if (entry.executionState !== "running" && !isSilentWorkLogEntry(entry)) {
          settledSteps += 1;
        }
      }
      return settledSteps === 0 ? 0 : 10 + STEP_LINE_PX * Math.min(settledSteps, 3);
    }
    case "working":
      return row.thought ? 46 : 30;
    case "subagent-result":
      return 40;
    case "fork-context":
      return 90;
    case "proposed-plan":
      return 240;
  }
}

/** Rendered lines of `text` in a box `widthPx` wide, a blank line counting
 *  half. A line breaks at a word, losing about half of one. */
function estimateTextLines(text: string, widthPx: number): number {
  if (text.length === 0) {
    return 0;
  }
  const charsPerLine = Math.max(1, widthPx / TEXT_CHAR_PX - 3);
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += line.trim().length === 0 ? 0.5 : Math.ceil(line.length / charsPerLine);
  }
  return lines;
}
