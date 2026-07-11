import { describe, expect, it } from "vite-plus/test";

import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  extractPendingRequestId,
  isStalePendingRequestFailureDetail,
  USER_INPUT_ACTIVITY_KINDS,
} from "./pendingRequests.ts";

describe("isStalePendingRequestFailureDetail", () => {
  it("matches known stale/unknown pending request details case-insensitively", () => {
    expect(
      isStalePendingRequestFailureDetail("Unknown pending Codex approval request: req-1"),
    ).toBe(true);
    expect(
      isStalePendingRequestFailureDetail("stale pending user-input request 'req-2' was dropped"),
    ).toBe(true);
    expect(isStalePendingRequestFailureDetail("Unknown pending permission request req-3")).toBe(
      true,
    );
  });

  it("matches the no-active-provider-session failure so dead prompts close", () => {
    expect(
      isStalePendingRequestFailureDetail("No active provider session is bound to this thread."),
    ).toBe(true);
  });

  it("rejects unrelated failures and empty details", () => {
    expect(isStalePendingRequestFailureDetail("provider timed out")).toBe(false);
    expect(isStalePendingRequestFailureDetail("")).toBe(false);
    expect(isStalePendingRequestFailureDetail(null)).toBe(false);
    expect(isStalePendingRequestFailureDetail(undefined)).toBe(false);
  });
});

describe("extractPendingRequestId", () => {
  it("returns the requestId string from an activity payload", () => {
    expect(extractPendingRequestId({ requestId: "req-1" })).toBe("req-1");
  });

  it("returns null for missing, empty, or non-string request ids", () => {
    expect(extractPendingRequestId({})).toBeNull();
    expect(extractPendingRequestId({ requestId: "" })).toBeNull();
    expect(extractPendingRequestId({ requestId: 7 })).toBeNull();
    expect(extractPendingRequestId(null)).toBeNull();
    expect(extractPendingRequestId("req-1")).toBeNull();
  });
});

describe("collectOpenPendingRequests", () => {
  const requested = (requestId: string) => ({
    kind: USER_INPUT_ACTIVITY_KINDS.requested,
    payload: { requestId },
  });

  it("keeps requests open until a matching resolved activity arrives", () => {
    const open = collectOpenPendingRequests(
      [
        requested("req-1"),
        requested("req-2"),
        { kind: USER_INPUT_ACTIVITY_KINDS.resolved, payload: { requestId: "req-1" } },
      ],
      USER_INPUT_ACTIVITY_KINDS,
    );
    expect(open.map((entry) => entry.requestId)).toEqual(["req-2"]);
  });

  it("closes requests on respond failures with stale details only", () => {
    const open = collectOpenPendingRequests(
      [
        requested("req-1"),
        requested("req-2"),
        {
          kind: USER_INPUT_ACTIVITY_KINDS.respondFailed,
          payload: {
            requestId: "req-1",
            detail: "No active provider session is bound to this thread.",
          },
        },
        {
          kind: USER_INPUT_ACTIVITY_KINDS.respondFailed,
          payload: { requestId: "req-2", detail: "provider timed out" },
        },
      ],
      USER_INPUT_ACTIVITY_KINDS,
    );
    expect(open.map((entry) => entry.requestId)).toEqual(["req-2"]);
  });

  it("tracks approval and user-input requests independently by kind set", () => {
    const activities = [
      { kind: APPROVAL_ACTIVITY_KINDS.requested, payload: { requestId: "approval-1" } },
      requested("input-1"),
      { kind: APPROVAL_ACTIVITY_KINDS.resolved, payload: { requestId: "approval-1" } },
    ];
    expect(
      collectOpenPendingRequests(activities, APPROVAL_ACTIVITY_KINDS).map(
        (entry) => entry.requestId,
      ),
    ).toEqual([]);
    expect(
      collectOpenPendingRequests(activities, USER_INPUT_ACTIVITY_KINDS).map(
        (entry) => entry.requestId,
      ),
    ).toEqual(["input-1"]);
  });

  it("returns the latest requested activity for re-opened request ids", () => {
    const first = { kind: USER_INPUT_ACTIVITY_KINDS.requested, payload: { requestId: "req-1" } };
    const second = {
      kind: USER_INPUT_ACTIVITY_KINDS.requested,
      payload: { requestId: "req-1", questions: [] },
    };
    const open = collectOpenPendingRequests([first, second], USER_INPUT_ACTIVITY_KINDS);
    expect(open).toHaveLength(1);
    expect(open[0]?.activity).toBe(second);
  });

  it("ignores activities without a requestId", () => {
    const open = collectOpenPendingRequests(
      [{ kind: USER_INPUT_ACTIVITY_KINDS.requested, payload: { questions: [] } }],
      USER_INPUT_ACTIVITY_KINDS,
    );
    expect(open).toEqual([]);
  });
});
