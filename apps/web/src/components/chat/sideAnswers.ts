/**
 * Side answers in the chat: a room agent answering read-only while another
 * agent works (docs/design/rooms-slice-2.md), asked by the user or by the
 * working agent through a room tool.
 *
 * The working turn's rows are derived without them: a side question is never
 * "the last user message", and a side answer's steps never join the working
 * turn's trays. The chat reads in the order things were said, and nothing
 * moves once it is on the page:
 *
 * - An exchange goes where it was asked. It closes the working agent's tray
 *   there, and the agent's later work opens a new tray below it.
 * - The user's side question answers as one line under the question, which
 *   opens to show the answer being written. The finished answer is posted at
 *   the time it was done, below whatever went on meanwhile, linked to its
 *   question; opened to watch it, it stays where it was watched instead.
 * - An agent's own ask or review waits for its answer, so it reads as one
 *   block right after the step that asked.
 */
import {
  type OrchestrationSideTurn,
  type OrchestrationThreadActivity,
  type RoomAgentRef,
  SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
  type SideTurnId,
  type ThreadParticipantId,
} from "@threadlines/contracts";

import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface SideAnswerView {
  readonly sideTurnId: SideTurnId;
  readonly participantId: ThreadParticipantId | null;
  /** `review`: an independent review, run fresh with no room context. */
  readonly kind: "ask" | "review";
  /** The agent that asked; null when the user did. */
  readonly askedBy: RoomAgentRef | null;
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
    const outcomeActivity = own.find(
      (activity) => activity.kind === SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
    );
    const steps = deriveWorkLogEntries(
      own.filter((activity) => activity.kind !== SIDE_ANSWER_OUTCOME_ACTIVITY_KIND),
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
    // The question message keeps what the live side turn says, so both last
    // past the settle and a reload.
    views.push({
      sideTurnId,
      participantId: question.participantId ?? null,
      kind: question.requestKind === "review" || current?.kind === "review" ? "review" : "ask",
      askedBy: question.fromAgent ?? current?.askedBy ?? null,
      question,
      answer,
      steps,
      state,
      error: state === "failed" ? (outcome?.error ?? "it ended without a reply.") : null,
    });
  }
  return views;
}

/** Where one side exchange goes in the chat. */
export interface SideExchangePlan {
  readonly view: SideAnswerView;
  readonly askedAtMs: number;
  /** The user's side question, once answered: its answer is posted at the
   *  time it was done, below whatever went on meanwhile. Null: the exchange
   *  is one block where it was asked. */
  readonly publishedAtMs: number | null;
  /** The user's side question: one line under it, answering and then
   *  leading to the answer. */
  readonly compact: boolean;
  /** The reader opened that line to watch the answer. */
  readonly expanded: boolean;
}

const timeOf = (value: string | null | undefined) =>
  value === null || value === undefined ? Number.POSITIVE_INFINITY : Date.parse(value);

/**
 * Decides where each side exchange goes, from the exchange alone (who asked,
 * when it was asked and answered) and whether the reader opened it, never
 * from what else is on the page, which can still change: whether an agent is
 * working, steps that become readable later, older steps loaded as the
 * reader scrolls back.
 */
export function planSideExchanges(input: {
  readonly views: ReadonlyArray<SideAnswerView>;
  readonly expanded: ReadonlySet<SideTurnId>;
}): SideExchangePlan[] {
  return input.views.map((view) => {
    const askedAtMs = timeOf(view.question.createdAt);
    // An agent's own ask or review waits for its answer: one block.
    if (view.askedBy !== null) {
      return { view, askedAtMs, publishedAtMs: null, compact: false, expanded: false };
    }
    const expanded = input.expanded.has(view.sideTurnId);
    const answering = view.state === "answering" || view.state === "stopping";
    return {
      view,
      askedAtMs,
      // Watched under its question, the answer stays there.
      publishedAtMs:
        answering || expanded || view.answer === null
          ? null
          : timeOf(view.answer.completedAt ?? view.answer.createdAt),
      compact: true,
      expanded,
    };
  });
}

