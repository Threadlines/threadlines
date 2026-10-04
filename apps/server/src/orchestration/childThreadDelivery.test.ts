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

import { childDeliveryForTurnEnd } from "./childThreadDelivery.ts";

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
      parent,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-b"), outcome: "completed" },
      pendingMessageId: later.childMessageId,
      awaitedBackgroundTaskCount: 0,
    });
    expect(delivery?.requestId).toBe(later.requestId);
  });

  it("lets only a turn no message started continue a request waiting on background work", () => {
    const continuation = childDeliveryForTurnEnd({
      parent,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-continued"), outcome: "completed" },
      pendingMessageId: null,
      awaitedBackgroundTaskCount: 0,
    });
    expect(continuation?.requestId).toBe(waiting.requestId);

    const userTurn = childDeliveryForTurnEnd({
      parent,
      child: thread(CHILD),
      end: { turnId: TurnId.make("turn-user"), outcome: "completed" },
      pendingMessageId: MessageId.make("user-message"),
      awaitedBackgroundTaskCount: 0,
    });
    expect(userTurn).toBeNull();
  });
});
