/**
 * Whether an alert still holds, as its thread is now: the checks phone alerts
 * (PushAlerts) and the assistants' event record (AssistantEvents) both make
 * before an alert goes out or an event becomes final. Phones add their own
 * presence rule on top; the record has none.
 *
 * - an approval or question still open;
 * - a scheduled-task change still waiting for the user;
 * - a finished turn that is still the newest, with no work going on
 *   (`childHasLiveWork` defers it), and a plan it left to review turning it
 *   into "needs you";
 * - a child thread an agent on a linked computer started: once its report
 *   reached that computer, the asking thread's own alert is the one that
 *   counts.
 */
import type { OrchestrationThread, PushAlertKind, ThreadId } from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { LinkRequestRepository, type LinkRequestRow } from "../links/LinkRequestRepository.ts";
import { childHasLiveWork } from "../orchestration/childThreadDecisions.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PushAlertReason } from "./pushAlertRules.ts";

/** What an alert is about, as both its owners keep it. */
export interface AlertSubject {
  readonly alertId: string;
  readonly threadId: ThreadId;
  readonly kind: PushAlertKind;
  readonly reason: string;
  /** The request, turn or side answer it is about. */
  readonly subjectId: string;
  readonly occurredAt: string;
}

export type AlertVerdict =
  | {
      readonly type: "send";
      readonly kind: PushAlertKind;
      readonly reason: PushAlertReason;
      readonly thread: OrchestrationThread;
      /** The plan left to review, when a finished turn became "needs you". */
      readonly planId: string | null;
    }
  | { readonly type: "drop" }
  | { readonly type: "defer"; readonly untilMs: number };

/** The scheduled-task changes waiting for the user, as the alert's owner last heard. */
export interface ScheduleRequestsSeen {
  /** This server has scheduled tasks at all. */
  readonly available: boolean;
  /** The scheduler's first snapshot came; before it a schedule alert can't be judged. */
  readonly seen: boolean;
  readonly waiting: ReadonlySet<string>;
}

/** A finished turn whose thread still has work going is looked at again after this. */
export const LIVE_WORK_RECHECK_MS = 10_000;
/** A thread read that failed, or a schedule alert before the first snapshot, is tried again after this. */
export const READ_RETRY_MS = 5_000;
/** How far apart a turnless report and the outcome it answers may be written. */
const LINK_REPORT_SLACK_MS = 60_000;
/** How long a child's alert waits for its report to reach the asking computer. */
const LINK_DELIVERY_WAIT_MS = 60_000;
/** Alerts that ask the user for something: no report to another agent stands in for them. */
const ASKS_THE_USER: ReadonlySet<string> = new Set(["approval", "question", "schedule"]);

const DROP: AlertVerdict = { type: "drop" };

/** Whether a link request's report tells the asking agent about this alert's outcome. */
function reportCovers(row: LinkRequestRow, alert: AlertSubject): boolean {
  if (row.reportTurnId === alert.subjectId || row.turnId === alert.subjectId) return true;
  if (row.reportTurnId !== null || row.settledAt === null) return false;
  // A report naming no turn: a start that failed, or a restart that cut
  // whatever ran off (a background continuation too). It answers an outcome
  // of that kind written about the same moment.
  const near =
    Math.abs(Date.parse(row.settledAt) - Date.parse(alert.occurredAt)) <= LINK_REPORT_SLACK_MS;
  switch (alert.reason) {
    case "start-failed":
      return near && row.turnId === null;
    case "restart":
      return near;
    default:
      return false;
  }
}

function hasOpenRequest(
  thread: OrchestrationThread,
  reason: "approval" | "question",
  requestId: string,
): boolean {
  const kinds = reason === "approval" ? APPROVAL_ACTIVITY_KINDS : USER_INPUT_ACTIVITY_KINDS;
  return collectOpenPendingRequests(thread.activities, kinds).some(
    (request) => request.requestId === requestId,
  );
}

/** The plan `turnId` left for the user, neither implemented nor dismissed. */
function actionablePlanOf(thread: OrchestrationThread, turnId: string) {
  return thread.proposedPlans.findLast(
    (plan) => plan.turnId === turnId && plan.implementedAt === null && plan.dismissedAt === null,
  );
}