/** The times the working agent's steps break at, sorted, so no exchange
 *  lands inside a group of them. */
export function sideExchangeBreaks(plans: ReadonlyArray<SideExchangePlan>): number[] {
  return plans
    .flatMap((plan) =>
      plan.publishedAtMs === null ? [plan.askedAtMs] : [plan.askedAtMs, plan.publishedAtMs],
    )
    .toSorted((a, b) => a - b);
}

/** Whether a sorted break falls in [from, to). */
export function breaksWithin(breaks: ReadonlyArray<number>, from: number, to: number): boolean {
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (breaks[middle]! < from) low = middle + 1;
    else high = middle;
  }
  return low < breaks.length && breaks[low]! < to;
}

const messageRow = (
  message: ChatMessage,
  options: {
    readonly padTop: boolean;
    readonly inProgress?: boolean;
    readonly review?: ChatMessage | undefined;
    readonly replyTo?: ChatMessage | undefined;
  },
): MessagesTimelineRow => ({
  kind: "message",
  id: message.id,
  createdAt: message.createdAt,
  message,
  settledNote: false,
  turnSummary: null,
  showAssistantCopyButton: message.role === "assistant" && !message.streaming,
  assistantCopyStreaming: message.role === "assistant" && message.streaming,
  assistantTurnInProgress: options.inProgress === true,
  ...(options.review !== undefined ? { sideReview: options.review } : {}),
  ...(options.replyTo !== undefined ? { sideReplyTo: options.replyTo } : {}),
  tray: null,
  padTop: options.padTop,
});

/**
 * The rows one side exchange draws: where it was asked (`asked`), and, for
 * the user's answered side question, what is posted when it was done
 * (`published`). The user's question keeps one line under it the whole way,
 * answering and then leading to the answer, so finishing moves nothing.
 */
export function sideExchangeRows(plan: SideExchangePlan): {
  readonly asked: MessagesTimelineRow[];
  readonly published: MessagesTimelineRow[];
} {
  const { view, expanded } = plan;
  const answering = view.state === "answering" || view.state === "stopping";
  const review = view.kind === "review" ? view.question : undefined;
  const steps = (live: boolean, padTop: boolean): MessagesTimelineRow[] =>
    view.steps.length === 0
      ? []
      : [
          {
            kind: "work",
            id: `side-steps:${view.sideTurnId}`,
            createdAt: view.steps[0]!.createdAt,
            sideTurnId: view.sideTurnId,
            groupedEntries: [...view.steps],
            agentAnchorEntries: [],
            trackerTurnIds: [],
            trackerAgentSpawnIds: [],
            isLive: live,
            liveStartedAt: live ? view.question.createdAt : null,
            inActiveExchange: live,
            folded: !live,
            tray: "single",
            padTop,
          },
        ];
  const answer = (padTop: boolean, replyTo?: ChatMessage): MessagesTimelineRow[] =>
    view.answer === null
      ? []
      : [messageRow(view.answer, { padTop, inProgress: answering, review, replyTo })];
  const status = (
    id: string,
    state: Extract<MessagesTimelineRow, { kind: "side-status" }>["state"],
    compact = false,
  ): MessagesTimelineRow => ({
    kind: "side-status",
    id,
    createdAt: view.question.createdAt,
    sideTurnId: view.sideTurnId,
    participantId: view.participantId,
    review: view.kind === "review",
    question: view.question,
    answerMessageId: view.answer?.id ?? null,
    state,
    error: view.error,
    compact,
    expanded: compact && expanded,
    tray: null,
    padTop: false,
  });
  const lineId = `side-status:${view.sideTurnId}`;
  const question = messageRow(view.question, { padTop: true });
  const liveState = view.state === "stopping" ? "stopping" : "answering";

  // An agent's own ask or review: the block it waits on, its state last.
  if (view.askedBy !== null) {
    return {
      asked: [
        question,
        ...steps(answering, false),
        ...answer(view.steps.length === 0),
        ...(view.state === "answered" ? [] : [status(lineId, view.state)]),
      ],
      published: [],
    };
  }
  if (answering) {
    // Folded to its line; opened, the answer is written under it.
    return {
      asked: [
        question,
        status(lineId, liveState, true),
        ...(expanded ? [...steps(true, false), ...answer(view.steps.length === 0)] : []),
      ],
      published: [],
    };
  }
  if (view.answer === null) {
    // Ended before it said anything.
    return {
      asked: [question, status(lineId, view.state === "failed" ? "failed" : "stopped")],
      published: [],
    };
  }
  if (plan.publishedAtMs === null) {
    // Watched: it stays where it was written, and its line folds it away.
    return {
      asked: [
        question,
        status(lineId, "answered", true),
        ...steps(false, false),
        ...answer(view.steps.length === 0),
        ...(view.state === "answered"
          ? []
          : [status(`side-status-end:${view.sideTurnId}`, view.state)]),
      ],
      published: [],
    };
  }
  return {
    asked: [question, status(lineId, "answered-below")],
    published: [
      ...steps(false, true),
      ...answer(view.steps.length === 0, view.question),
      ...(view.state === "answered"
        ? []
        : [status(`side-status-end:${view.sideTurnId}`, view.state)]),
    ],
  };
}

