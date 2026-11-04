import {
  AssistantAlertTargetId,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  type OrchestrationOutsideWork,
  type OutsideAgentAssistantSignIn,
  type OutsideAgentPendingRequest,
  ProjectId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantAlertTargetTitles,
  describeAssistantAlertRenewal,
  describeOutsideAgentAccess,
  describeOutsideAgentProjects,
  describeOutsideAgentSignIn,
  describeOutsideWork,
  initialOutsideAgentDraft,
  nextOutsideAgentNotification,
  nextShownAssistantCode,
  OUTSIDE_AGENT_NOTIFY_INTERVAL_MS,
  outsideAgentGrantFromDraft,
  outsideAgentQuietMinutesLeft,
  waitingOutsideAgentSignIns,
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
    expect(describeOutsideAgentAccess({ access: "work", maxRuntimeMode: "auto" })).toBe(
      "Works with all threads · Auto",
    );

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

  it("says how an assistant signs in, checked or only claimed, and nothing for a local agent", () => {
    const identity = { host: "cursor.sh", verified: true, known: true };
    const oauth = { kind: "assistant", signIn: "oauth", givenName: null } as const;
    expect(describeOutsideAgentSignIn({ ...oauth, identity })).toBe("Signs in from cursor.sh");
    expect(
      describeOutsideAgentSignIn({ ...oauth, identity: { ...identity, verified: false } }),
    ).toBe("Sign-in returns to cursor.sh");
    // Shown as another name than the one it gave (Grok Bot signs in as Cursor): it says so.
    expect(
      describeOutsideAgentSignIn({
        ...oauth,
        givenName: "Cursor",
        identity: { host: "www.cursor.com", verified: false, known: true },
      }),
    ).toBe("Signs in as Cursor through www.cursor.com");
    expect(
      describeOutsideAgentSignIn({
        kind: "assistant",
        signIn: "key",
        identity: null,
        givenName: null,
      }),
    ).toBe("Key");
    expect(
      describeOutsideAgentSignIn({
        kind: "local",
        signIn: "oauth",
        identity: null,
        givenName: null,
      }),
    ).toBe(null);
  });

  it("counts the quiet period down in whole minutes and drops it once over", () => {
    expect(outsideAgentQuietMinutesLeft(null, NOW_MS)).toBeNull();
    expect(outsideAgentQuietMinutesLeft("2026-10-23T12:07:30.000Z", NOW_MS)).toBe(8);
    expect(outsideAgentQuietMinutesLeft("2026-10-23T12:00:10.000Z", NOW_MS)).toBe(1);
    expect(outsideAgentQuietMinutesLeft("2026-10-23T11:59:00.000Z", NOW_MS)).toBeNull();
  });
});

describe("assistantAlertTargetTitles", () => {
  const dots = { connectionId: OutsideAgentConnectionId.make("connection-dots"), name: "dots" };
  const target = (
    id: string,
    url: string,
    addedBy: typeof dots | null = null,
  ): { targetId: AssistantAlertTargetId; url: string; addedBy: typeof dots | null } => ({
    targetId: AssistantAlertTargetId.make(id),
    url,
    addedBy,
  });
  const titles = (...targets: ReadonlyArray<ReturnType<typeof target>>) => [
    ...assistantAlertTargetTitles(targets).values(),
  ];

  it("shows a subscription's host and path, so two at one host tell apart", () => {
    expect(
      titles(
        target("a", "https://chatgpt.com/api/mcp/events/abc?token=hidden", dots),
        target("b", "https://chatgpt.com/api/mcp/events/def", dots),
      ),
    ).toEqual(["chatgpt.com/api/mcp/events/abc", "chatgpt.com/api/mcp/events/def"]);
  });

  it("leaves the titles of addresses the user added as they were, whatever subscribes", () => {
    expect(
      titles(
        target("mine", "https://chatgpt.com/hooks/mine"),
        target("theirs", "https://chatgpt.com/api/mcp/events/abc", dots),
      ),
    ).toEqual(["chatgpt.com", "chatgpt.com/api/mcp/events/abc"]);
    expect(
      titles(
        target("one", "https://hooks.example.com/routines/one"),
        target("two", "https://hooks.example.com/routines/two"),
      ),
    ).toEqual(["hooks.example.com/routines/one", "hooks.example.com/routines/two"]);
  });
});

