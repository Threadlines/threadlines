import {
  ComputerLinkId,
  EnvironmentId,
  type OrchestrationThreadMove,
  type OutboundComputerLink,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveId,
  ThreadMoveRequestId,
  type ThreadMoveTargetPreview,
  ThreadParticipantId,
  type ThreadPendingMove,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countMoveBatch,
  describeMoveBatchProgress,
  describeMoveCandidate,
  describePendingMove,
  describeRemoteChildrenStaying,
  describeThreadMoveLanding,
  describeThreadMoveProgress,
  describeThreadMoveSession,
  formatThreadMoveChanges,
  groupMoveFamilies,
  isThreadMoveOffered,
  isThreadMoveStalled,
  listMoveCandidates,
  toggleMoveFamily,
  withMoveFamilies,
  pickDefaultMoveAgent,
  pickDefaultMoveTarget,
  threadMoveAgentSelection,
  threadMoveNotesFor,
  threadMoveRoomAgentRows,
  threadMoveSessionOutcome,
  type ThreadMoveRoomPicks,
} from "./threadMove";

const MAC_MINI = EnvironmentId.make("environment-mac-mini");

function move(overrides: Partial<OrchestrationThreadMove> = {}): OrchestrationThreadMove {
  return {
    transferId: ThreadMoveId.make("move-1"),
    target: { environmentId: MAC_MINI, label: "Mac mini" },
    agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    phase: "exporting",
    cancelRequested: false,
    startedAt: "2026-10-22T09:00:00.000Z",
    ...overrides,
  };
}

function link(overrides: Partial<OutboundComputerLink> = {}): OutboundComputerLink {
  return {
    linkId: ComputerLinkId.make("link-mac-mini"),
    remoteEnvironmentId: MAC_MINI,
    remoteLabel: "Mac mini",
    remotePlatform: null,
    state: "active",
    connection: "connected",
    route: "direct",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastConnectedAt: null,
    lastError: null,
    ...overrides,
  };
}

function target(overrides: Partial<ThreadMoveTargetPreview> = {}): ThreadMoveTargetPreview {
  return {
    environmentId: MAC_MINI,
    label: "Mac mini",
    projectName: "threadlines",
    access: "ask",
    agents: [
      {
        instanceId: "codex",
        name: "Codex",
        billing: "ChatGPT Pro",
        driver: "codex",
        models: [
          { model: "gpt-5", name: "GPT-5" },
          { model: "gpt-5-mini", name: "GPT-5 mini" },
        ],
      },
      {
        instanceId: "claudeAgent",
        name: "Claude",
        billing: "Claude Max",
        driver: "claudeAgent",
        models: [{ model: "claude-opus-5-5", name: "Opus 5.5" }],
      },
    ],
    ...overrides,
  };
}

describe("formatThreadMoveChanges", () => {
  it("says what goes with the thread, leaving out what is empty", () => {
    expect(
      formatThreadMoveChanges({
        messageCount: 12,
        branch: "fix/x",
        trackedFiles: 3,
        untrackedFiles: 1,
        unpushedCommits: 2,
      }),
    ).toBe("12 messages · branch fix/x · 3 changed files · 1 new file · 2 commits not pushed");
    expect(
      formatThreadMoveChanges({
        messageCount: 1,
        branch: null,
        trackedFiles: 0,
        untrackedFiles: 0,
        unpushedCommits: 1,
      }),
    ).toBe("1 message · not on a branch · 1 commit not pushed");
  });
});

describe("describeThreadMoveProgress", () => {
  it("names each step, the share sent, and a stop on its way", () => {
    expect(describeThreadMoveProgress(move())).toBe("Getting ready to move to Mac mini…");
    expect(describeThreadMoveProgress(move({ phase: "awaiting_approval" }))).toBe(
      "Waiting for Mac mini to allow the move",
    );
    expect(
      describeThreadMoveProgress(move({ phase: "sending", sentBytes: 409, totalBytes: 1_000 })),
    ).toBe("Sending to Mac mini · 40%");
    expect(describeThreadMoveProgress(move({ phase: "sending" }))).toBe("Sending to Mac mini…");
    expect(describeThreadMoveProgress(move({ phase: "importing" }))).toBe(
      "Setting up on Mac mini…",
    );
    expect(describeThreadMoveProgress(move({ phase: "sending", cancelRequested: true }))).toBe(
      "Stopping the move…",
    );
  });
});

