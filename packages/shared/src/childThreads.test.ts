import {
  ChildRequestBatchId,
  ChildRequestId,
  EMPTY_CHILD_REQUEST_STATE,
  EnvironmentId,
  MessageId,
  type OrchestrationChildRequest,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachedDescendantsOf,
  childAttachRefusal,
  childRequestStateOn,
  childSendRefusal,
  childStartRefusal,
  isHandedBackCompletion,
  isStillGoing,
  remoteChildrenOf,
  remoteChildStartsOf,
  stopReachOf,
  type StillGoingInput,
} from "./childThreads.ts";

const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");
const TURN = TurnId.make("turn-1");
const PRIMARY = { participantId: null };

const caller = (overrides: Partial<Parameters<typeof childStartRefusal>[0]> = {}) => ({
  id: PARENT,
  parentThreadId: null,
  attachedToParent: false,
  session: { participantId: null, activeTurnId: TURN },
  agentRequests: { hold: false },
  childRequests: EMPTY_CHILD_REQUEST_STATE,
  ...overrides,
});

const request = (
  overrides: Partial<OrchestrationChildRequest> = {},
): OrchestrationChildRequest => ({
  requestId: ChildRequestId.make("request-1"),
  batchId: ChildRequestBatchId.make("batch-1"),
  kind: "start",
  from: PRIMARY,
  callerTurnId: TURN,
  deliveryEpoch: 0,
  status: "running",
  childThreadId: CHILD,
  childMessageId: MessageId.make("message-1"),
  createdAt: "2026-10-04T10:00:00.000Z",
  ...overrides,
});

describe("childStartRefusal", () => {
  it("keeps families one level deep", () => {
    const refusal = childStartRefusal(caller({ parentThreadId: CHILD, attachedToParent: true }), {
      from: PRIMARY,
      callerTurnId: TURN,
      count: 1,
    });
    expect(refusal?.outcome).toBe("not_allowed");
  });

  it("lets a separated child start threads of its own", () => {
    const refusal = childStartRefusal(caller({ parentThreadId: CHILD, attachedToParent: false }), {
      from: PRIMARY,
      callerTurnId: TURN,
      count: 2,
    });
    expect(refusal).toBeNull();
  });

  it("lets an agent keep starting and messaging threads without the user writing", () => {
    // Counts a thread kept from before the per-message limits were removed.
    let state = { ...EMPTY_CHILD_REQUEST_STATE, startsSinceUser: 40, sendsSinceUser: 40 };
    for (let index = 0; index < 40; index++) {
      state = childRequestStateOn.submitted(
        state,
        request({ status: "awaiting_user", requestId: ChildRequestId.make(`r${index}`) }),
      );
    }
    const busy = caller({ childRequests: state });
    expect(childStartRefusal(busy, { from: PRIMARY, callerTurnId: TURN, count: 5 })).toBeNull();
    expect(
      childSendRefusal(
        busy,
        { id: CHILD, parentThreadId: PARENT, attachedToParent: true, archivedAt: null },
        { from: PRIMARY, callerTurnId: TURN },
      ),
    ).toBeNull();
  });

  it("refuses outside the caller's own turn and after Stop", () => {
    expect(
      childStartRefusal(caller(), { from: PRIMARY, callerTurnId: TurnId.make("old"), count: 1 })
        ?.outcome,
    ).toBe("refused");
    expect(
      childStartRefusal(caller({ agentRequests: { hold: true } }), {
        from: PRIMARY,
        callerTurnId: TURN,
        count: 1,
      })?.outcome,
    ).toBe("refused");
  });
});

describe("childSendRefusal", () => {
  const child = { id: CHILD, parentThreadId: PARENT, attachedToParent: true, archivedAt: null };

  it("only reaches the caller's own attached children", () => {
    expect(childSendRefusal(caller(), child, { from: PRIMARY, callerTurnId: TURN })).toBeNull();
    expect(
      childSendRefusal(
        caller(),
        { ...child, parentThreadId: ThreadId.make("someone-else") },
        { from: PRIMARY, callerTurnId: TURN },
      )?.outcome,
    ).toBe("not_allowed");
    expect(
      childSendRefusal(
        caller(),
        { ...child, attachedToParent: false },
        { from: PRIMARY, callerTurnId: TURN },
      )?.outcome,
    ).toBe("not_allowed");
  });
});