export const makeAlertChecks = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const linkRequests = yield* Effect.serviceOption(LinkRequestRepository);

  /**
   * A thread an agent on a linked computer started answers that agent: once
   * its result reached that computer, the asking thread's own alert is the one
   * that counts. "waiting" while the report is on its way; a computer that
   * doesn't take it for a while is likely offline, so this alert holds.
   */
  const answeredOverLink = (thread: OrchestrationThread, alert: AlertSubject, now: number) =>
    Effect.gen(function* () {
      if (!thread.remoteOrigin || Option.isNone(linkRequests)) return "no" as const;
      const rows = yield* linkRequests.value.listByThread(thread.id);
      const reports = rows.filter((row) => row.reportId !== null && reportCovers(row, alert));
      if (reports.some((row) => row.deliveredAt !== null)) return "answered" as const;
      return reports.some(
        (row) => row.settledAt !== null && now - Date.parse(row.settledAt) < LINK_DELIVERY_WAIT_MS,
      )
        ? ("waiting" as const)
        : ("no" as const);
    });

  /** Whether the alert still holds, as the thread is now. */
  const judge = (
    alert: AlertSubject,
    now: number,
    schedule: ScheduleRequestsSeen,
  ): Effect.Effect<AlertVerdict> =>
    Effect.gen(function* () {
      const read = yield* projections.getThreadDetailById(alert.threadId).pipe(
        Effect.map((found) => ({ ok: true as const, found })),
        Effect.orElseSucceed(() => ({ ok: false as const })),
      );
      // A read that failed says nothing about the thread: look again soon.
      if (!read.ok) return { type: "defer", untilMs: now + READ_RETRY_MS } satisfies AlertVerdict;
      // Archived or deleted: nothing to say.
      if (Option.isNone(read.found)) return DROP;
      const thread = read.found.value;
      if (!ASKS_THE_USER.has(alert.reason)) {
        const answered = yield* answeredOverLink(thread, alert, now).pipe(
          Effect.orElseSucceed(() => "unread" as const),
        );
        if (answered === "answered") return DROP;
        if (answered !== "no") {
          return { type: "defer", untilMs: now + READ_RETRY_MS } satisfies AlertVerdict;
        }
      }
      const send = (
        kind: PushAlertKind,
        reason: PushAlertReason,
        planId: string | null = null,
      ): AlertVerdict => ({ type: "send", kind, reason, thread, planId });
      switch (alert.reason) {
        case "approval":
        case "question":
          return hasOpenRequest(thread, alert.reason, alert.subjectId)
            ? send("needs_you", alert.reason)
            : DROP;
        case "schedule":
          if (!schedule.available) return DROP;
          if (!schedule.seen) {
            return { type: "defer", untilMs: now + READ_RETRY_MS } satisfies AlertVerdict;
          }
          return schedule.waiting.has(alert.subjectId) ? send("needs_you", "schedule") : DROP;
        case "plan": {
          // A plan alert that waits for a retry still needs its plan open, on the latest turn.
          const plan =
            thread.latestTurn?.turnId === alert.subjectId
              ? actionablePlanOf(thread, alert.subjectId)
              : undefined;
          return plan !== undefined ? send("needs_you", "plan", plan.id) : DROP;
        }
        case "finished": {
          if (alert.alertId.startsWith("turn:")) {
            // A newer turn took over: that one alerts for itself.
            if (thread.latestTurn?.turnId !== alert.subjectId) return DROP;
            const plan = actionablePlanOf(thread, alert.subjectId);
            if (plan !== undefined) return send("needs_you", "plan", plan.id);
          }
          // More work going (a queued message, a side answer, awaited tasks, a
          // request): not finished yet. Looked at again until it expires.
          if (childHasLiveWork(thread)) {
            return { type: "defer", untilMs: now + LIVE_WORK_RECHECK_MS } satisfies AlertVerdict;
          }
          return send("finished", "finished");
        }
        default:
          return send(alert.kind, alert.reason as PushAlertReason);
      }
    });

  return { judge };
});

export type AlertChecks = Effect.Success<typeof makeAlertChecks>;
