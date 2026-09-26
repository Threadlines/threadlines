/**
 * Side answers in the chat: a room agent answering the user read-only while
 * another agent works (docs/design/rooms-slice-2.md).
 *
 * The working turn's rows are derived without them: a side question is never
 * "the last user message", and a side answer's steps never join the working
 * turn's trays. Each side answer becomes a small block of its own, placed
 * where it was asked, but never inside a tray, so a working turn's tray stays
 * whole while another agent answers under it.
 */
import type {
  OrchestrationSideTurn,
  OrchestrationThreadActivity,
  SideTurnId,
  ThreadParticipantId,
} from "@threadlines/contracts";

import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Recorded when a side answer ends without a finished reply. */
export const SIDE_ANSWER_OUTCOME_KIND = "side-answer.outcome";

export interface SideAnswerView {
  readonly sideTurnId: SideTurnId;
  readonly participantId: ThreadParticipantId | null;
  readonly question: ChatMessage;
  readonly answer: ChatMessage | null;
  readonly steps: ReadonlyArray<WorkLogEntry>;
  readonly state: "answering" | "stopping" | "answered" | "failed" | "stopped";
  readonly error: string | null;
}

export const isSideMessage = (message: Pick<ChatMessage, "sideTurnId">) =>
  message.sideTurnId !== undefined;

export const isSideActivity = (activity: Pick<OrchestrationThreadActivity, "sideTurnId">) =>
  activity.sideTurnId !== undefined;

const readOutcome = (activity: OrchestrationThreadActivity) => {
  const payload = (activity.payload ?? {}) as {
    readonly outcome?: unknown;
    readonly error?: unknown;
  };
  return {
    outcome: payload.outcome,
    error: typeof payload.error === "string" && payload.error.length > 0 ? payload.error : null,
  };
};

/** Every side answer in a thread, oldest first. */
export function deriveSideAnswers(input: {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly sideTurn: OrchestrationSideTurn | null | undefined;
}): SideAnswerView[] {
  const views: SideAnswerView[] = [];
  for (const question of input.messages) {
    if (question.role !== "user" || question.sideTurnId === undefined) {
      continue;
    }
    const sideTurnId = question.sideTurnId;
    const answer =
      input.messages.find(
        (message) => message.role === "assistant" && message.sideTurnId === sideTurnId,
      ) ?? null;
    const own = input.activities.filter((activity) => activity.sideTurnId === sideTurnId);
    const outcomeActivity = own.find((activity) => activity.kind === SIDE_ANSWER_OUTCOME_KIND);
    const steps = deriveWorkLogEntries(
      own.filter((activity) => activity.kind !== SIDE_ANSWER_OUTCOME_KIND),
      null,
    );
    const current = input.sideTurn?.sideTurnId === sideTurnId ? input.sideTurn : null;
    // The server records an outcome only when an answer ended without a
    // finished reply: it failed, was stopped (maybe partway), or said nothing.
    const outcome = outcomeActivity !== undefined ? readOutcome(outcomeActivity) : null;
    const state: SideAnswerView["state"] =
      current !== null
        ? current.status === "cancelling"
          ? "stopping"
          : "answering"
        : outcome?.outcome === "interrupted"
          ? "stopped"
          : outcome !== null
            ? "failed"
            : answer !== null
              ? "answered"
              : "stopped";
    views.push({
      sideTurnId,
      participantId: question.participantId ?? null,
      question,
      answer,
      steps,
      state,
      error: state === "failed" ? (outcome?.error ?? "it ended without a reply.") : null,
    });
  }
  return views;
}

/** The rows one side answer draws: its question, its steps, its answer or state. */
export function sideAnswerRows(view: SideAnswerView): MessagesTimelineRow[] {
  const answering = view.state === "answering" || view.state === "stopping";
  const rows: MessagesTimelineRow[] = [
    {
      kind: "message",
      id: view.question.id,
      createdAt: view.question.createdAt,
      message: view.question,
      settledNote: false,
      turnSummary: null,
      showAssistantCopyButton: false,
      assistantCopyStreaming: false,
      assistantTurnInProgress: false,
      tray: null,
      padTop: true,
    },
  ];
  if (view.steps.length > 0) {
    rows.push({
      kind: "work",
      id: `side-steps:${view.sideTurnId}`,
      createdAt: view.steps[0]!.createdAt,
      groupedEntries: [...view.steps],
      agentAnchorEntries: [],
      trackerTurnIds: [],
      trackerAgentSpawnIds: [],
      isLive: answering,
      liveStartedAt: answering ? view.question.createdAt : null,
      inActiveExchange: answering,
      folded: !answering,
      tray: "single",
      padTop: false,
    });
  }
  if (view.answer !== null) {
    rows.push({
      kind: "message",
      id: view.answer.id,
      createdAt: view.answer.createdAt,
      message: view.answer,
      settledNote: false,
      turnSummary: null,
      showAssistantCopyButton: !view.answer.streaming,
      assistantCopyStreaming: view.answer.streaming,
      assistantTurnInProgress: answering,
      tray: null,
      padTop: view.steps.length === 0,
    });
  }
  if (view.state !== "answered") {
    rows.push({
      kind: "side-status",
      id: `side-status:${view.sideTurnId}`,
      createdAt: view.question.createdAt,
      sideTurnId: view.sideTurnId,
      participantId: view.participantId,
      state: view.state,
      error: view.error,
      tray: null,
      padTop: false,
    });
  }
  return rows;
}

const timeOf = (value: string | null) =>
  value === null ? Number.POSITIVE_INFINITY : Date.parse(value);

/**
 * Place side answers among the working turn's rows: where each was asked,
 * moved past any tray it would land inside, so trays stay whole.
 */
export function placeSideAnswerRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
  views: ReadonlyArray<SideAnswerView>,
): MessagesTimelineRow[] {
  if (views.length === 0) {
    return [...rows];
  }
  const inserts = new Map<number, MessagesTimelineRow[]>();
  for (const view of views) {
    const askedAt = Date.parse(view.question.createdAt);
    let index = rows.findIndex((row) => timeOf(row.createdAt) > askedAt);
    if (index === -1) {
      index = rows.length;
    }
    // Never between a tray's rows: past the end of the tray it would split.
    while (
      index < rows.length &&
      (rows[index]!.tray === "middle" || rows[index]!.tray === "last")
    ) {
      index += 1;
    }
    const block = inserts.get(index) ?? [];
    block.push(...sideAnswerRows(view));
    inserts.set(index, block);
  }
  const placed: MessagesTimelineRow[] = [];
  for (let index = 0; index <= rows.length; index += 1) {
    placed.push(...(inserts.get(index) ?? []));
    if (index < rows.length) {
      placed.push(rows[index]!);
    }
  }
  return placed;
}
