import {
  ChildRequestBatchId,
  ChildRequestId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  MessageId,
  type OrchestrationChildRequest,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  childDeliveryForEndedTurn,
  childDeliveryForTurnEnd,
  childReportForTurnEnd,
} from "./childThreadDelivery.ts";

const now = "2026-10-04T10:00:00.000Z";
const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");

const thread = (
  id: ThreadId,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId: ProjectId.make("project-1"),
  title: "Write the changelog",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-5-5" },
  runtimeMode: "auto-accept-edits",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  effectiveCwd: null,
  goal: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  pinnedAt: null,
  pullRequestAutoFix: false,
  pullRequestAutoMerge: null,
  linkedPullRequests: [],
  agentRequests: EMPTY_AGENT_REQUEST_STATE,
  parentThreadId: id === CHILD ? PARENT : null,
  parentTurnId: null,
  attachedToParent: id === CHILD,
  parentAttachmentEpoch: 0,
  handedBackAt: null,
  handedBackTurnId: null,
  archivedWithParentAt: null,
  childRequests: EMPTY_CHILD_REQUEST_STATE,
  participants: [],
  doneOverride: null,
  lastSeenAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  diffStatBaselineTurnCount: 0,
  session: null,
  ...overrides,
});

const request = (
  id: string,
  overrides: Partial<OrchestrationChildRequest>,
): OrchestrationChildRequest => ({
  requestId: ChildRequestId.make(id),
  batchId: ChildRequestBatchId.make(id),
  kind: "send",
  from: { participantId: null },
  callerTurnId: TurnId.make("parent-turn"),
  deliveryEpoch: 0,
  status: "running",
  childThreadId: CHILD,
  childMessageId: MessageId.make(`${id}-message`),
  createdAt: now,
  ...overrides,
});

describe("childDeliveryForTurnEnd", () => {
  const waiting = request("a", {
    status: "awaiting_background",
    candidateTurnId: TurnId.make("turn-a"),
  });
  const later = request("b", { status: "running" });
  const parent = thread(PARENT, {
    childRequests: { ...EMPTY_CHILD_REQUEST_STATE, open: [waiting, later] },
  });

  it("gives a turn's answer to the request its message started, not an older one waiting on background work", () => {
    const delivery = childDeliveryForTurnEnd({
      owned: parent.childRequests.open,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-b"), outcome: "completed" },
      pendingMessageId: later.childMessageId,
      awaitedBackgroundTaskCount: 0,
    });
    expect(delivery?.requestId).toBe(later.requestId);
  });

  it("never takes a later turn for background work coming back, except in a linked computer's ledger", () => {
    const input = {
      owned: parent.childRequests.open,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-continued"), outcome: "completed" as const },
      pendingMessageId: null,
      awaitedBackgroundTaskCount: 0,
    };
    // Here the turn's start already settled the waiting request (rule 4).
    expect(childDeliveryForTurnEnd(input)).toBeNull();
    expect(childDeliveryForTurnEnd({ ...input, continuesWaitingAnswer: true })?.requestId).toBe(
      waiting.requestId,
    );

    const userTurn = childDeliveryForTurnEnd({
      ...input,
      end: { turnId: TurnId.make("turn-user"), outcome: "completed" },
      pendingMessageId: MessageId.make("user-message"),
    });
    expect(userTurn).toBeNull();
  });

  it("says the user stopped a request's turn only when a Stop named it", () => {
    const turnId = TurnId.make("turn-b");
    const end = { turnId, outcome: "interrupted" as const, error: "runtime stream ended" };
    const cutOff = childDeliveryForTurnEnd({
      owned: [later],
      child: thread(CHILD, { session: session() }),
      end,
      pendingMessageId: later.childMessageId,
      awaitedBackgroundTaskCount: 0,
    });
    expect(cutOff).toMatchObject({
      outcome: "failed",
      reply: {
        text: "'Write the changelog' stopped before it finished: runtime stream ended. Send it a message with thread_send to continue.",
      },
    });
    const stopped = childDeliveryForTurnEnd({
      owned: [later],
      child: thread(CHILD, { session: session({ stopRequestedTurnId: turnId }) }),
      end,
      pendingMessageId: later.childMessageId,
      awaitedBackgroundTaskCount: 0,
    });
    expect(stopped).toMatchObject({
      outcome: "stopped",
      reply: { text: "The user stopped 'Write the changelog' before it finished." },
    });
  });
});