describe("describeAssistantAlertRenewal", () => {
  it("says when it must be renewed by in the user's clock, and Expired from that moment on", () => {
    const expiresAt = new Date(2026, 10, 9, 15, 14).toISOString();
    const expiresAtMs = Date.parse(expiresAt);

    expect(describeAssistantAlertRenewal(expiresAt, expiresAtMs - 1, "24-hour")).toBe(
      "Renews by Nov 9, 15:14",
    );
    expect(describeAssistantAlertRenewal(expiresAt, expiresAtMs - 1, "12-hour")).toBe(
      "Renews by Nov 9, 3:14 PM",
    );
    expect(describeAssistantAlertRenewal(expiresAt, expiresAtMs, "24-hour")).toBe("Expired");
    expect(describeAssistantAlertRenewal(expiresAt, expiresAtMs + 60_000, "24-hour")).toBe(
      "Expired",
    );
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
    // No sign-in asks for Work: the user may give it to one that asked to
    // start threads, never to one that asked only to see them.
    const work = { ...draft, access: "work" as const };
    expect(
      outsideAgentGrantFromDraft(work, { requestedAccess: "start", availableProjectIds: [WEB] }),
    ).toEqual({ access: "work", maxRuntimeMode: "approval-required", projectIds: [WEB] });
    expect(
      outsideAgentGrantFromDraft(work, { requestedAccess: "see", availableProjectIds: [WEB] }),
    ).toEqual({ access: "see", maxRuntimeMode: "approval-required", projectIds: [WEB] });
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

describe("describeOutsideWork", () => {
  const REVIEWER = ThreadParticipantId.make("participant-reviewer");
  const ref = (id: string, name: string) => ({
    connectionId: OutsideAgentConnectionId.make(id),
    name,
  });
  const marked = (
    participantId: ThreadParticipantId | null,
    ...connections: ReadonlyArray<ReturnType<typeof ref>>
  ): OrchestrationOutsideWork => ({
    participantId,
    connections,
    since: "2026-10-30T12:00:00.000Z",
    version: 1,
  });
  const roomNames = (participantId: ThreadParticipantId | null) =>
    participantId === null ? "Opus 5.5" : "GPT-6.1 Sol (Reviewer)";

  it("names whose work ran here, each connection once, and keeps a long list short", () => {
    expect(describeOutsideWork([], null)).toBeNull();
    expect(describeOutsideWork([marked(null, ref("grok", "Grok Bot"))], null)).toEqual({
      lead: "Grok Bot worked here.",
      detail: "Tools are limited until a fresh start.",
    });
    expect(
      describeOutsideWork(
        [marked(null, ref("grok", "Grok Bot"), ref("dots", "dots"), ref("grok", "Grok Bot"))],
        null,
      )?.lead,
    ).toBe("Grok Bot and dots worked here.");
    expect(
      describeOutsideWork(
        [
          marked(null, ref("grok", "Grok Bot"), ref("dots", "dots")),
          marked(REVIEWER, ref("claude", "Claude Code")),
        ],
        null,
      )?.lead,
    ).toBe("Grok Bot, dots and others worked here.");
  });

  it("names the agents it reached in a room", () => {
    expect(
      describeOutsideWork([marked(REVIEWER, ref("grok", "Grok Bot"))], roomNames)?.detail,
    ).toBe("Tools of GPT-6.1 Sol (Reviewer) are limited until a fresh start.");
    expect(
      describeOutsideWork(
        [marked(null, ref("grok", "Grok Bot")), marked(REVIEWER, ref("grok", "Grok Bot"))],
        roomNames,
      ),
    ).toEqual({
      lead: "Grok Bot worked here.",
      detail: "Tools of Opus 5.5 and GPT-6.1 Sol (Reviewer) are limited until a fresh start.",
    });
  });
});

describe("nextShownAssistantCode", () => {
  it("keeps a code that left the snapshot only if it had run out, so Settings can say so", () => {
    const code = { code: "K4D82PQX", expiresAt: "2026-10-23T12:05:00.000Z" };
    const fresh = { code: "M7Q2R9TX", expiresAt: "2026-10-23T12:10:00.000Z" };
    expect(nextShownAssistantCode(code, fresh, NOW_MS)).toBe(fresh);
    // Gone before it ran out: a sign-in used it, or it was cancelled.
    expect(nextShownAssistantCode(code, null, NOW_MS)).toBeNull();
    // Gone once it ran out: it stays, to say it expired.
    expect(nextShownAssistantCode(code, null, Date.parse(code.expiresAt))).toBe(code);
    expect(nextShownAssistantCode(null, null, NOW_MS)).toBeNull();
  });
});

describe("waitingOutsideAgentSignIns", () => {
  it("puts local agents' and assistants' sign-ins in one line, oldest first", () => {
    const assistant = (id: string, createdAt: string): OutsideAgentAssistantSignIn => ({
      requestId: OutsideAgentRequestId.make(id),
      name: "Grok Bot",
      givenName: null,
      assistant: null,
      identity: { host: "cursor.sh", verified: false, known: true },
      place: null,
      requestedAccess: "see",
      replaces: null,
      createdAt,
      expiresAt: "2026-10-23T12:04:00.000Z",
    });
    const waiting = waitingOutsideAgentSignIns({
      pending: [
        { ...request("local-1"), createdAt: "2026-10-23T11:58:00.000Z" },
        { ...request("local-2"), createdAt: "2026-10-23T11:59:30.000Z" },
      ],
      assistants: {
        status: "ready",
        address: "https://connect.threadlines.dev/mcp",
        code: null,
        signIns: [assistant("grok", "2026-10-23T11:59:00.000Z")],
        alertTargets: [],
        reviewComputer: false,
      },
    });
    expect(waiting.map((signIn) => [signIn.kind, signIn.requestId])).toEqual([
      ["local", "local-1"],
      ["assistant", "grok"],
      ["local", "local-2"],
    ]);
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