/**
 * Places side exchanges among the working agent's rows, by time: each part
 * after the last row that came before it (rows are not strictly in time
 * order: a settled turn lifts its last steps above its answer, and that must
 * not carry an exchange up with them), and never below the working row, which
 * stays the turn's anchor at the tail. The working agent's step groups were
 * already broken at these times (sideExchangeBreaks), so a part lands between
 * two things the agent put on the page, closing its tray there.
 */
export function placeSideExchanges(
  rows: ReadonlyArray<MessagesTimelineRow>,
  plans: ReadonlyArray<SideExchangePlan>,
): MessagesTimelineRow[] {
  if (plans.length === 0) {
    return [...rows];
  }
  const workingIndex = rows.findIndex((row) => row.kind === "working");
  // Rows by time, each with the furthest position of any row at or before it.
  const byTime = rows
    .flatMap((row, index) =>
      row.kind === "working" ? [] : [{ time: timeOf(row.createdAt), index }],
    )
    .toSorted((a, b) => a.time - b.time);
  const furthest: number[] = [];
  for (const [position, entry] of byTime.entries()) {
    furthest.push(Math.max(entry.index, position > 0 ? furthest[position - 1]! : -1));
  }
  const indexAt = (time: number) => {
    let low = 0;
    let high = byTime.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (byTime[middle]!.time <= time) low = middle + 1;
      else high = middle;
    }
    const after = low === 0 ? 0 : furthest[low - 1]! + 1;
    return workingIndex !== -1 ? Math.min(after, workingIndex) : after;
  };
  const inserts: Array<{ index: number; time: number; rows: MessagesTimelineRow[] }> = [];
  for (const plan of plans) {
    const parts = sideExchangeRows(plan);
    inserts.push({ index: indexAt(plan.askedAtMs), time: plan.askedAtMs, rows: parts.asked });
    if (plan.publishedAtMs !== null && parts.published.length > 0) {
      inserts.push({
        index: indexAt(plan.publishedAtMs),
        time: plan.publishedAtMs,
        rows: parts.published,
      });
    }
  }
  inserts.sort((a, b) => a.index - b.index || a.time - b.time);
  const placed: MessagesTimelineRow[] = [];
  let next = 0;
  for (let index = 0; index <= rows.length; index += 1) {
    while (next < inserts.length && inserts[next]!.index === index) {
      placed.push(...inserts[next]!.rows);
      next += 1;
    }
    if (index < rows.length) {
      placed.push(rows[index]!);
    }
  }
  return placed;
}

/** A row that belongs to a side exchange rather than the working agent. */
export function isSideRow(row: MessagesTimelineRow): boolean {
  return (
    row.kind === "side-status" ||
    (row.kind === "message" && row.message.sideTurnId !== undefined) ||
    (row.kind === "work" && row.sideTurnId !== undefined)
  );
}