describe("childAttachRefusal", () => {
  const parent = {
    parentThreadId: null,
    attachedToParent: false,
    archivedAt: null,
    deletedAt: null,
  };
  const thread = { parentThreadId: PARENT, childRequests: EMPTY_CHILD_REQUEST_STATE };

  it("refuses a put-back that would make the family two levels deep", () => {
    expect(childAttachRefusal(thread, parent, false)).toBeNull();
    expect(childAttachRefusal(thread, parent, true)).not.toBeNull();
    expect(
      childAttachRefusal(
        {
          ...thread,
          childRequests: childRequestStateOn.submitted(EMPTY_CHILD_REQUEST_STATE, request()),
        },
        parent,
        false,
      ),
    ).not.toBeNull();
    expect(
      childAttachRefusal(
        thread,
        { ...parent, parentThreadId: CHILD, attachedToParent: true },
        false,
      ),
    ).not.toBeNull();
  });
});

describe("childRequestStateOn", () => {
  it("adds a settled request's note once and drops it when delivered", () => {
    const note = {
      requestId: ChildRequestId.make("request-1"),
      recipient: PRIMARY,
      text: "The user made it its own thread.",
      createdAt: "2026-10-04T10:05:00.000Z",
    };
    const open = childRequestStateOn.submitted(EMPTY_CHILD_REQUEST_STATE, request());
    const settled = childRequestStateOn.settled(open, note.requestId, note);
    expect(settled.open).toEqual([]);
    expect(settled.pendingNotes).toEqual([note]);
    expect(childRequestStateOn.settled(settled, note.requestId, note)).toBe(settled);
    expect(childRequestStateOn.notesDelivered(settled, [note.requestId]).pendingNotes).toEqual([]);
  });

  it("keeps open requests when the user writes", () => {
    const open = childRequestStateOn.submitted(EMPTY_CHILD_REQUEST_STATE, request());
    expect(childRequestStateOn.reset(open)).toBe(open);
  });
});

describe("remoteChildStartsOf", () => {
  const windows = EnvironmentId.make("env-windows");
  const remoteStart = (threadId: ThreadId | null, status: "sending" | "awaiting_approval") =>
    request({
      status: "starting",
      launch: {
        title: "Fix the flaky test",
        prompt: "Fix it.",
        modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
        runtimeMode: "auto",
        interactionMode: "default",
        reportBack: true,
        runSetup: false,
        workspace: { kind: "local" } as never,
      },
      remote: { environmentId: windows, label: "Windows PC", threadId, status },
    });

  it("keeps a start in the family until its child is recorded, a reserved thread id or not", () => {
    const waiting = childRequestStateOn.submitted(
      EMPTY_CHILD_REQUEST_STATE,
      remoteStart(ThreadId.make("reserved"), "awaiting_approval"),
    );
    expect(remoteChildStartsOf(waiting)).toEqual([
      expect.objectContaining({ title: "Fix the flaky test", status: "awaiting_approval" }),
    ]);
    const started = childRequestStateOn.remoteChildUpdated(waiting, {
      environmentId: windows,
      label: "Windows PC",
      threadId: ThreadId.make("reserved"),
      handle: "Codex",
      title: "Fix the flaky test",
      attachmentEpoch: 0,
      cachedStatus: "working",
      updatedAt: "2026-10-04T10:01:00.000Z",
    });
    expect(remoteChildStartsOf(started)).toEqual([]);
    // Followed while its request is open; once its answer settles it, no
    // word of it comes any more, and its family can wrap it up.
    expect(remoteChildrenOf(started).map((child) => child.followed)).toEqual([true]);
    const answered = childRequestStateOn.settled(
      started,
      ChildRequestId.make("request-1"),
      undefined,
    );
    expect(remoteChildrenOf(answered).map((child) => child.followed)).toEqual([false]);
  });
});

