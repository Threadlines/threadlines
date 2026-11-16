import {
  CommandId,
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveId,
  ThreadMoveRequestId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextThreadMoveState,
  type ThreadMoveEvent,
  type ThreadMoveState,
} from "./threadMoveProjection.ts";

const threadId = ThreadId.make("thread-1");
const requestId = ThreadMoveRequestId.make("request-1");
const transferId = ThreadMoveId.make("move-1");
const target = { environmentId: EnvironmentId.make("environment-mac"), label: "Mac mini" };
const at = "2026-11-16T09:00:00.000Z";

let sequence = 0;
function event<T extends ThreadMoveEvent["type"]>(
  type: T,
  payload: Extract<ThreadMoveEvent, { type: T }>["payload"],
): ThreadMoveEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as ThreadMoveEvent;
}

const EMPTY: ThreadMoveState = { move: null, pendingMove: null, lastMoveOutcome: null };

const queued = nextThreadMoveState(
  EMPTY,
  event("thread.move-queued", {
    threadId,
    pendingMove: {
      requestId,
      target,
      mode: "when-done",
      stage: "waiting",
      requestedAt: at,
      requestedBy: { kind: "user" },
    },
  }),
);

const started = nextThreadMoveState(
  { ...queued, pendingMove: null },
  event("thread.move-started", {
    threadId,
    transferId,
    target,
    agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    startedAt: at,
    queuedRequestId: requestId,
  }),
);

describe("nextThreadMoveState", () => {
  it("says why a move didn't happen as a code beside its words", () => {
    const cancelled = nextThreadMoveState(
      queued,
      event("thread.move-queue-ended", { threadId, requestId, reason: "cancelled", endedAt: at }),
    );
    expect(cancelled.pendingMove).toBeNull();
    expect(cancelled.lastMoveOutcome).toMatchObject({
      result: "not_moved",
      reason: "cancelled",
      words: "You cancelled the move.",
    });

    const denied = nextThreadMoveState(
      started,
      event("thread.move-aborted", {
        threadId,
        transferId,
        reason: "Mac mini didn't allow the move.",
        code: "denied",
        updatedAt: at,
      }),
    );
    expect(denied.move).toBeNull();
    expect(denied.lastMoveOutcome).toMatchObject({ result: "not_moved", reason: "denied" });

    // Recorded before the codes: the words alone.
    const older = nextThreadMoveState(
      started,
      event("thread.move-aborted", { threadId, transferId, reason: "Dropped.", updatedAt: at }),
    );
    expect(older.lastMoveOutcome?.reason).toBeUndefined();
    expect(older.lastMoveOutcome?.words).toBe("Dropped.");
  });
});
