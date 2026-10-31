/**
 * Which orchestration events are worth a phone alert (docs/design/push-alerts.md).
 * Pure: an event in, the alerts it starts, cancels or rules out. Every alert
 * has a stable id built from what it is about (a request, a turn, a side
 * answer), so reading the same event twice, or two events about the same
 * thing, can never alert twice. Whether an alert still holds is checked
 * again right before it goes out (PushAlerts), from the thread as it is then.
 */
import type { OrchestrationEvent, PushAlertKind, ThreadId } from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  extractPendingRequestId,
  isStalePendingRequestFailureDetail,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";

/** Why an alert goes out; decides its words and, for some, whether it still holds. */
export type PushAlertReason =
  | "approval"
  | "question"
  | "plan"
  | "schedule"
  | "finished"
  | "error"
  | "restart"
  | "start-failed"
  | "side-failed";

export interface PushAlertIntent {
  readonly alertId: string;
  readonly threadId: ThreadId;
  readonly kind: PushAlertKind;
  readonly reason: PushAlertReason;
  /** The request, turn or side answer it is about. */
  readonly subjectId: string;
  /** An error's own words, when there are any. */
  readonly detail: string | null;
  /** Wait this long first: more work may follow a finished turn, or a parent may take the result. */
  readonly holdMs: number;
  /** When the thing it is about happened. */
  readonly occurredAt: string;
}

export type PushAlertAction =
  | { readonly type: "add"; readonly intent: PushAlertIntent }
  /** The thing it was about is over (an answered request). */
  | { readonly type: "cancel"; readonly alertId: string }
  /** Nothing of these kinds still waiting for this thread should go out. */
  | {
      readonly type: "cancel-thread";
      readonly threadId: ThreadId;
      readonly kinds: ReadonlyArray<PushAlertKind>;
    }
  /** Never alert this one, even if a later event would (an interrupt the user asked for). */
  | { readonly type: "suppress"; readonly alertId: string; readonly threadId: ThreadId };

/** A finished turn waits this long: the agent often goes on (a queued message, a woken task). */
export const FINISHED_HOLD_MS = 8_000;
/** A failure waits a little, so a parent thread that takes a child's result can claim it. */
export const FAILED_HOLD_MS = 3_000;
/** How long an alert is worth sending: needs-you stays relevant longer. */
export const ALERT_LIFETIME_MS: Record<PushAlertKind, number> = {
  needs_you: 30 * 60_000,
  finished: 10 * 60_000,
  failed: 10 * 60_000,
};
/** Events older than this (read late, after downtime) start no alerts. */
export const ALERT_EVENT_MAX_AGE_MS = 10 * 60_000;

const ALL_KINDS: ReadonlyArray<PushAlertKind> = ["needs_you", "finished", "failed"];
const DONE_KINDS: ReadonlyArray<PushAlertKind> = ["finished", "failed"];

export const turnAlertId = (turnId: string) => `turn:${turnId}`;
export const sideTurnAlertId = (sideTurnId: string) => `side:${sideTurnId}`;
export const scheduleRequestAlertId = (requestId: string) => `schedule:${requestId}`;

const add = (intent: PushAlertIntent): PushAlertAction => ({ type: "add", intent });

