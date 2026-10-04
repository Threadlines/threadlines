/**
 * `room_history`: earlier room messages, labelled so an agent can tell who
 * said what to whom, and on whose behalf.
 *
 * Every message carries its author, its addressee and its origin (the user,
 * or an agent asking on the user's behalf, or another thread's agent), so an
 * agent's request is never read as the user speaking (see messageAuthor).
 * Side exchanges are included and marked. Order is the event sequence; the
 * cursor is the sequence of the oldest message on the page. Output is
 * bounded per message and per page; attachments are listed, never inlined.
 */
import type { OrchestrationMessage, ThreadId } from "@threadlines/contracts";

import { messageAuthor } from "@threadlines/shared/messageAuthor";
import { type RoomAgentEntry, roomAgentName } from "./roomAgents.ts";

export const ROOM_HISTORY_MAX_LIMIT = 20;
export const ROOM_HISTORY_DEFAULT_LIMIT = 10;
const MESSAGE_CHAR_LIMIT = 2_000;
const PAGE_CHAR_LIMIT = 24_000;

export interface RoomHistoryAttachment {
  readonly type: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface RoomHistoryEntry {
  readonly messageId: string;
  readonly sequence: number;
  readonly at: string;
  readonly author: string;
  readonly to?: string;
  /** `user`: the user wrote it. `agent`: an agent did, itself or on request. */
  readonly origin: "user" | "agent";
  /** A room request or reply: ask, review, hand_off or reply. */
  readonly requestKind?: string;
  /** Asked and answered on the side, read-only, outside the working turn. */
  readonly onTheSide?: boolean;
  readonly text: string;
  readonly clipped?: boolean;
  readonly streaming?: boolean;
  readonly attachments?: ReadonlyArray<RoomHistoryAttachment>;
}

export interface RoomHistoryPage {
  readonly messages: ReadonlyArray<RoomHistoryEntry>;
  /** Pass as `before` for older messages. Null: nothing older matches. */
  readonly before: number | null;
}

const sequenceOf = (message: OrchestrationMessage) => message.eventSequence ?? 0;

const compareMessages = (left: OrchestrationMessage, right: OrchestrationMessage) =>
  sequenceOf(left) - sequenceOf(right) ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.id.localeCompare(right.id);

const clip = (text: string, limit: number) =>
  text.length > limit ? { text: `${text.slice(0, limit)}…`, clipped: true } : { text };

/** One message, labelled. */
function labelMessage(
  message: OrchestrationMessage,
  entries: ReadonlyArray<RoomAgentEntry>,
  questionsBySideTurn: ReadonlyMap<string, OrchestrationMessage>,
  threadTitles: ReadonlyMap<ThreadId, string>,
): Omit<RoomHistoryEntry, "text" | "clipped"> {
  const onTheSide = message.sideTurnId !== undefined;
  const base = {
    messageId: message.id,
    sequence: sequenceOf(message),
    at: message.createdAt,
    ...(message.requestKind !== undefined ? { requestKind: message.requestKind } : {}),
    ...(onTheSide ? { onTheSide: true } : {}),
    ...(message.streaming ? { streaming: true } : {}),
    ...(message.attachments !== undefined && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment) => ({
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
        }
      : {}),
  };
  if (message.role === "user") {
    const { author, origin } = messageAuthor(message, {
      agentName: (participantId) => roomAgentName(entries, participantId),
      threadTitle: (threadId) => threadTitles.get(threadId),
    });
    return {
      ...base,
      author,
      to: roomAgentName(entries, message.participantId),
      origin: origin === "user" ? "user" : "agent",
    };
  }
  // A side answer answers whoever asked it; a working turn answers the room.
  const question =
    message.sideTurnId !== undefined ? questionsBySideTurn.get(message.sideTurnId) : undefined;
  const asker =
    question === undefined
      ? undefined
      : question.fromAgent !== undefined
        ? roomAgentName(entries, question.fromAgent.participantId)
        : "User";
  return {
    ...base,
    author: roomAgentName(entries, message.participantId),
    ...(asker !== undefined ? { to: asker } : {}),
    origin: "agent",
  };
}

export function roomHistoryPage(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly entries: ReadonlyArray<RoomAgentEntry>;
  /** Titles of the threads its cross-thread messages came from, when known. */
  readonly threadTitles?: ReadonlyMap<ThreadId, string> | undefined;
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
  readonly query?: string | undefined;
}): RoomHistoryPage {
  const limit = Math.max(
    1,
    Math.min(ROOM_HISTORY_MAX_LIMIT, Math.floor(input.limit ?? ROOM_HISTORY_DEFAULT_LIMIT)),
  );
  const sorted = input.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        (message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
    )
    .toSorted(compareMessages);
  const questionsBySideTurn = new Map<string, OrchestrationMessage>();
  for (const message of sorted) {
    if (message.role === "user" && message.sideTurnId !== undefined) {
      questionsBySideTurn.set(message.sideTurnId, message);
    }
  }
  const threadTitles = input.threadTitles ?? new Map<ThreadId, string>();
  const query = input.query?.trim().toLowerCase() ?? "";
  const labelled = sorted
    .filter((message) => input.before === undefined || sequenceOf(message) < input.before)
    .map((message) => ({
      message,
      label: labelMessage(message, input.entries, questionsBySideTurn, threadTitles),
    }))
    .filter(
      ({ message, label }) =>
        query.length === 0 ||
        message.text.toLowerCase().includes(query) ||
        label.author.toLowerCase().includes(query),
    );

  // Newest first until the page is full or its text budget is spent; the
  // newest message always fits, clipped if it must.
  const page: RoomHistoryEntry[] = [];
  let used = 0;
  for (let index = labelled.length - 1; index >= 0 && page.length < limit; index -= 1) {
    const { message, label } = labelled[index]!;
    const clipped = clip(message.text.trim(), MESSAGE_CHAR_LIMIT);
    if (page.length > 0 && used + clipped.text.length > PAGE_CHAR_LIMIT) {
      break;
    }
    used += clipped.text.length;
    page.unshift({ ...label, ...clipped });
  }
  const olderRemain = labelled.length > page.length;
  return {
    messages: page,
    before: olderRemain && page.length > 0 ? page[0]!.sequence : null,
  };
}
