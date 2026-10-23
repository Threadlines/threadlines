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
  type RemoteChildThread,
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

const MAC_MINI = EnvironmentId.make("environment-mac-mini");

/** No remote children, and computers named as last known. */
const local = {
  remoteChildren: [] as RemoteChildThread[],
  computerLabel: (_environmentId: EnvironmentId, lastKnown: string) => lastKnown,
};

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
      remoteThreadIds: new Set(),
    });
    expect(parseThreadStartResult(JSON.stringify(answer))).toEqual({
      outcome: "asked_user",
      threadIds: new Set(["thread-a"]),
      remoteThreadIds: new Set(),
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
        ...local,
      }),
    ).toEqual({
      heading: "Tried to start threads",
      outcome: "over the limit for one message",
      threads: [],
      remoteThreads: [],
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
      ...local,
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
      ...local,
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
        ...local,
      }),
    ).toEqual({
      heading: "Asked to start threads",
      outcome: "not started",
      threads: [],
      remoteThreads: [],
    });
  });

  it("follows a thread asked of a linked computer until it starts there", () => {
    const asked = call(
      "start-1",
      '{"outcome":"asked_user","threads":[{"threadId":"thread-remote","title":"Read the log","workspace":"remote","computer":"Mac mini"}]}',
    );
    const remoteStart = (status: "awaiting_approval" | "accepted"): OrchestrationChildRequest => ({
      ...waitingRequest("thread-remote", "batch-1"),
      status: "starting",
      remote: { environmentId: MAC_MINI, label: "Mac mini", threadId: null, status },
    });
    const input = {
      call: asked,
      turnCalls: [asked],
      startedInTurn: [],
      ...local,
      // This app knows the computer by the name its user saved it under.
      computerLabel: () => "Studio Mac",
    };
    expect(
      describeThreadStartCall({ ...input, openRequests: [remoteStart("awaiting_approval")] }),
    ).toMatchObject({
      heading: "Asked to start 1 thread",
      outcome: "waiting for Studio Mac to allow it",
    });
    const started: RemoteChildThread = {
      environmentId: MAC_MINI,
      label: "Mac mini",
      threadId: ThreadId.make("thread-remote"),
      handle: "Codex",
      title: "Read the log",
      attachmentEpoch: 0,
      cachedStatus: "working",
      updatedAt: "2026-10-04T10:01:00.000Z",
    };
    // Running there, and after its answer settled the request.
    for (const openRequests of [[remoteStart("accepted")], []]) {
      expect(
        describeThreadStartCall({ ...input, openRequests, remoteChildren: [started] }),
      ).toMatchObject({
        heading: "Started 1 thread",
        outcome: "you said start",
        remoteThreads: [{ threadId: "thread-remote" }],
      });
    }
    // A later call that kept no result leaves the turn one record, which
    // still finds the thread the first call named.
    const unnamed = call("start-2");
    expect(
      describeThreadStartCall({
        ...input,
        call: unnamed,
        turnCalls: [asked, unnamed],
        openRequests: [],
        remoteChildren: [started],
      }),
    ).toMatchObject({
      heading: "Started 1 thread",
      remoteThreads: [{ threadId: "thread-remote" }],
    });
  });

  it("never says started for a start a linked computer has not taken", () => {
    // Started here without asking; the title holds braces.
    const auto = call(
      "start-1",
      '{"outcome":"started","threads":[{"threadId":"thread-remote","title":"Fix {id} route","workspace":"remote","computer":"Mac mini"}]}',
    );
    const input = { call: auto, turnCalls: [auto], startedInTurn: [], ...local };
    expect(
      describeThreadStartCall({
        ...input,
        openRequests: [
          {
            ...waitingRequest("thread-remote", "batch-1"),
            status: "starting",
            remote: {
              environmentId: MAC_MINI,
              label: "Mac mini",
              threadId: null,
              status: "awaiting_approval",
            },
          },
        ],
      }),
    ).toMatchObject({
      heading: "Asked to start 1 thread",
      outcome: "waiting for Mac mini to allow it",
    });
    // Its user said no: the request is gone and no thread came of it.
    expect(describeThreadStartCall({ ...input, openRequests: [] })).toMatchObject({
      heading: "Tried to start threads",
      outcome: "not started",
    });
  });
});