describe("describePendingMove", () => {
  const pending = (overrides: Partial<ThreadPendingMove> = {}): ThreadPendingMove => ({
    requestId: ThreadMoveRequestId.make("queued-1"),
    target: { environmentId: MAC_MINI, label: "Mac mini" },
    agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    mode: "when-done",
    stage: "waiting",
    requestedAt: "2026-10-22T09:00:00.000Z",
    requestedBy: { kind: "user" },
    waitsFor: [{ code: "approval", words: "once you answer" }],
    ...overrides,
  });

  it("says when it goes, in the agent's name when the agent asked, and what holds it", () => {
    expect(describePendingMove(pending()).lead).toBe("Moves to Mac mini once you answer.");
    expect(
      describePendingMove(
        pending({
          requestedBy: { kind: "agent", turnId: TurnId.make("turn-1") },
          waitsFor: [{ code: "turn", words: "when this turn ends" }],
        }),
      ).lead,
    ).toBe("Your agent asked to move this thread to Mac mini when this turn ends.");
    expect(describePendingMove(pending({ stage: "quiescing", waitsFor: [] })).lead).toBe(
      "Stopping the agent to move to Mac mini…",
    );
    expect(
      describePendingMove(
        pending({
          hold: { kind: "target_unreachable", words: "Waiting for Mac mini to connect." },
        }),
      ),
    ).toEqual({ lead: "Waiting for Mac mini to connect.", severity: "info", retry: true });
  });
});

describe("isThreadMoveStalled", () => {
  it("holds an unfinished move whose link is gone, revoked or can't reach the other computer", () => {
    expect(isThreadMoveStalled({ move: move(), outbound: [link()] })).toBe(false);
    expect(isThreadMoveStalled({ move: move(), outbound: [] })).toBe(true);
    expect(isThreadMoveStalled({ move: move(), outbound: [link({ state: "revoked" })] })).toBe(
      true,
    );
    expect(isThreadMoveStalled({ move: move(), outbound: [link({ connection: "offline" })] })).toBe(
      true,
    );
  });

  it("says nothing while the links aren't heard, or once the move is done", () => {
    expect(isThreadMoveStalled({ move: move(), outbound: null })).toBe(false);
    expect(
      isThreadMoveStalled({
        move: move({
          movedAway: {
            threadId: ThreadId.make("thread-there"),
            movedAt: "2026-10-22T09:05:00.000Z",
          },
        }),
        outbound: [],
      }),
    ).toBe(false);
  });
});

describe("isThreadMoveOffered", () => {
  it("needs a computer that moves threads, an active link, and a thread not already moving", () => {
    const offered = (input: Partial<Parameters<typeof isThreadMoveOffered>[0]>) =>
      isThreadMoveOffered({
        supportsThreadMove: true,
        movesThreadState: false,
        generalChat: false,
        outbound: [link()],
        moveStatus: undefined,
        ...input,
      });
    expect(offered({})).toBe(true);
    expect(offered({ supportsThreadMove: false })).toBe(false);
    expect(offered({ outbound: [link({ state: "unlinking" })] })).toBe(false);
    expect(offered({ outbound: null })).toBe(false);
    expect(offered({ moveStatus: "moving" })).toBe(false);
    expect(offered({ moveStatus: "moved" })).toBe(false);
    // A General Chats thread, only where its computer moves those.
    expect(offered({ generalChat: true })).toBe(false);
    expect(offered({ generalChat: true, movesThreadState: true })).toBe(true);
  });
});

