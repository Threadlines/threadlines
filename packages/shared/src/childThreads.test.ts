import {
  ChildRequestBatchId,
  ChildRequestId,
  EMPTY_CHILD_REQUEST_STATE,
  MessageId,
  type OrchestrationChildRequest,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  childAttachRefusal,
  childRequestStateOn,
  childSendRefusal,
  childStartRefusal,
  isHandedBackCompletion,
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

  it("counts threads still waiting for approval toward the per-message limit", () => {
    const state = childRequestStateOn.submitted(
      childRequestStateOn.submitted(
        EMPTY_CHILD_REQUEST_STATE,
        request({ status: "awaiting_user", requestId: ChildRequestId.make("a") }),
      ),
      request({ status: "awaiting_user", requestId: ChildRequestId.make("b") }),
    );
    expect(
      childStartRefusal(caller({ childRequests: state }), {
        from: PRIMARY,
        callerTurnId: TURN,
        count: 3,
      }),
    ).toBeNull();
    expect(
      childStartRefusal(caller({ childRequests: state }), {
        from: PRIMARY,
        callerTurnId: TURN,
        count: 4,
      })?.outcome,
    ).toBe("limit");
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

  it("starts the counts over when the user writes, keeping open requests", () => {
    const open = childRequestStateOn.submitted(EMPTY_CHILD_REQUEST_STATE, request());
    const reset = childRequestStateOn.reset(open);
    expect(reset.startsSinceUser).toBe(0);
    expect(reset.open).toHaveLength(1);
    expect(childRequestStateOn.reset(reset)).toBe(reset);
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
