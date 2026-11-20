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

import { childDeliveryForTurnEnd, lateReplyOf } from "./childThreadDelivery.ts";

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

  it("lets only a turn no message started continue a request waiting on background work", () => {
    const continuation = childDeliveryForTurnEnd({
      owned: parent.childRequests.open,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-continued"), outcome: "completed" },
      pendingMessageId: null,
      awaitedBackgroundTaskCount: 0,
    });
    expect(continuation?.requestId).toBe(waiting.requestId);

    const userTurn = childDeliveryForTurnEnd({
      owned: parent.childRequests.open,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-user"), outcome: "completed" },
      pendingMessageId: MessageId.make("user-message"),
      awaitedBackgroundTaskCount: 0,
    });
    expect(userTurn).toBeNull();
  });
});

describe("lateReplyOf", () => {
  const handedBack = TurnId.make("turn-answer");
  const later = TurnId.make("turn-check-back");
  const child = (overrides: Partial<OrchestrationThread> = {}) =>
    thread(CHILD, {
      handedBackTurnId: handedBack,
      handedBackAt: "2026-10-04T10:05:00.000Z",
      latestTurn: {
        turnId: later,
        state: "completed",
        requestedAt: "2026-10-04T10:10:00.000Z",
        startedAt: "2026-10-04T10:10:00.000Z",
        completedAt: "2026-10-04T10:12:00.000Z",
        assistantMessageId: MessageId.make("late-answer"),
      },
      messages: [
        {
          id: MessageId.make("late-answer"),
          role: "assistant",
          text: "The reviewer found three bugs; all fixed in cf7b10d.",
          turnId: later,
          streaming: false,
          createdAt: "2026-10-04T10:12:00.000Z",
          updatedAt: "2026-10-04T10:12:00.000Z",
        },
      ],
      ...overrides,
    });
  const parent = thread(PARENT);

  it("tells the parent of a finished turn nobody asked for after the child's answer went back", () => {
    expect(lateReplyOf(parent, child())).toEqual({
      childThreadId: CHILD,
      turnId: later,
      title: "Write the changelog",
      text: "The reviewer found three bugs; all fixed in cf7b10d.",
    });
    // Its answer is the newest turn: nothing more to tell.
    expect(lateReplyOf(parent, child({ handedBackTurnId: later }))).toBeNull();
  });

  it("leaves work the user asked for, or a request still owes, to those", () => {
    const automatic = {
      id: MessageId.make("user-message"),
      role: "user" as const,
      text: "Also rename the button.",
      turnId: later,
      streaming: false,
      createdAt: "2026-10-04T10:10:00.000Z",
      updatedAt: "2026-10-04T10:10:00.000Z",
    };
    const told = child();
    const typed = { ...automatic, composer: "typed" as const };
    expect(lateReplyOf(parent, { ...told, messages: [typed, ...told.messages] })).toBeNull();
    // A reviewer's reply, or an automatic fix the server wrote, is not the user's.
    const reviewerReply = { ...automatic, fromAgent: { participantId: null } };
    expect(
      lateReplyOf(parent, { ...told, messages: [reviewerReply, ...told.messages] }),
    ).not.toBeNull();
    expect(
      lateReplyOf(parent, { ...told, messages: [automatic, ...told.messages] }),
    ).not.toBeNull();
    const asking = thread(PARENT, {
      childRequests: { ...EMPTY_CHILD_REQUEST_STATE, open: [request("a", {})] },
    });
    expect(lateReplyOf(asking, told)).toBeNull();
    expect(lateReplyOf(parent, child({ attachedToParent: false }))).toBeNull();
  });
});
