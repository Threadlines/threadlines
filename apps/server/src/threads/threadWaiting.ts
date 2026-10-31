/**
 * What a thread waits on the user for, item by item: each open approval
 * (a tool's, a scheduled-task change an agent asked for, threads its agent
 * asked to start), each open question, and its plan to review. `thread_read`
 * and `thread_wait` show them in detail, `inbox` as a list with Threadlines'
 * own one-line summary of each.
 *
 * The details (a command, a question, a plan's title) are the agent's words,
 * clipped; the summary is Threadlines' and says only what kind of thing waits.
 */
import type {
  OrchestrationThread,
  OrchestrationThreadShell,
  ScheduledTaskRequest,
} from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";

import { actionableProposedPlan, proposedPlanTitle } from "../orchestration/proposedPlans.ts";
import { threadStatus } from "./threadOperations.ts";

/** What an approval asks for. */
export type ThreadApprovalAsk =
  | "command"
  | "file-read"
  | "file-change"
  | "permissions"
  | "terminal-input"
  | "scheduled-task"
  | "start-threads"
  | "other";

export interface ThreadWaitingQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}

export interface ThreadWaitingItem {
  readonly kind: "approval" | "question" | "plan";
  /** The request it waits on; for a plan, the plan's id. */
  readonly requestId: string;
  /** When it was asked. */
  readonly askedAt: string;
  /** Threadlines' words for what waits ("Wants to run a command"). */
  readonly summary: string;
  /** Approval: what it asks for. */
  readonly asks?: ThreadApprovalAsk;
  /** Approval: the tool it is for, when the agent named one. */
  readonly tool?: string;
  /** Approval: the command, file path or change it is about (the agent's words, clipped). */
  readonly detail?: string;
  /** Question: its questions and their options (the agent's words, clipped). */
  readonly questions?: ReadonlyArray<ThreadWaitingQuestion>;
  /** Plan: its title, its first heading (the agent's words); null without one. */
  readonly title?: string | null;
}

/** An approval's detail, at most this long. */
export const WAITING_DETAIL_CHAR_LIMIT = 300;
const QUESTION_CHAR_LIMIT = 500;
const OPTION_CHAR_LIMIT = 200;
const OPTIONS_LISTED = 12;
const QUESTIONS_LISTED = 8;

const clip = (text: string, limit: number) => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const ASKS: Readonly<Record<string, { readonly asks: ThreadApprovalAsk; readonly says: string }>> =
  {
    command: { asks: "command", says: "Wants to run a command" },
    "file-read": { asks: "file-read", says: "Wants to read a file" },
    "file-change": { asks: "file-change", says: "Wants to change files" },
    permissions: { asks: "permissions", says: "Wants more permissions" },
    "terminal-input": { asks: "terminal-input", says: "Wants to type into a terminal" },
  };

