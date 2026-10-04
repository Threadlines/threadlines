import {
  ChildRequestBatchId,
  ChildRequestId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationChildRequest,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeThreadStartCall,
  parseThreadStartResult,
  type ThreadStartCall,
} from "./childThreads";
import type { SidebarThreadSummary } from "./types";

const TURN = TurnId.make("turn-parent");

const child = (id: string): SidebarThreadSummary => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make("environment-local"),
  projectId: ProjectId.make("project-1"),
  title: id,
  interactionMode: "default",
  session: null,
  createdAt: "2026-10-04T10:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  doneOverride: null,
  lastSeenAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  effectiveCwd: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  cumulativeDiffStat: null,
  parentThreadId: ThreadId.make("thread-parent"),
  parentTurnId: TURN,
  attachedToParent: true,
});

const waitingRequest = (childThreadId: string, batch: string): OrchestrationChildRequest => ({
  requestId: ChildRequestId.make(`request-${childThreadId}`),
  batchId: ChildRequestBatchId.make(batch),
  kind: "start",
  from: { participantId: null },
  callerTurnId: TURN,
  deliveryEpoch: 0,
  status: "awaiting_user",
  childThreadId: ThreadId.make(childThreadId),
  childMessageId: MessageId.make(`message-${childThreadId}`),
  launch: {
    title: childThreadId,
    prompt: "Do it.",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    reportBack: true,
    runSetup: true,
    workspace: { kind: "project_folder" },
  },
  createdAt: "2026-10-04T10:00:00.000Z",
});

const call = (id: string, output?: string): ThreadStartCall => ({
  id,
  turnId: TURN,
  result: parseThreadStartResult(output),
});

describe("thread_start records in the parent's chat", () => {
  it("reads a result passed as JSON, or as JSON inside a string", () => {
    const answer = '{"outcome":"asked_user","threads":[{"threadId":"thread-a","title":"A"}]}';
    expect(parseThreadStartResult(answer)).toEqual({
      outcome: "asked_user",
      threadIds: new Set(["thread-a"]),
    });
    expect(parseThreadStartResult(JSON.stringify(answer))).toEqual({
      outcome: "asked_user",
      threadIds: new Set(["thread-a"]),
    });
  });

  it("never says started for a refused call", () => {
    const refused = call("start-1", '{"outcome":"limit","detail":"Too many."}');
    expect(
      describeThreadStartCall({
        call: refused,
        turnCalls: [refused],
        startedInTurn: [child("thread-earlier")],
        openRequests: [],
      }),
    ).toEqual({
      heading: "Tried to start threads",
      outcome: "over the limit for one message",
      threads: [],
    });
  });

  it("gives each call its own threads and its own waiting batch", () => {
    const first = call(
      "start-1",
      '{"outcome":"asked_user","threads":[{"threadId":"thread-a","title":"A"}]}',
    );
    const second = call(
      "start-2",
      '{"outcome":"asked_user","threads":[{"threadId":"thread-b"},{"threadId":"thread-c"}]}',
    );
    const input = {
      turnCalls: [first, second],
      startedInTurn: [child("thread-a")],
      openRequests: [waitingRequest("thread-b", "batch-2"), waitingRequest("thread-c", "batch-2")],
    };
    // The first batch was approved; the second still waits.
    expect(describeThreadStartCall({ ...input, call: first })).toMatchObject({
      heading: "Started 1 thread",
      outcome: "you said start",
      threads: [{ id: "thread-a" }],
    });
    expect(describeThreadStartCall({ ...input, call: second })).toMatchObject({
      heading: "Asked to start 2 threads",
      outcome: "waiting for you",
      threads: [],
    });
  });

  it("speaks for the whole turn once, when a call's result named no threads", () => {
    const first = call("start-1");
    const second = call("start-2");
    const input = {
      turnCalls: [first, second],
      startedInTurn: [child("thread-a")],
      openRequests: [waitingRequest("thread-b", "batch-2"), waitingRequest("thread-c", "batch-2")],
    };
    expect(describeThreadStartCall({ ...input, call: first })).toBeNull();
    expect(describeThreadStartCall({ ...input, call: second })).toMatchObject({
      heading: "Started 1 thread",
      outcome: "2 more waiting for you",
      threads: [{ id: "thread-a" }],
    });
  });

  it("says a declined batch was not started", () => {
    const asked = call("start-1", '{"outcome":"asked_user","threads":[{"threadId":"thread-a"}]}');
    expect(
      describeThreadStartCall({
        call: asked,
        turnCalls: [asked],
        startedInTurn: [],
        openRequests: [],
      }),
    ).toEqual({ heading: "Asked to start threads", outcome: "not started", threads: [] });
  });
});
