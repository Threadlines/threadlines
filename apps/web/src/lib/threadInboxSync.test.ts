import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import { EnvironmentId, ProjectId, type ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { dispatchCommand } = vi.hoisted(() => ({ dispatchCommand: vi.fn() }));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand } }),
}));

import { selectEnvironmentState, useStore } from "../store";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import {
  markThreadSeen,
  markThreadUnreadByKey,
  resendUndeliveredThreadSeen,
} from "./threadInboxSync";

const environmentId = EnvironmentId.make("environment-asleep");
const COMPLETED_AT = "2026-10-13T08:38:05.000Z";
/** What "Mark unread" writes: a millisecond before the completion. */
const UNREAD_AT = "2026-10-13T08:38:04.999Z";

/** Lets a settled dispatch run the handlers chained on it. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setServerLastSeenAt(threadRef: ScopedThreadRef, lastSeenAt: string): void {
  const summary: SidebarThreadSummary = {
    id: threadRef.threadId,
    environmentId: threadRef.environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-10-13T08:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneOverride: null,
    lastSeenAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    cumulativeDiffStat: null,
  };
  useStore.setState((state) => ({
    environmentStateById: {
      ...state.environmentStateById,
      [threadRef.environmentId]: {
        ...selectEnvironmentState(state, threadRef.environmentId),
        sidebarThreadSummaryById: { [threadRef.threadId]: summary },
      },
    },
  }));
}

describe("a visit the server did not take", () => {
  beforeEach(() => {
    dispatchCommand.mockReset();
    dispatchCommand.mockRejectedValue(new Error("RpcClientDefect: Unknown socket error"));
    useUiStateStore.setState({ seenThreadOverlays: {} });
    useStore.setState({ environmentStateById: {} });
  });

  it("is sent once, stays read here, and goes out again when its environment lists threads", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-held"));
    const threadKey = scopedThreadKey(threadRef);

    markThreadSeen(threadRef, COMPLETED_AT);
    await settle();
    // The chat view calls this from a render effect, which runs again on every
    // change to what the thread reads as.
    markThreadSeen(threadRef, COMPLETED_AT);
    await settle();
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]?.at).toBe(COMPLETED_AT);

    resendUndeliveredThreadSeen(EnvironmentId.make("environment-other"));
    expect(dispatchCommand).toHaveBeenCalledTimes(1);

    let deliver: (result: { sequence: number }) => void = () => undefined;
    dispatchCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    resendUndeliveredThreadSeen(environmentId);
    // Another thread list while that attempt is in flight sends nothing more.
    resendUndeliveredThreadSeen(environmentId);
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "thread.seen.set",
        threadId: threadRef.threadId,
        at: COMPLETED_AT,
      }),
    );
    deliver({ sequence: 2 });
    await settle();
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]).toEqual({
      at: COMPLETED_AT,
      baselineAt: null,
      writeId: expect.any(Number),
      settled: true,
    });

    // Delivered, so the next thread list has nothing to send.
    resendUndeliveredThreadSeen(environmentId);
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });

  it("stops going out when the server keeps refusing it, and stays read here", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-refused"));
    const threadKey = scopedThreadKey(threadRef);

    markThreadSeen(threadRef, COMPLETED_AT);
    await settle();
    for (let listing = 0; listing < 10; listing += 1) {
      resendUndeliveredThreadSeen(environmentId);
      await settle();
    }

    expect(dispatchCommand).toHaveBeenCalledTimes(4);
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]).toMatchObject({
      at: COMPLETED_AT,
      settled: true,
    });
  });

  it("gives way when the server's answer moved while it waited", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-moved"));
    const threadKey = scopedThreadKey(threadRef);

    markThreadSeen(threadRef, COMPLETED_AT);
    await settle();

    // Another device marked the thread unread while this one was cut off.
    setServerLastSeenAt(threadRef, UNREAD_AT);
    resendUndeliveredThreadSeen(environmentId);
    await settle();

    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]).toBeUndefined();
  });

  it("gives way when the server's answer moved while an attempt was in flight", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-moved-in-flight"));
    const threadKey = scopedThreadKey(threadRef);
    let failVisit: (error: Error) => void = () => undefined;
    dispatchCommand.mockReset();
    dispatchCommand.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failVisit = reject;
        }),
    );

    markThreadSeen(threadRef, COMPLETED_AT);
    setServerLastSeenAt(threadRef, UNREAD_AT);
    failVisit(new Error("The computer is not answering."));
    await settle();

    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]).toBeUndefined();
  });

  it("is not closed out by a late answer to an earlier write with the same stamp", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-same-stamp"));
    const threadKey = scopedThreadKey(threadRef);
    let failFirstVisit: (error: Error) => void = () => undefined;
    dispatchCommand.mockReset();
    dispatchCommand
      // The first visit hangs on a dying connection.
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirstVisit = reject;
          }),
      )
      // Mark unread goes through.
      .mockResolvedValueOnce({ sequence: 2 })
      // The second visit, with the first one's stamp, stays in flight.
      .mockImplementation(() => new Promise(() => undefined));

    markThreadSeen(threadRef, COMPLETED_AT);
    markThreadUnreadByKey(threadKey, COMPLETED_AT);
    await settle();
    markThreadSeen(threadRef, COMPLETED_AT);
    failFirstVisit(new Error("The computer is not answering."));
    await settle();

    // Still in flight, so a thread list must not send it a second time.
    resendUndeliveredThreadSeen(environmentId);
    expect(dispatchCommand).toHaveBeenCalledTimes(3);
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]).toMatchObject({
      at: COMPLETED_AT,
      settled: false,
    });
  });

  it("gives way to a live update too, without waiting for the next thread list", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-live-update"));
    const threadKey = scopedThreadKey(threadRef);

    markThreadSeen(threadRef, COMPLETED_AT);
    await settle();

    // What every thread update from the server runs.
    useUiStateStore.getState().syncThreads([{ key: threadKey, serverLastSeenAt: UNREAD_AT }]);
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]).toBeUndefined();

    resendUndeliveredThreadSeen(environmentId);
    await settle();
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it("is called off by Mark unread, even when the server already holds unread", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-marked-unread"));
    const threadKey = scopedThreadKey(threadRef);
    setServerLastSeenAt(threadRef, UNREAD_AT);

    markThreadSeen(threadRef, COMPLETED_AT);
    await settle();
    markThreadUnreadByKey(threadKey, COMPLETED_AT);
    await settle();
    resendUndeliveredThreadSeen(environmentId);
    await settle();

    expect(dispatchCommand.mock.calls.map(([command]) => command.at)).toEqual([
      COMPLETED_AT,
      UNREAD_AT,
      UNREAD_AT,
    ]);
    expect(useUiStateStore.getState().seenThreadOverlays[threadKey]?.at).toBe(UNREAD_AT);
  });
});