describe("what comes along", () => {
  it("keeps the notes for any agent, and those naming the agent picked", () => {
    const notes = [
      { words: "GitHub isn't signed in on Mac mini. Sign in there before you turn auto-fix on." },
      {
        words: "Codex on Mac mini can't set check-backs. It's told once what was planned.",
        instanceIds: ["codex"],
      },
    ];
    expect(threadMoveNotesFor(notes, "codex")).toEqual([notes[0]!.words, notes[1]!.words]);
    expect(threadMoveNotesFor(notes, "claudeAgent")).toEqual([notes[0]!.words]);
    // No agent picked yet (a computer out of reach): only the ones for any.
    expect(threadMoveNotesFor(notes, null)).toEqual([notes[0]!.words]);
    expect(threadMoveNotesFor(undefined, "codex")).toEqual([]);
  });

  it("says a General Chats thread lands in General chats with its files", () => {
    expect(describeThreadMoveLanding(target(), undefined)).toBe("Lands in threadlines on Mac mini");
    expect(
      describeThreadMoveLanding(target({ projectName: "General chats" }), {
        files: 14,
        bytes: 2_048,
      }),
    ).toBe("Lands in General chats on Mac mini · 14 files");
    expect(
      describeThreadMoveLanding(target({ projectName: "General chats" }), { files: 1, bytes: 9 }),
    ).toBe("Lands in General chats on Mac mini · 1 file");
  });

  it("lists a computer's general chats after its inbox threads, working ones first", () => {
    const thread = (id: string, overrides: { archivedAt?: string } = {}) => ({
      id,
      environmentId: MAC_MINI,
      title: id,
      archivedAt: overrides.archivedAt ?? null,
    });
    const working = new Set(["chat-working", "inbox-working"]);
    const candidates = listMoveCandidates(
      [
        { thread: thread("inbox-idle"), isDone: false },
        { thread: thread("inbox-working"), isDone: false },
      ],
      [
        { thread: thread("chat-idle") },
        { thread: thread("chat-working") },
        { thread: thread("chat-archived", { archivedAt: "2026-10-22T09:00:00.000Z" }) },
      ],
      MAC_MINI,
      (candidate) => working.has(candidate.id),
    );
    expect(candidates.map((candidate) => [candidate.threadId, candidate.working])).toEqual([
      ["inbox-working", true],
      ["chat-working", true],
      ["inbox-idle", false],
      ["chat-idle", false],
    ]);
  });
});

describe("picking where and with whom", () => {
  it("offers first the computer that can take it, and its suggested agent", () => {
    const refused = target({
      environmentId: EnvironmentId.make("environment-windows"),
      label: "Windows PC",
      refusal: "Windows PC has no project for this repository.",
    });
    const suggested = target({
      suggestedAgent: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    });
    expect(pickDefaultMoveTarget([refused, suggested])).toBe(suggested);
    // One out of reach comes before one that can't take it, after one that can.
    const offline = target({
      environmentId: EnvironmentId.make("environment-laptop"),
      label: "Laptop",
      refusal: "Laptop can't be reached right now.",
      unreachable: true,
      agents: [],
    });
    expect(pickDefaultMoveTarget([refused, offline])).toBe(offline);
    expect(pickDefaultMoveTarget([offline, suggested])).toBe(suggested);
    expect(pickDefaultMoveAgent(suggested)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    // A suggestion it doesn't have: its first model instead.
    expect(
      pickDefaultMoveAgent(
        target({ suggestedAgent: { instanceId: ProviderInstanceId.make("pi"), model: "x" } }),
      ),
    ).toEqual({ instanceId: "codex", model: "gpt-5" });
  });

  it("asks for the suggestion as it came, options included, and any other pick as picked", () => {
    const suggestedAgent = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const withSuggestion = target({ suggestedAgent });
    expect(threadMoveAgentSelection(withSuggestion, { instanceId: "codex", model: "gpt-5" })).toBe(
      suggestedAgent,
    );
    expect(
      threadMoveAgentSelection(withSuggestion, { instanceId: "codex", model: "gpt-5-mini" }),
    ).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
  });

  it("presets a room's agents to the agent suggested there, else leaves them out with why", () => {
    const sol = ThreadParticipantId.make("participant-sol");
    const ada = ThreadParticipantId.make("participant-ada");
    const room = {
      agents: [
        { participantId: sol, name: "Sol" },
        { participantId: ada, name: "Ada" },
      ],
    };
    const suggestedAgent = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    };
    const there = target({
      roomAgents: [
        {
          participantId: ada,
          suggestedAgent,
          sessionOutcomes: [{ instanceId: "claudeAgent", outcome: "carries" }],
        },
        { participantId: sol, cantCome: "Sol can't come: Mac mini has no Pi agent." },
      ],
    });
    const rows = (picks: ThreadMoveRoomPicks) =>
      threadMoveRoomAgentRows(room, there, picks).map(({ name, cantCome, session, choice }) => ({
        name,
        cantCome,
        session,
        agent: choice.agent,
      }));
    expect(rows(new Map())).toEqual([
      {
        name: "Sol",
        cantCome: "Sol can't come: Mac mini has no Pi agent.",
        session: null,
        agent: null,
      },
      // The suggestion as it came, options included.
      { name: "Ada", cantCome: null, session: "carries", agent: suggestedAgent },
    ]);
    // Picked by hand: Sol comes as Codex with a summary, Ada is left out.
    expect(
      rows(
        new Map([
          [sol, { instanceId: "codex", model: "gpt-5-mini" }],
          [ada, null],
        ]),
      ),
    ).toEqual([
      {
        name: "Sol",
        cantCome: null,
        session: "summary",
        agent: { instanceId: "codex", model: "gpt-5-mini" },
      },
      { name: "Ada", cantCome: null, session: null, agent: null },
    ]);
  });

  it("says under the agent whether it keeps its memory, for the agent picked", () => {
    const withOutcomes = target({
      sessionOutcomes: [
        { instanceId: "codex", outcome: "carries" },
        { instanceId: "big", outcome: "too_large" },
      ],
    });
    const said = (instanceId: string | null) =>
      describeThreadMoveSession(threadMoveSessionOutcome(withOutcomes, instanceId));
    expect(said("codex")).toBe("The agent keeps its full memory.");
    expect(said("big")).toBe("The agent gets a summary (its session is too large to send).");
    // Another agent, none picked yet, or a computer from before sessions travelled.
    expect(said("claudeAgent")).toBe("The agent gets a summary of the conversation.");
    expect(said(null)).toBe("The agent gets a summary of the conversation.");

    // A batch row says it for the computer picked; a refused row says why instead.
    const row = {
      threadId: ThreadId.make("thread-1"),
      sessionOutcomes: [{ environmentId: MAC_MINI, outcome: "carries" as const }],
    };
    expect(describeMoveCandidate(row, MAC_MINI)).toEqual({
      kind: "now",
      words: "Moves now",
      session: "The agent keeps its full memory.",
    });
    expect(describeMoveCandidate(row, EnvironmentId.make("environment-windows")).session).toBe(
      "The agent gets a summary of the conversation.",
    );
    expect(describeMoveCandidate({ ...row, refusal: "Has a goal set." }, MAC_MINI)).toEqual({
      kind: "refused",
      words: "Has a goal set.",
    });
    // What comes along with it, in the server's words.
    expect(
      describeMoveCandidate({ ...row, brings: [{ words: "Its goal carries on there." }] }, MAC_MINI)
        .brings,
    ).toEqual(["Its goal carries on there."]);
    // Its own lines on the computer picked: what won't work there, and a chat's landing.
    const chat = {
      ...row,
      folder: { files: 14, bytes: 2_048 },
      targetLines: [
        {
          environmentId: MAC_MINI,
          projectName: "General chats",
          notes: [{ words: "Codex on Mac mini can't set check-backs." }],
        },
      ],
    };
    expect(describeMoveCandidate(chat, MAC_MINI, "Mac mini")).toMatchObject({
      landing: "Lands in General chats on Mac mini · 14 files",
      notes: ["Codex on Mac mini can't set check-backs."],
    });
    expect(
      describeMoveCandidate(chat, EnvironmentId.make("environment-windows")).notes,
    ).toBeUndefined();
  });
});

