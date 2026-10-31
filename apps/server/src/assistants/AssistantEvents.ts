/**
 * The assistants' event record (docs/design/assistants.md, "The event
 * record and where it goes", 1): a durable list of the times a thread needed
 * the user, finished or failed, for assistants that check in every few
 * hours. It is the source of `inbox`'s finished and failed, and later of
 * webhooks and MCP Events.
 *
 * Built from the phone alerts' rules (pushAlertRules.ts) over the
 * orchestration event log, from its own saved cursor, but none of the phone
 * pipeline's tables or rules about people: no age rule (an event read late
 * still counts) and no presence rule (a thread someone is looking at still
 * gets its event; a visit only marks it seen).
 *
 * Every intent is a row at once, in the transaction that moves the cursor:
 * `settling` until its hold is over (needs-you at once, finished 8 s,
 * failed 3 s), then checked against the thread as it is then with the
 * checks phones use (alertChecks.ts) and made `recorded` with the next `seq`,
 * or `dropped`. So `seq` follows the order events became final, and a
 * restart carries on with the rows still settling. Cancels before recording
 * drop a row; after, they resolve it (`resolved_at`, `resolved_reason`).
 *
 * New here, not in the phone rules: a plan that is dismissed, implemented or
 * replaced resolves its `plan:<id>` row.
 *
 * The record is kept only while an assistant connection exists. Turning on
 * with no cursor saved starts at the newest event, so history is never
 * recorded; turning off forgets the cursor, so the time it was off never is.
 * Rows are kept 7 days.
 */
import type {
  OrchestrationEvent,
  ProjectId,
  PushAlertKind,
  ThreadId,
} from "@threadlines/contracts";
import {
  PENDING_REQUEST_EXPIRED_REASON,
  PENDING_REQUEST_INTERRUPTED_REASON,
} from "@threadlines/shared/pendingRequests";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import { type PushAlertIntent, pushAlertActionsForEvent } from "../pushAlerts/pushAlertRules.ts";
import type { AssistantEventRepositoryError } from "./AssistantEventRepository.ts";

export const AssistantEventNameSchema = Schema.Literals([
  "thread.needs_you",
  "thread.finished",
  "thread.failed",
]);
export type AssistantEventName = typeof AssistantEventNameSchema.Type;

const NAME_OF_KIND: Record<PushAlertKind, AssistantEventName> = {
  needs_you: "thread.needs_you",
  finished: "thread.finished",
  failed: "thread.failed",
};
export const assistantEventNameOf = (kind: PushAlertKind) => NAME_OF_KIND[kind];

/** One recorded event. */
export interface AssistantEvent {
  /** Stays the same for the event's whole life (a webhook's id). */
  readonly eventId: string;
  readonly seq: number;
  readonly name: AssistantEventName;
  /** Why (pushAlertRules' PushAlertReason): `approval`, `finished`, `error`, ... */
  readonly reason: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** When the thing it is about happened. */
  readonly occurredAt: string;
  /** When it became final. */
  readonly recordedAt: string;
  /** When it stopped standing, and why (`answered`, `seen`, `archived`, ...); null while it stands. */
  readonly resolvedAt: string | null;
  readonly resolvedReason: string | null;
}

/** What one event means for the record's rows. */
export type AssistantEventAction =
  | { readonly type: "add"; readonly intent: PushAlertIntent }
  /** The thing it was about is over: drop it if settling, resolve it if recorded. */
  | { readonly type: "cancel"; readonly subjectKey: string; readonly why: string }
  /**
   * The same for every row of these names on the thread. `keepSettling`: a
   * visit, which resolves rows without dropping the ones still settling, and
   * only rows that happened at or before `seenAt` (the app stamps a visit
   * with the turn's completion time, and "Mark unread" a moment before it).
   */
  | {
      readonly type: "cancel-thread";
      readonly threadId: ThreadId;
      readonly names: ReadonlyArray<AssistantEventName>;
      readonly why: string;
      readonly keepSettling: boolean;
      readonly seenAt?: string;
    }
  /** Never record this one, even if a later event would (an interrupt the user asked for). */
  | {
      readonly type: "suppress";
      readonly subjectKey: string;
      readonly threadId: ThreadId;
      readonly why: string;
    }
  /** Every `plan:` row of the thread but `except` stops standing: a newer plan replaced them. */
  | {
      readonly type: "resolve-plans";
      readonly threadId: ThreadId;
      readonly except: string;
      readonly why: string;
    };

export const planEventKey = (planId: string) => `plan:${planId}`;

/** Why the rows of a thread stop standing, by the event that says so. */
const THREAD_CANCEL_REASON: Partial<Record<OrchestrationEvent["type"], string>> = {
  "thread.child-request-settled": "taken_by_parent",
  "thread.seen-set": "seen",
  "thread.done-override-set": "wrapped",
  "thread.archived": "archived",
  "thread.deleted": "deleted",
  "thread.moved-away": "moved",
};