const titleOf = (planMarkdown: string) => {
  const title = proposedPlanTitle(planMarkdown);
  return title === null ? null : clip(title, WAITING_DETAIL_CHAR_LIMIT);
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function questionsOf(payload: Readonly<Record<string, unknown>>) {
  const raw = Array.isArray(payload.questions) ? payload.questions : [];
  return raw.slice(0, QUESTIONS_LISTED).flatMap((entry): ReadonlyArray<ThreadWaitingQuestion> => {
    const question = record(entry);
    const asked = text(question.question);
    if (asked === undefined) return [];
    const options = Array.isArray(question.options) ? question.options : [];
    return [
      {
        header: clip(text(question.header) ?? "", OPTION_CHAR_LIMIT),
        question: clip(asked, QUESTION_CHAR_LIMIT),
        options: options.slice(0, OPTIONS_LISTED).flatMap((option) => {
          const label = text(record(option).label);
          return label === undefined
            ? []
            : [
                {
                  label: clip(label, OPTION_CHAR_LIMIT),
                  description: clip(text(record(option).description) ?? "", OPTION_CHAR_LIMIT),
                },
              ];
        }),
        multiSelect: question.multiSelect === true,
      },
    ];
  });
}

/**
 * Everything `thread` waits on the user for, approvals first, then
 * questions, then its plan. The plan counts only while the thread needs the
 * user (it isn't working on something else, and wasn't marked done), as its
 * status says.
 */
export function threadWaitingItems(
  thread: OrchestrationThread,
  context: {
    readonly shell: OrchestrationThreadShell;
    /** Agents' scheduled-task changes waiting for the user, on any thread. */
    readonly scheduleRequests: ReadonlyArray<ScheduledTaskRequest>;
  },
): ReadonlyArray<ThreadWaitingItem> {
  const items: ThreadWaitingItem[] = [];
  for (const { requestId, activity } of collectOpenPendingRequests(
    thread.activities,
    APPROVAL_ACTIVITY_KINDS,
  )) {
    const payload = record(activity.payload);
    const known = ASKS[text(payload.requestKind) ?? ""];
    const tool = text(payload.toolName);
    const detail = text(payload.detail) ?? text(payload.blockedPath);
    items.push({
      kind: "approval",
      requestId,
      askedAt: activity.createdAt,
      summary: known?.says ?? "Needs your approval",
      asks: known?.asks ?? "other",
      ...(tool !== undefined ? { tool } : {}),
      ...(detail !== undefined ? { detail: clip(detail, WAITING_DETAIL_CHAR_LIMIT) } : {}),
    });
  }
  for (const request of context.scheduleRequests) {
    if (request.threadId !== thread.id) continue;
    items.push({
      kind: "approval",
      requestId: request.requestId,
      askedAt: request.createdAt,
      summary:
        request.action === "create"
          ? "Wants to create a scheduled task"
          : "Wants to change a scheduled task",
      asks: "scheduled-task",
      detail: clip([request.name, ...request.details].join(" · "), WAITING_DETAIL_CHAR_LIMIT),
    });
  }
  const batches = new Map<string, { askedAt: string; starts: number; sends: number }>();
  for (const request of thread.childRequests?.open ?? []) {
    if (request.status !== "awaiting_user") continue;
    const batch = batches.get(request.batchId) ?? {
      askedAt: request.createdAt,
      starts: 0,
      sends: 0,
    };
    if (request.createdAt < batch.askedAt) batch.askedAt = request.createdAt;
    if (request.kind === "start") batch.starts += 1;
    else batch.sends += 1;
    batches.set(request.batchId, batch);
  }
  for (const [batchId, batch] of batches) {
    items.push({
      kind: "approval",
      requestId: batchId,
      askedAt: batch.askedAt,
      summary:
        batch.sends === 0
          ? `Wants to start ${plural(batch.starts, "thread")}`
          : batch.starts === 0
            ? `Wants to message ${plural(batch.sends, "thread")}`
            : `Wants to start or message ${plural(batch.starts + batch.sends, "thread")}`,
      asks: "start-threads",
    });
  }
  for (const { requestId, activity } of collectOpenPendingRequests(
    thread.activities,
    USER_INPUT_ACTIVITY_KINDS,
  )) {
    const questions = questionsOf(record(activity.payload));
    items.push({
      kind: "question",
      requestId,
      askedAt: activity.createdAt,
      summary:
        questions.length > 1 ? `Asked you ${questions.length} questions` : "Asked you a question",
      questions,
    });
  }
  const status = threadStatus(
    context.shell,
    context.scheduleRequests.some((request) => request.threadId === thread.id),
  );
  if (status.word === "needs the user") {
    const plan = actionableProposedPlan({
      latestTurnId: thread.latestTurn?.turnId ?? null,
      proposedPlans: thread.proposedPlans,
      idOf: (entry) => entry.id,
    });
    if (plan !== undefined) {
      items.push({
        kind: "plan",
        requestId: plan.id,
        askedAt: plan.createdAt,
        summary: "Has a plan for you to review",
        title: titleOf(plan.planMarkdown),
      });
    }
  }
  return items;
}