describe("describeRemoteChildrenStaying", () => {
  const MAC = "environment-mac-mini";
  const children = [
    { label: "Mac mini", title: "Fix tests", environmentId: MAC },
    { label: "Windows PC", title: "Review", environmentId: "environment-windows" },
    { label: "Windows PC", title: "Docs", environmentId: "environment-windows" },
  ];

  it("says the ones on the computer it moves to become its threads there again, when it takes them", () => {
    expect(
      describeRemoteChildrenStaying(children, {
        label: "Mac mini",
        environmentId: MAC,
        adoptsChildren: true,
      }),
    ).toEqual([
      "'Fix tests' on Mac mini becomes its thread there again.",
      "2 threads it started on Windows PC stay there. It can't reach them from Mac mini.",
    ]);
    // An older Mac mini keeps them apart, beside it rather than "there".
    expect(
      describeRemoteChildrenStaying(children, { label: "Mac mini", environmentId: MAC }),
    ).toEqual([
      "'Fix tests' is already on Mac mini. It stays separate, so this thread can't reach it.",
      "2 threads it started on Windows PC stay there. It can't reach them from Mac mini.",
    ]);
    // An older server names no computer for its children: matched by name.
    expect(
      describeRemoteChildrenStaying(
        children.map(({ label, title }) => ({ label, title })),
        { label: "Mac mini", environmentId: MAC },
      ),
    ).toEqual([
      "'Fix tests' is already on Mac mini. It stays separate, so this thread can't reach it.",
      "2 threads it started on Windows PC stay there. It can't reach them from Mac mini.",
    ]);
  });
});

