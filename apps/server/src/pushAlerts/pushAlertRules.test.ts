import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  alertPayload,
  FAILED_HOLD_MS,
  FINISHED_HOLD_MS,
  MAX_ALERT_PLAINTEXT_BYTES,
  pushAlertActionsForEvent,
} from "./pushAlertRules.ts";

const THREAD = ThreadId.make("thread-1");
let sequence = 0;

function event(type: OrchestrationEvent["type"], payload: object): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: THREAD,
    occurredAt: "2026-10-23T12:00:00.000Z",
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

const activity = (kind: string, payload: object, turnId: string | null = "turn-1") =>
  event("thread.activity-appended", {
    threadId: THREAD,
    activity: {
      id: `activity-${sequence + 1}`,
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId,
      createdAt: "2026-10-23T12:00:00.000Z",
    },
  });

describe("pushAlertActionsForEvent", () => {
  it("alerts at once for each approval and question, and drops one once it is answered", () => {
    expect(pushAlertActionsForEvent(activity("approval.requested", { requestId: "r1" }))).toEqual([
      {
        type: "add",
        intent: {
          alertId: "approval:r1",
          threadId: THREAD,
          kind: "needs_you",
          reason: "approval",
          subjectId: "r1",
          detail: null,
          holdMs: 0,
          occurredAt: "2026-10-23T12:00:00.000Z",
        },
      },
    ]);
    // A second request while the first still waits is its own alert.
    expect(
      pushAlertActionsForEvent(activity("user-input.requested", { requestId: "r2" }))[0],
    ).toMatchObject({ type: "add", intent: { alertId: "question:r2", reason: "question" } });

    expect(pushAlertActionsForEvent(activity("approval.resolved", { requestId: "r1" }))).toEqual([
      { type: "cancel", alertId: "approval:r1" },
    ]);
    expect(
      pushAlertActionsForEvent(
        activity("provider.user-input.respond.failed", {
          requestId: "r2",
          detail: "Unknown pending user-input request",
        }),
      ),
    ).toEqual([{ type: "cancel", alertId: "question:r2" }]);
    // A failed answer the agent can still take leaves the request (and its alert) open.
    expect(
      pushAlertActionsForEvent(
        activity("provider.approval.respond.failed", { requestId: "r1", detail: "timeout" }),
      ),
    ).toEqual([]);
  });

  it("holds a finished turn, sends a failed one sooner, and never alerts a turn the user stopped", () => {
    const completed = (turnId: string, state: string) =>
      pushAlertActionsForEvent(
        event("thread.turn-completed", {
          threadId: THREAD,
          turnId,
          state,
          completedAt: "2026-10-23T12:00:00.000Z",
        }),
      );
    expect(completed("turn-1", "completed")).toMatchObject([
      {
        type: "add",
        intent: { alertId: "turn:turn-1", kind: "finished", holdMs: FINISHED_HOLD_MS },
      },
    ]);
    expect(completed("turn-2", "error")).toMatchObject([
      { type: "add", intent: { alertId: "turn:turn-2", kind: "failed", reason: "error" } },
    ]);
    expect(completed("turn-3", "interrupted")).toEqual([]);
    expect(
      pushAlertActionsForEvent(
        event("thread.turn-interrupt-requested", {
          threadId: THREAD,
          turnId: "turn-4",
          createdAt: "2026-10-23T12:00:00.000Z",
        }),
      ),
    ).toEqual([{ type: "suppress", alertId: "turn:turn-4", threadId: THREAD }]);
  });

  it("reports a turn cut off by a restart, a start that failed, and a side answer that failed", () => {
    expect(
      pushAlertActionsForEvent(activity("provider.session.restart-interrupted", {}, "turn-9")),
    ).toMatchObject([
      {
        type: "add",
        intent: {
          alertId: "turn:turn-9",
          kind: "failed",
          reason: "restart",
          holdMs: FAILED_HOLD_MS,
        },
      },
    ]);
    expect(
      pushAlertActionsForEvent(
        activity("provider.turn.start.failed", { detail: "Codex isn't signed in." }, null),
      ),
    ).toMatchObject([
      {
        type: "add",
        intent: { kind: "failed", reason: "start-failed", detail: "Codex isn't signed in." },
      },
    ]);
    expect(
      pushAlertActionsForEvent(
        event("thread.side-turn-settled", {
          threadId: THREAD,
          sideTurnId: "side-1",
          participantId: null,
          messageId: "message-1",
          outcome: "failed",
          error: "The agent's session ended.",
          settledAt: "2026-10-23T12:00:00.000Z",
        }),
      ),
    ).toMatchObject([
      { type: "add", intent: { alertId: "side:side-1", kind: "failed", reason: "side-failed" } },
    ]);
  });

  it("lets a parent take its child's result, and quiets a thread the user opened, wrapped or moved", () => {
    const CHILD = ThreadId.make("thread-child");
    expect(
      pushAlertActionsForEvent(
        event("thread.child-request-settled", {
          threadId: THREAD,
          requestId: "child-request-1",
          childThreadId: CHILD,
          outcome: "answered",
          settledAt: "2026-10-23T12:00:00.000Z",
        }),
      ),
    ).toEqual([{ type: "cancel-thread", threadId: CHILD, kinds: ["finished", "failed"] }]);
    expect(
      pushAlertActionsForEvent(
        event("thread.seen-set", { threadId: THREAD, at: "2026-10-23T12:00:00.000Z" }),
      ),
    ).toEqual([{ type: "cancel-thread", threadId: THREAD, kinds: ["finished", "failed"] }]);
    expect(
      pushAlertActionsForEvent(
        event("thread.done-override-set", {
          threadId: THREAD,
          state: "active",
          at: "2026-10-23T12:00:00.000Z",
        }),
      ),
    ).toEqual([]);
    expect(pushAlertActionsForEvent(event("thread.moved-away", { threadId: THREAD }))).toEqual([
      { type: "cancel-thread", threadId: THREAD, kinds: ["needs_you", "finished", "failed"] },
    ]);
  });
});

describe("alertPayload", () => {
  it("fits one push message however long the thread title and error are", () => {
    const text = alertPayload({
      threadTitle: "🙂".repeat(2_000),
      reason: "error",
      detail: "x".repeat(10_000),
      computerLabel: "Studio Mac",
      navigate: "https://nightly.app.threadlines.dev/env-1/thread-1",
    });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_ALERT_PLAINTEXT_BYTES);
    const parsed = JSON.parse(text);
    expect(parsed.web_push).toBe(8030);
    expect(parsed.notification.navigate).toBe("https://nightly.app.threadlines.dev/env-1/thread-1");
    expect(parsed.notification.body).toBe(
      `Stopped with an error: ${"x".repeat(139)}… · Studio Mac`,
    );
  });
});