function activityDetail(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const detail = (payload as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim().length > 0 ? detail.trim() : null;
}

/** A turn that ended on its own: finished, or failed. */
const turnEndAlert = (
  occurredAt: string,
  threadId: ThreadId,
  turnId: string,
  completed: boolean,
): ReadonlyArray<PushAlertAction> => [
  add({
    occurredAt,
    alertId: turnAlertId(turnId),
    threadId,
    kind: completed ? "finished" : "failed",
    reason: completed ? "finished" : "error",
    subjectId: turnId,
    detail: null,
    holdMs: completed ? FINISHED_HOLD_MS : FAILED_HOLD_MS,
  }),
];

/** The alerts one event starts, cancels or rules out. */
export function pushAlertActionsForEvent(
  event: OrchestrationEvent,
): ReadonlyArray<PushAlertAction> {
  switch (event.type) {
    case "thread.activity-appended": {
      const { threadId, activity } = event.payload;
      const requestId = extractPendingRequestId(activity.payload);
      switch (activity.kind) {
        case APPROVAL_ACTIVITY_KINDS.requested:
        case USER_INPUT_ACTIVITY_KINDS.requested: {
          if (requestId === null) return [];
          const reason =
            activity.kind === APPROVAL_ACTIVITY_KINDS.requested ? "approval" : "question";
          return [
            add({
              occurredAt: event.occurredAt,
              alertId: `${reason}:${requestId}`,
              threadId,
              kind: "needs_you",
              reason,
              subjectId: requestId,
              detail: null,
              holdMs: 0,
            }),
          ];
        }
        case APPROVAL_ACTIVITY_KINDS.resolved:
          return requestId === null ? [] : [{ type: "cancel", alertId: `approval:${requestId}` }];
        case USER_INPUT_ACTIVITY_KINDS.resolved:
          return requestId === null ? [] : [{ type: "cancel", alertId: `question:${requestId}` }];
        case APPROVAL_ACTIVITY_KINDS.respondFailed:
        case USER_INPUT_ACTIVITY_KINDS.respondFailed: {
          if (
            requestId === null ||
            !isStalePendingRequestFailureDetail(activityDetail(activity.payload))
          ) {
            return [];
          }
          const prefix =
            activity.kind === APPROVAL_ACTIVITY_KINDS.respondFailed ? "approval" : "question";
          return [{ type: "cancel", alertId: `${prefix}:${requestId}` }];
        }
        case "provider.session.restart-interrupted":
          return [
            add({
              occurredAt: event.occurredAt,
              alertId:
                activity.turnId !== null ? turnAlertId(activity.turnId) : `restart:${activity.id}`,
              threadId,
              kind: "failed",
              reason: "restart",
              subjectId: activity.turnId ?? activity.id,
              detail: null,
              holdMs: FAILED_HOLD_MS,
            }),
          ];
        case "provider.turn.start.failed":
          return [
            add({
              occurredAt: event.occurredAt,
              alertId: `start:${activity.id}`,
              threadId,
              kind: "failed",
              reason: "start-failed",
              subjectId: activity.id,
              detail: activityDetail(activity.payload) ?? activity.summary,
              holdMs: FAILED_HOLD_MS,
            }),
          ];
        default:
          return [];
      }
    }
    case "thread.turn-interrupt-requested": {
      const { threadId, turnId } = event.payload;
      // The user stopped it: no "failed" alert for that turn, whatever comes next.
      return turnId === undefined
        ? []
        : [{ type: "suppress", alertId: turnAlertId(turnId), threadId }];
    }
    // A turn in a git checkout ends with its final capture; the rest end
    // with thread.turn-completed. Both share the turn's alert id, so a turn
    // that gets both (a late settle) still alerts once.
    case "thread.turn-diff-completed": {
      const { threadId, turnId, status, completesTurn } = event.payload;
      // Older events without the flag are past ALERT_EVENT_MAX_AGE_MS anyway.
      if (completesTurn !== true || status === "missing") return [];
      return turnEndAlert(event.occurredAt, threadId, turnId, status === "ready");
    }
    case "thread.turn-completed": {
      const { threadId, turnId, state } = event.payload;
      if (state === "interrupted") return [];
      return turnEndAlert(event.occurredAt, threadId, turnId, state === "completed");
    }
    case "thread.side-turn-settled": {
      const { threadId, sideTurnId, outcome, error } = event.payload;
      if (outcome === "interrupted") return [];
      return [
        add({
          occurredAt: event.occurredAt,
          alertId: sideTurnAlertId(sideTurnId),
          threadId,
          kind: outcome === "completed" ? "finished" : "failed",
          reason: outcome === "completed" ? "finished" : "side-failed",
          subjectId: sideTurnId,
          detail: error ?? null,
          holdMs: outcome === "completed" ? FINISHED_HOLD_MS : FAILED_HOLD_MS,
        }),
      ];
    }
    case "thread.child-request-settled":
      // The child's result went to the parent thread, whose agent carries on
      // with it: the parent's own alert is the one that counts.
      return [{ type: "cancel-thread", threadId: event.payload.childThreadId, kinds: DONE_KINDS }];
    case "thread.seen-set":
      // Opened somewhere: no need to say it finished.
      return [{ type: "cancel-thread", threadId: event.payload.threadId, kinds: DONE_KINDS }];
    case "thread.done-override-set":
      return event.payload.state === "done"
        ? [{ type: "cancel-thread", threadId: event.payload.threadId, kinds: DONE_KINDS }]
        : [];
    case "thread.archived":
    case "thread.deleted":
    case "thread.moved-away":
      return [{ type: "cancel-thread", threadId: event.payload.threadId, kinds: ALL_KINDS }];
    default:
      return [];
  }
}

// ----- what an alert says ----------------------------------------------------------

const REASON_TEXT: Record<PushAlertReason, string> = {
  approval: "Needs your approval",
  question: "Asked you a question",
  plan: "Has a plan for you to review",
  schedule: "Wants to change a scheduled task",
  finished: "Finished",
  error: "Stopped with an error",
  restart: "Stopped when Threadlines restarted",
  "start-failed": "Couldn't start",
  "side-failed": "Couldn't finish a side answer",
};

/** An alert's reason in the words a phone shows it; a reason these rules don't know reads as itself. */
export const alertReasonText = (reason: string): string =>
  Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason as PushAlertReason] : reason;

