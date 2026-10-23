import {
  OutsideAgentRequestId,
  type OutsideAgentPendingRequest,
  ProjectId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeOutsideAgentAccess,
  describeOutsideAgentProjects,
  initialOutsideAgentDraft,
  nextOutsideAgentNotification,
  OUTSIDE_AGENT_NOTIFY_INTERVAL_MS,
  outsideAgentGrantFromDraft,
  outsideAgentQuietMinutesLeft,
} from "./outsideAgents.logic";

const WEB = ProjectId.make("project-web");
const API = ProjectId.make("project-api");
const DOCS = ProjectId.make("project-docs");
const GONE = ProjectId.make("project-gone");
const NOW_MS = Date.parse("2026-10-23T12:00:00.000Z");

function request(id: string): OutsideAgentPendingRequest {
  return {
    requestId: OutsideAgentRequestId.make(id),
    name: "Claude Code",
    code: "K4D-82P",
    callbackPort: 51_234,
    requestedAccess: "start",
    replaces: null,
    createdAt: "2026-10-23T11:59:00.000Z",
    expiresAt: "2026-10-23T12:04:00.000Z",
  };
}

describe("outside agent wording", () => {
  it("says what a connection may do and where, in the access picker's words", () => {
    expect(describeOutsideAgentAccess({ access: "see", maxRuntimeMode: "full-access" })).toBe(
      "Sees threads",
    );
    expect(
      describeOutsideAgentAccess({ access: "start", maxRuntimeMode: "approval-required" }),
    ).toBe("Starts threads · Supervised");

    const names = new Map([
      [WEB, "web"],
      [API, "api"],
      [DOCS, "docs"],
    ]);
    expect(describeOutsideAgentProjects(null, names)).toBe("All projects");
    // A project removed since has no name to show.
    expect(describeOutsideAgentProjects([WEB, GONE], names)).toBe("web");
    expect(describeOutsideAgentProjects([GONE], names)).toBe("No projects");
    expect(describeOutsideAgentProjects([WEB, API, DOCS, GONE], names)).toBe("web, api and 1 more");
  });

  it("counts the quiet period down in whole minutes and drops it once over", () => {
    expect(outsideAgentQuietMinutesLeft(null, NOW_MS)).toBeNull();
    expect(outsideAgentQuietMinutesLeft("2026-10-23T12:07:30.000Z", NOW_MS)).toBe(8);
    expect(outsideAgentQuietMinutesLeft("2026-10-23T12:00:10.000Z", NOW_MS)).toBe(1);
    expect(outsideAgentQuietMinutesLeft("2026-10-23T11:59:00.000Z", NOW_MS)).toBeNull();
  });
});

describe("outsideAgentGrantFromDraft", () => {
  it("never grants more than the agent asked for, nor projects this computer no longer has", () => {
    const draft = {
      ...initialOutsideAgentDraft(null),
      access: "start" as const,
      allProjects: false,
      projectIds: new Set([WEB, GONE]),
    };
    expect(
      outsideAgentGrantFromDraft(draft, {
        requestedAccess: "see",
        availableProjectIds: [WEB, API],
      }),
    ).toEqual({ access: "see", maxRuntimeMode: "approval-required", projectIds: [WEB] });
    expect(
      outsideAgentGrantFromDraft(draft, {
        requestedAccess: "start",
        availableProjectIds: [WEB, API],
      }),
    ).toEqual({ access: "start", maxRuntimeMode: "approval-required", projectIds: [WEB] });
    // Only some projects, none of them ticked: nothing to allow yet.
    expect(
      outsideAgentGrantFromDraft(
        { ...draft, projectIds: new Set([GONE]) },
        { requestedAccess: "start", availableProjectIds: [WEB, API] },
      ),
    ).toBeNull();
  });

  it("opens a Change on the connection's own grant, all projects as null", () => {
    const draft = initialOutsideAgentDraft({
      access: "start",
      maxRuntimeMode: "auto",
      projectIds: null,
    });
    expect(
      outsideAgentGrantFromDraft(draft, { requestedAccess: "start", availableProjectIds: [WEB] }),
    ).toEqual({ access: "start", maxRuntimeMode: "auto", projectIds: null });
  });
});

describe("nextOutsideAgentNotification", () => {
  it("announces a new sign-in once, only while unattended, at most every 30 seconds", () => {
    const first = nextOutsideAgentNotification({
      pending: [request("a")],
      seen: new Set(),
      lastNotifiedAtMs: null,
      nowMs: NOW_MS,
      attended: false,
    });
    expect(first.notify?.requestId).toBe("a");

    // The same one again: already seen.
    expect(
      nextOutsideAgentNotification({
        pending: [request("a")],
        seen: first.seen,
        lastNotifiedAtMs: null,
        nowMs: NOW_MS + OUTSIDE_AGENT_NOTIFY_INTERVAL_MS,
        attended: false,
      }).notify,
    ).toBeNull();

    // A second one inside 30 seconds is held back, and isn't announced later either.
    const throttled = nextOutsideAgentNotification({
      pending: [request("a"), request("b")],
      seen: first.seen,
      lastNotifiedAtMs: NOW_MS,
      nowMs: NOW_MS + 10_000,
      attended: false,
    });
    expect(throttled.notify).toBeNull();
    expect(
      nextOutsideAgentNotification({
        pending: [request("a"), request("b")],
        seen: throttled.seen,
        lastNotifiedAtMs: NOW_MS,
        nowMs: NOW_MS + OUTSIDE_AGENT_NOTIFY_INTERVAL_MS,
        attended: false,
      }).notify,
    ).toBeNull();

    // While the user looks at the window, the dialog is enough.
    expect(
      nextOutsideAgentNotification({
        pending: [request("c")],
        seen: new Set(),
        lastNotifiedAtMs: null,
        nowMs: NOW_MS,
        attended: true,
      }).notify,
    ).toBeNull();
  });
});
