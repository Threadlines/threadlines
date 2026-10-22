/**
 * What the chat's rows read from the rows as a whole, through the timeline's
 * shared row context: which messages carry an author line, what a side
 * answer's steps are named by, the room requests messages answer, each turn's
 * `thread_start` calls, and which sign-in errors a later reply resolved.
 *
 * The rows change on every live update (a step starting, a reply streaming
 * in), and a new context value redraws every row on screen. So each part
 * keeps its identity from last time while what it holds is the same, and a
 * live update redraws only the rows it changed.
 */
import type { MessageId, RoomAgentRequestId, SideTurnId } from "@threadlines/contracts";
import { shallow } from "zustand/vanilla/shallow";

import { parseThreadStartResult, type ThreadStartCall } from "../../childThreads";
import { isProviderAuthErrorChatMessage } from "../../lib/providerAuthMessages";
import type { ChatMessage } from "../../types";
import { threadlinesRoomToolOf } from "./activitySteps";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

/** What a side answer's name says when its steps carry it: the review it
 *  answers, or the question it links back to. */
export interface SideAnswerContext {
  readonly review?: ChatMessage;
  readonly replyTo?: ChatMessage;
}

export interface TimelineRowsShared {
  /** The working anchor is mounted at the tail: live agents' status rows
   *  render there and only there. */
  readonly anchorOwnsLiveAgents: boolean;
  /** Agent messages that head their agent's stretch or side answer. */
  readonly authorLineMessageIds: ReadonlySet<MessageId>;
  readonly sideAnswerContext: ReadonlyMap<SideTurnId, SideAnswerContext>;
  /** The messages that made room requests (asks, reviews, invites). */
  readonly sideAnswerRequests: ReadonlyMap<RoomAgentRequestId, ChatMessage>;
  /** Every finished `thread_start` call, by turn: a call's record reads its turn's. */
  readonly threadStartCallsByTurn: ReadonlyMap<string, ReadonlyArray<ThreadStartCall>>;
  /** Sign-in errors and reconnect steps a later successful reply resolved. */
  readonly resolvedProviderAuthReconnectIds: ReadonlySet<string>;
}

export const NO_TIMELINE_ROWS_SHARED: TimelineRowsShared = {
  anchorOwnsLiveAgents: false,
  authorLineMessageIds: new Set(),
  sideAnswerContext: new Map(),
  sideAnswerRequests: new Map(),
  threadStartCallsByTurn: new Map(),
  resolvedProviderAuthReconnectIds: new Set(),
};

/**
 * What `rows` share with every row, reusing each part of `previous` that
 * holds the same things, and `previous` itself when every part does.
 */
export function deriveTimelineRowsShared(
  rows: ReadonlyArray<MessagesTimelineRow>,
  previous: TimelineRowsShared,
): TimelineRowsShared {
  const next: TimelineRowsShared = {
    anchorOwnsLiveAgents: rows.some((row) => row.kind === "working"),
    authorLineMessageIds: keep(
      previous.authorLineMessageIds,
      collectAuthorLineMessageIds(rows),
      shallow,
    ),
    sideAnswerContext: keep(previous.sideAnswerContext, collectSideAnswerContext(rows), (a, b) =>
      sameMap(a, b, shallow),
    ),
    sideAnswerRequests: keep(previous.sideAnswerRequests, collectSideAnswerRequests(rows), shallow),
    threadStartCallsByTurn: keep(
      previous.threadStartCallsByTurn,
      collectThreadStartCalls(rows),
      (a, b) => sameMap(a, b, sameThreadStartCalls),
    ),
    resolvedProviderAuthReconnectIds: keep(
      previous.resolvedProviderAuthReconnectIds,
      collectResolvedProviderAuthReconnectIds(rows),
      shallow,
    ),
  };
  return (Object.keys(next) as Array<keyof TimelineRowsShared>).every(
    (key) => next[key] === previous[key],
  )
    ? previous
    : next;
}

/** A finished `thread_start` call: the steps leave it to its own record. */
export function isSettledThreadStartEntry(entry: TimelineWorkEntry): boolean {
  return entry.executionState !== "running" && threadlinesRoomToolOf(entry) === "thread_start";
}

/** The turn a `thread_start` call is grouped by; a call no turn names stands alone. */
export function threadStartTurnKey(entry: Pick<TimelineWorkEntry, "id" | "turnId">): string {
  return entry.turnId ? `turn:${entry.turnId}` : `entry:${entry.id}`;
}

/** The agent messages that head their agent's stretch or side answer
 *  (AgentLine.heads). A hand-off or a reply names its writer in its own
 *  header. */