/** An answered request, or one closed for it (its session stopped, its turn was interrupted). */
const requestCloseReason = (event: OrchestrationEvent): string => {
  if (event.type !== "thread.activity-appended") return "answered";
  const { activity } = event.payload;
  if (activity.kind.endsWith(".respond.failed")) return "closed";
  const reason =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as { readonly reason?: unknown }).reason
      : undefined;
  return reason === PENDING_REQUEST_EXPIRED_REASON || reason === PENDING_REQUEST_INTERRUPTED_REASON
    ? "closed"
    : "answered";
};

/** What one event means for the record: the phone rules, plus the plan rule. */
export function assistantEventActionsForEvent(
  event: OrchestrationEvent,
): ReadonlyArray<AssistantEventAction> {
  const actions: AssistantEventAction[] = pushAlertActionsForEvent(event).map(
    (action): AssistantEventAction => {
      switch (action.type) {
        case "add":
          return action;
        case "cancel":
          return { type: "cancel", subjectKey: action.alertId, why: requestCloseReason(event) };
        case "cancel-thread":
          return {
            type: "cancel-thread",
            threadId: action.threadId,
            names: action.kinds.map(assistantEventNameOf),
            why: THREAD_CANCEL_REASON[event.type] ?? "closed",
            keepSettling: event.type === "thread.seen-set",
            ...(event.type === "thread.seen-set" ? { seenAt: event.payload.at } : {}),
          };
        case "suppress":
          return {
            type: "suppress",
            subjectKey: action.alertId,
            threadId: action.threadId,
            why: "interrupted",
          };
      }
    },
  );
  if (event.type === "thread.proposed-plan-upserted") {
    const { threadId, proposedPlan } = event.payload;
    const key = planEventKey(proposedPlan.id);
    actions.push(
      proposedPlan.implementedAt !== null || proposedPlan.dismissedAt !== null
        ? { type: "cancel", subjectKey: key, why: "plan_closed" }
        : { type: "resolve-plans", threadId, except: key, why: "plan_replaced" },
    );
  }
  return actions;
}

// ----- cursors ---------------------------------------------------------------

const CURSOR_PREFIX = "ae1";

const toBase64Url = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const fromBase64Url = (text: string) => atob(text.replaceAll("-", "+").replaceAll("_", "/"));

/** An opaque cursor: this record's id and the `seq` read up to. */
export const encodeEventCursor = (recordId: string, seq: number) =>
  toBase64Url(`${CURSOR_PREFIX}:${recordId}:${seq}`);

/** A cursor's record id and `seq`; null when it isn't one of ours. */
export const decodeEventCursor = (
  cursor: string,
): { readonly recordId: string; readonly seq: number } | null => {
  try {
    const [prefix, recordId, seqText, ...rest] = fromBase64Url(cursor.trim()).split(":");
    const seq = Number(seqText);
    if (prefix !== CURSOR_PREFIX || rest.length > 0 || !recordId || !Number.isSafeInteger(seq)) {
      return null;
    }
    return seq < 0 ? null : { recordId, seq };
  } catch {
    return null;
  }
};

// ----- the service -----------------------------------------------------------

/** Where the record stands. */
export interface AssistantEventsPosition {
  readonly recordId: string;
  /** Kept now: an assistant connection exists and the record is reading the event log. */
  readonly running: boolean;
  /** The highest `seq` recorded so far (0 before any). */
  readonly lastSeq: number;
  /** Events at or below this `seq` were pruned. */
  readonly prunedThroughSeq: number;
}

export interface AssistantEventsShape {
  readonly position: Effect.Effect<AssistantEventsPosition, AssistantEventRepositoryError>;
  /**
   * Recorded events after `after`, oldest first, at most `limit`, only these
   * names and projects when given. `upTo` is the `seq` the answer covers:
   * the last event's when `more`, else the newest recorded when it was read,
   * so a caller that stores it skips nothing and repeats nothing.
   */
  readonly since: (input: {
    readonly after: number;
    readonly limit: number;
    readonly names?: ReadonlyArray<AssistantEventName>;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }) => Effect.Effect<
    {
      readonly events: ReadonlyArray<AssistantEvent>;
      readonly upTo: number;
      readonly more: boolean;
    },
    AssistantEventRepositoryError
  >;
  /** Emits after events are recorded. */
  readonly changes: Stream.Stream<void>;
  /** Keeps the record until the scope closes. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AssistantEvents extends Context.Service<AssistantEvents, AssistantEventsShape>()(
  "threadlines/assistants/AssistantEvents",
) {}