/** What fits in one push message once sealed (RFC 8291: 4096 less the header and padding). */
export const MAX_ALERT_PLAINTEXT_BYTES = 3993;

const clip = (text: string, max: number) => {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
};

/**
 * The alert as the phone shows it: Declarative Web Push's shape, which iOS
 * 18.4+ shows by itself, and which the service worker shows elsewhere.
 */
export function alertPayload(input: {
  readonly threadTitle: string;
  readonly reason: PushAlertReason;
  readonly detail: string | null;
  readonly computerLabel: string | null;
  /** Where a tap opens the thread, on the phone's own app. */
  readonly navigate: string;
}): string {
  const build = (titleMax: number, detailMax: number) => {
    const where = input.computerLabel ? ` · ${clip(input.computerLabel, 40)}` : "";
    const detail = input.detail && detailMax > 0 ? `: ${clip(input.detail, detailMax)}` : "";
    return JSON.stringify({
      web_push: 8030,
      notification: {
        title: clip(input.threadTitle || "Thread", titleMax),
        body: `${REASON_TEXT[input.reason]}${detail}${where}`,
        navigate: input.navigate,
      },
    });
  };
  for (const [titleMax, detailMax] of [
    [80, 140],
    [60, 60],
    [40, 0],
  ] as const) {
    const text = build(titleMax, detailMax);
    if (new TextEncoder().encode(text).length <= MAX_ALERT_PLAINTEXT_BYTES) return text;
  }
  // Only an absurd address could get here; the relay would refuse it anyway.
  return build(20, 0);
}

/** The test alert from Settings: proof that this computer can reach the phone. */
export function testAlertPayload(input: {
  readonly computerLabel: string | null;
  readonly navigate: string;
}): string {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: "Threadlines",
      body: input.computerLabel
        ? `Alerts from ${clip(input.computerLabel, 40)} are working.`
        : "Alerts are working.",
      navigate: input.navigate,
    },
  });
}

/** Attempts per delivery before it gives up (a phone, or a web address's alert). */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** Delay before retry `attempt` (1-based): 5 s, 15 s, 45 s, ... up to 5 minutes. */
export function retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
  const backoff = Math.min(5_000 * 3 ** Math.max(0, attempt - 1), 5 * 60_000);
  return retryAfterSeconds === undefined ? backoff : Math.max(backoff, retryAfterSeconds * 1000);
}