const session = (
  overrides: Partial<NonNullable<OrchestrationThread["session"]>> = {},
): NonNullable<OrchestrationThread["session"]> => ({
  threadId: CHILD,
  status: "ready",
  providerName: "claudeAgent",
  runtimeMode: "auto-accept-edits",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
  ...overrides,
});

describe("childReportForTurnEnd", () => {
  const turnId = TurnId.make("turn-check-back");
  const owing = (overrides: Partial<OrchestrationThread> = {}) =>
    thread(CHILD, {
      childRequests: {
        ...EMPTY_CHILD_REQUEST_STATE,
        owedReports: [{ turnId, deliveryEpoch: 0, attachmentEpoch: 0, createdAt: now }],
      },
      messages: [
        {
          id: MessageId.make("late-answer"),
          role: "assistant",
          text: "The reviewer found three bugs; all fixed in cf7b10d.",
          turnId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      ...overrides,
    });
  const report = (
    child: OrchestrationThread,
    end: Parameters<typeof childReportForTurnEnd>[0]["end"],
  ) => childReportForTurnEnd({ child, end, pendingMessageId: null });

  it("reports a completed turn's reply, and nothing for a turn that owed nothing", () => {
    expect(report(owing(), { turnId, outcome: "completed" })).toMatchObject({
      type: "thread.child-report.settle",
      owed: { turnId },
      turnId,
      text: "The reviewer found three bugs; all fixed in cf7b10d.",
    });
    expect(report(thread(CHILD), { turnId, outcome: "completed" })).toBeNull();
    // A reply-less turn settles with nothing to say, so it is dropped.
    expect(report(owing({ messages: [] }), { turnId, outcome: "completed" })?.text).toBeUndefined();
  });

  it("delivers a failure, says whether it goes on by itself, and counts the reports waiting in it", () => {
    expect(report(owing(), { turnId, outcome: "failed", error: "Overloaded." })?.text).toBe(
      "'Write the changelog' failed: Overloaded. Send it a message with thread_send to continue.",
    );
    const waitingForReset = owing({
      session: session({ status: "error", continueAtReset: { resetsAt: now, at: now } }),
    });
    expect(report(waitingForReset, { turnId, outcome: "failed", error: "Usage limit" })?.text).toBe(
      "'Write the changelog' failed: Usage limit. It continues by itself when the limit resets.",
    );
    const queuedReport = (id: string) => ({
      messageId: MessageId.make(id),
      text: "done",
      attachments: [],
      fromThread: {
        threadId: ThreadId.make(id),
        requestId: ChildRequestId.make(id),
        kind: "report" as const,
      },
      runtimeMode: "auto-accept-edits" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    });
    const withReports = owing({ queuedFollowUps: [queuedReport("g1"), queuedReport("g2")] });
    expect(report(withReports, { turnId, outcome: "failed", error: "Overloaded" })?.text).toBe(
      "'Write the changelog' failed: Overloaded. 2 reports from its threads are waiting in it unread. Send it a message with thread_send and it reads them first.",
    );
  });

  it("drops a turn a Stop named, and tells of one cut off without a Stop", () => {
    const end = { turnId, outcome: "interrupted" as const, error: "runtime stream ended" };
    expect(
      report(owing({ session: session({ stopRequestedTurnId: turnId }) }), end)?.text,
    ).toBeUndefined();
    expect(report(owing({ session: session() }), end)?.text).toBe(
      "'Write the changelog' stopped before it finished: runtime stream ended. Send it a message with thread_send to continue.",
    );
  });

  it("settles a request's turn as the request, never also as a report", () => {
    const requested = request("c", { status: "running" });
    const child = thread(CHILD, {
      childRequests: {
        ...EMPTY_CHILD_REQUEST_STATE,
        owedReports: [
          {
            messageId: MessageId.make("other"),
            deliveryEpoch: 0,
            attachmentEpoch: 0,
            createdAt: now,
          },
        ],
      },
    });
    const delivery = childDeliveryForEndedTurn({
      owned: [requested],
      child,
      end: { turnId: TurnId.make("turn-c"), outcome: "completed" },
      pendingMessageId: requested.childMessageId,
      awaitedBackgroundTaskCount: 0,
    });
    expect(delivery?.type).toBe("thread.child-request.settle");
  });
});