describe("isHandedBackCompletion", () => {
  it("passes only the exact turn whose answer went back", () => {
    expect(
      isHandedBackCompletion({
        handedBackTurnId: TURN,
        latestTurn: { turnId: TURN, state: "completed" },
      }),
    ).toBe(true);
    expect(
      isHandedBackCompletion({
        handedBackTurnId: TURN,
        latestTurn: { turnId: TurnId.make("later"), state: "completed" },
      }),
    ).toBe(false);
  });
});

describe("family walks", () => {
  const member = (
    id: string,
    parent: string | null,
    createdAt: string,
    extra: { attached?: boolean; stopsWithParent?: true; deletedAt?: string } = {},
  ) => ({
    id: ThreadId.make(id),
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    attachedToParent: extra.attached ?? parent !== null,
    ...(extra.stopsWithParent ? { stopsWithParent: extra.stopsWithParent } : {}),
    deletedAt: extra.deletedAt ?? null,
    createdAt,
  });
  const ids = (walk: ReadonlyArray<{ thread: { id: string }; level: number }>) =>
    walk.map((entry) => `${entry.thread.id}@${entry.level}`);

  it("lists a family in tree order with levels, and leaves out separated and deleted threads", () => {
    const threads = [
      member("root", null, "2026-11-23T10:00:00.000Z"),
      member("m2", "root", "2026-11-23T10:02:00.000Z"),
      member("m1", "root", "2026-11-23T10:01:00.000Z"),
      member("g1", "m1", "2026-11-23T10:03:00.000Z"),
      member("separated", "root", "2026-11-23T10:04:00.000Z", { attached: false }),
      member("deleted", "m2", "2026-11-23T10:05:00.000Z", {
        deletedAt: "2026-11-23T11:00:00.000Z",
      }),
      member("loose", "m2", "2026-11-23T10:06:00.000Z", { attached: false, stopsWithParent: true }),
      member("under-loose", "loose", "2026-11-23T10:07:00.000Z"),
    ];
    expect(ids(attachedDescendantsOf(threads, ThreadId.make("root")))).toEqual([
      "m1@1",
      "g1@2",
      "m2@1",
    ]);
    // Stop also takes a thread started without report back, and what is under it.
    expect(ids(stopReachOf(threads, ThreadId.make("root")))).toEqual([
      "m1@1",
      "g1@2",
      "m2@1",
      "loose@2",
      "under-loose@3",
    ]);
  });

  it("never loops on a cycle in bad data", () => {
    const threads = [
      member("a", "b", "2026-11-23T10:00:00.000Z"),
      member("b", "a", "2026-11-23T10:01:00.000Z"),
    ];
    expect(ids(attachedDescendantsOf(threads, ThreadId.make("a")))).toEqual(["b@1"]);
  });
});

describe("isStillGoing", () => {
  const idle: StillGoingInput = {
    session: { status: "ready" },
    latestTurn: { state: "completed" },
    queuedCount: 0,
    waitsOnUser: false,
    openRequestCount: 0,
  };

  it("is false for an idle open session, and true for each kind of work", () => {
    expect(isStillGoing(idle)).toBe(false);
    expect(isStillGoing({ ...idle, latestTurn: { state: "running" } })).toBe(true);
    expect(isStillGoing({ ...idle, session: { status: "starting" } })).toBe(true);
    expect(isStillGoing({ ...idle, queuedCount: 1 })).toBe(true);
    expect(isStillGoing({ ...idle, waitsOnUser: true })).toBe(true);
    expect(isStillGoing({ ...idle, openRequestCount: 1 })).toBe(true);
    expect(
      isStillGoing({ ...idle, session: { status: "ready", pendingBackgroundTaskCount: 1 } }),
    ).toBe(true);
    expect(
      isStillGoing({
        ...idle,
        session: { status: "error", continueAtReset: { at: "2026-11-23T12:00:00.000Z" } },
      }),
    ).toBe(true);
  });

  it("counts a check-back, saved or not, until it is dormant", () => {
    expect(isStillGoing({ ...idle, checkBacks: [{}] })).toBe(true);
    expect(isStillGoing({ ...idle, checkBacks: [{ dormant: true }] })).toBe(false);
  });
});