function collectAuthorLineMessageIds(rows: ReadonlyArray<MessagesTimelineRow>): Set<MessageId> {
  const ids = new Set<MessageId>();
  for (const row of rows) {
    if (
      row.kind === "message" &&
      row.message.role === "assistant" &&
      (row.agentLine !== undefined ? row.agentLine.heads : row.message.sideTurnId !== undefined)
    ) {
      ids.add(row.message.id);
    }
  }
  return ids;
}

function collectSideAnswerContext(
  rows: ReadonlyArray<MessagesTimelineRow>,
): Map<SideTurnId, SideAnswerContext> {
  const context = new Map<SideTurnId, SideAnswerContext>();
  for (const row of rows) {
    if (row.kind === "message" && row.message.sideTurnId !== undefined) {
      if (row.sideReview !== undefined || row.sideReplyTo !== undefined) {
        context.set(row.message.sideTurnId, {
          ...(row.sideReview !== undefined ? { review: row.sideReview } : {}),
          ...(row.sideReplyTo !== undefined ? { replyTo: row.sideReplyTo } : {}),
        });
      }
    }
  }
  return context;
}

function collectSideAnswerRequests(
  rows: ReadonlyArray<MessagesTimelineRow>,
): Map<RoomAgentRequestId, ChatMessage> {
  const requests = new Map<RoomAgentRequestId, ChatMessage>();
  for (const row of rows) {
    if (
      row.kind === "message" &&
      (row.message.requestKind === "invite" ||
        row.message.requestKind === "ask" ||
        row.message.requestKind === "review") &&
      row.message.requestId !== undefined
    ) {
      requests.set(row.message.requestId, row.message);
    }
  }
  return requests;
}

function collectThreadStartCalls(
  rows: ReadonlyArray<MessagesTimelineRow>,
): Map<string, ThreadStartCall[]> {
  const byTurn = new Map<string, ThreadStartCall[]>();
  for (const row of rows) {
    if (row.kind !== "work") continue;
    for (const entry of row.groupedEntries) {
      if (!isSettledThreadStartEntry(entry)) continue;
      const key = threadStartTurnKey(entry);
      const calls = byTurn.get(key) ?? [];
      calls.push({
        id: entry.id,
        turnId: entry.turnId ?? null,
        result: parseThreadStartResult(entry.toolResult ?? entry.outputPreview),
      });
      byTurn.set(key, calls);
    }
  }
  return byTurn;
}

function isResolvedProviderAuthRecoverySignal(row: MessagesTimelineRow): boolean {
  if (row.kind !== "message" || row.message.role !== "assistant" || row.message.streaming) {
    return false;
  }
  return row.message.text.trim().length > 0 && !isProviderAuthErrorChatMessage(row.message);
}

function collectResolvedProviderAuthReconnectIds(
  rows: ReadonlyArray<MessagesTimelineRow>,
): Set<string> {
  const resolvedIds = new Set<string>();
  let hasLaterAssistantSuccess = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (isResolvedProviderAuthRecoverySignal(row)) {
      hasLaterAssistantSuccess = true;
      continue;
    }
    if (!hasLaterAssistantSuccess) {
      continue;
    }
    if (row.kind === "message" && row.message.role === "assistant") {
      if (isProviderAuthErrorChatMessage(row.message)) {
        resolvedIds.add(row.id);
      }
      continue;
    }
    if (row.kind === "work") {
      for (const entry of row.groupedEntries) {
        if (entry.authReconnect) {
          resolvedIds.add(entry.id);
        }
      }
    }
  }
  return resolvedIds;
}

const keep = <T>(previous: T, next: T, same: (a: T, b: T) => boolean): T =>
  same(previous, next) ? previous : next;

function sameMap<K, V>(
  a: ReadonlyMap<K, V>,
  b: ReadonlyMap<K, V>,
  sameValue: (x: V, y: V) => boolean,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !sameValue(value, b.get(key)!)) return false;
  }
  return true;
}

function sameThreadStartCalls(
  a: ReadonlyArray<ThreadStartCall>,
  b: ReadonlyArray<ThreadStartCall>,
): boolean {
  return (
    a.length === b.length &&
    a.every((call, index) => {
      const other = b[index]!;
      return (
        call.id === other.id &&
        call.turnId === other.turnId &&
        call.result.outcome === other.result.outcome &&
        shallow(call.result.threadIds, other.result.threadIds) &&
        shallow(call.result.remoteThreadIds, other.result.remoteThreadIds)
      );
    })
  );
}