describe("describeMoveBatchProgress", () => {
  it("says how a batch goes while it runs, then how it went, naming the ones that didn't move", () => {
    const running = countMoveBatch(["moved", "waiting", "waiting"]);
    expect(
      describeMoveBatchProgress({ counts: running, targetLabel: "Mac mini", misses: [] }),
    ).toBe("Moving 3 threads here: 1 moved, 2 waiting for their agents");
    const allMoved = countMoveBatch(["moved", "moved", "awaiting_approval"]);
    expect(
      describeMoveBatchProgress({ counts: allMoved, targetLabel: "Mac mini", misses: [] }),
    ).toBe("Moved 3 threads to Mac mini. 1 waits for Mac mini to allow it.");
    const someMissed = countMoveBatch(["moved", "moved", "not_moved"]);
    expect(
      describeMoveBatchProgress({
        counts: someMissed,
        targetLabel: "Mac mini",
        misses: [{ title: "Goal thread", words: "Has a goal set. Clear it first." }],
      }),
    ).toBe(
      "Moved 2 of 3 threads to Mac mini. Didn't move: Goal thread (Has a goal set. Clear it first).",
    );
  });
});

describe("a family in the Move threads and quit flows (Part 3f, (g))", () => {
  const parent = { threadId: "p", title: "Ship it", working: false };
  const child = { threadId: "c1", title: "Fix tests", working: true, parentThreadId: "p" };
  const other = { threadId: "c2", title: "Review", working: false, parentThreadId: "p" };
  const alone = { threadId: "x", title: "Elsewhere", working: false };
  const orphan = {
    threadId: "o",
    title: "Its parent isn't listed",
    working: false,
    parentThreadId: "gone",
  };

  it("lists each family together, its children under it", () => {
    const rows = groupMoveFamilies([child, alone, parent, other, orphan]);
    expect(rows.map((row) => [row.candidate.threadId, row.depth])).toEqual([
      ["x", 0],
      ["p", 0],
      ["c1", 1],
      ["c2", 1],
      ["o", 0],
    ]);
  });

  it("lists a family's children oldest first, whatever order they came in", () => {
    const older = { ...other, createdAt: "2026-11-17T09:00:00.000Z" };
    const newer = { ...child, createdAt: "2026-11-17T10:00:00.000Z" };
    for (const listed of [
      [parent, newer, older],
      [parent, older, newer],
    ]) {
      expect(groupMoveFamilies(listed).map((row) => row.candidate.threadId)).toEqual([
        "p",
        "c2",
        "c1",
      ]);
    }
  });

  it("ticks a whole family from any member, and unticks one child or the whole family", () => {
    const candidates = [parent, child, other, alone];
    const canGo = (id: string) => id !== "c2";
    const fromChild = toggleMoveFamily(new Set<string>(), candidates, "c1", true, canGo);
    expect([...fromChild].toSorted()).toEqual(["c1", "p"]);
    // A child unticked stays here; the parent unticked takes its family with it.
    expect([...toggleMoveFamily(fromChild, candidates, "c1", false, canGo)]).toEqual(["p"]);
    expect([...toggleMoveFamily(fromChild, candidates, "p", false, canGo)]).toEqual([]);
  });

  it("moves each working thread with its whole family when quitting", () => {
    const threads = [
      { id: "p", parentThreadId: null, attachedToParent: false, archivedAt: null },
      { id: "c1", parentThreadId: "p", attachedToParent: true, archivedAt: null },
      { id: "c2", parentThreadId: "p", attachedToParent: true, archivedAt: null },
      {
        id: "c3",
        parentThreadId: "p",
        attachedToParent: true,
        archivedAt: "2026-11-17T09:00:00.000Z",
      },
      { id: "x", parentThreadId: null, attachedToParent: false, archivedAt: null },
    ];
    expect(withMoveFamilies(["c1", "x"], threads)).toEqual(["p", "c1", "c2", "x"]);
  });

  it("a child moving with its parent says so until the parent has moved", () => {
    const move = {
      transferId: ThreadMoveId.make("transfer-1"),
      target: { environmentId: EnvironmentId.make("environment-mac"), label: "Mac mini" },
      agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      phase: "importing",
      cancelRequested: false,
      startedAt: "2026-11-17T10:00:00.000Z",
    } satisfies OrchestrationThreadMove;
    expect(describeThreadMoveProgress(move, { withParent: "Ship it" })).toBe(
      "Moves to Mac mini with Ship it.",
    );
    expect(describeThreadMoveProgress(move, { withParent: null })).toBe("Setting up on Mac mini…");
  });
});
