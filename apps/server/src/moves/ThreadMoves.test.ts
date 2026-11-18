import {
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadGoal,
  type PeerDescriptor,
  type PeerMoveState,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveFamilyId,
  type ThreadMovePreview,
  TurnId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  checkMoveTarget,
  moveAbortCode,
  offerUntilTaken,
  previewManyThread,
  targetPreviewOf,
} from "./ThreadMoves.ts";
import {
  exportThreadHistory,
  MOVE_MAX_BYTES,
  moveThreadStateOf,
  nativeSessionFits,
  sessionsThatFit,
} from "./moveExport.ts";
import { carryBringsWords, threadMoveCarry } from "../orchestration/threadMoveCarry.ts";
import { linkLineageOf, startedThereOf } from "./familyMove.ts";
import { seenThroughOf } from "./roomMove.ts";
import { NATIVE_SESSION_MAX_BYTES, type NativeSessionExport } from "../provider/nativeSession.ts";

const THREAD = ThreadId.make("thread-1");

const MAC_MINI = EnvironmentId.make("environment-mac-mini");
const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("mac-claude"),
  model: "opus-5-5",
};
const codex: ModelSelection = {
  instanceId: ProviderInstanceId.make("mac-codex"),
  model: "gpt-6-astra",
};
const agents = [
  {
    instanceId: "mac-claude",
    name: "Claude",
    billing: "Claude Max",
    models: [{ model: "opus-5-5", name: "Opus 5.5" }],
    driver: "claudeAgent",
  },
  {
    instanceId: "mac-codex",
    name: "Codex",
    billing: "ChatGPT Pro",
    models: [{ model: "gpt-6-astra", name: "GPT-6 Astra" }],
    driver: "codex",
  },
] as ThreadMovePreview["targets"][number]["agents"];

const shown = (target: Partial<ThreadMovePreview["targets"][number]>): ThreadMovePreview => ({
  targets: [{ environmentId: MAC_MINI, label: "Mac mini", agents, ...target }],
});

describe("checkMoveTarget", () => {
  it("takes the target's suggestion when the move names no agent, and a named one as named", () => {
    expect(
      checkMoveTarget(shown({ suggestedAgent: claude }), MAC_MINI, undefined, undefined),
    ).toMatchObject({
      agent: claude,
    });
    expect(
      checkMoveTarget(shown({ suggestedAgent: claude }), MAC_MINI, codex, undefined),
    ).toMatchObject({
      agent: codex,
    });
  });

  it("can't go when the target suggests none and none is named", () => {
    expect(checkMoveTarget(shown({}), MAC_MINI, undefined, undefined)).toEqual({
      refusal: "Mac mini has no agent ready.",
    });
  });

  it("a child moving alone goes only where it stays its parent's; with its family it still goes", () => {
    // A computer that was offline when the move was queued, back on an older Threadlines.
    const older = shown({
      suggestedAgent: claude,
      aloneRefusal: "Update Threadlines on Mac mini to move it without the thread that started it.",
    });
    expect(checkMoveTarget(older, MAC_MINI, undefined, undefined)).toEqual({
      refusal: "Update Threadlines on Mac mini to move it without the thread that started it.",
    });
    expect(
      checkMoveTarget(older, MAC_MINI, undefined, {
        id: ThreadMoveFamilyId.make("family-1"),
        parentThreadId: ThreadId.make("thread-parent"),
      }),
    ).toMatchObject({ agent: claude });
  });

  it("a batch lists a computer once, and a thread its own refusals there", () => {
    const peer = {
      environmentId: MAC_MINI,
      label: "Mac mini",
      platform: "macOS",
      serverVersion: "1.0.0",
      directRoutes: [],
      access: "ask",
      maxRuntimeMode: "auto",
      agents,
      defaultAgent: claude,
      projects: [{ canonicalKey: "example.com/repo", name: "Threadlines" }],
      moves: true,
      moveStagedApproval: true,
    } as unknown as PeerDescriptor;
    const target = { environmentId: MAC_MINI, label: "Mac mini", described: Option.some(peer) };
    const shared = targetPreviewOf(target, null);
    // For every thread: reachable, its default agent suggested, and it takes the bytes before Allow.
    expect(shared).toMatchObject({ suggestedAgent: claude, stagedApproval: true, access: "ask" });
    expect(shared.refusal).toBeUndefined();
    const thread = { modelSelection: codex } as OrchestrationThread;
    const elsewhere = targetPreviewOf(target, {
      thread,
      place: { canonicalKey: "example.com/other", subdirectory: "", rootPath: "/repo" },
    });
    expect(previewManyThread(THREAD, { targets: [elsewhere] }, [shared])).toEqual({
      threadId: THREAD,
      targetRefusals: [
        {
          environmentId: MAC_MINI,
          refusal: "Mac mini doesn't have this project.",
          refusalCode: "no_project",
        },
      ],
    });
    // A computer no thread can reach isn't repeated for each thread.
    const gone = targetPreviewOf({ ...target, described: Option.none() }, null);
    expect(previewManyThread(THREAD, { targets: [gone] }, [gone])).toEqual({ threadId: THREAD });
  });

  it("says per agent whether the thread's session goes with it, in one dialog and in a batch", () => {
    const peer = {
      environmentId: MAC_MINI,
      label: "Mac mini",
      agents,
      defaultAgent: claude,
      projects: [{ canonicalKey: "example.com/repo", name: "Threadlines" }],
      moves: true,
      access: "allowed",
      moveNativeSession: true,
    } as unknown as PeerDescriptor;
    const target = { environmentId: MAC_MINI, label: "Mac mini", described: Option.some(peer) };
    const place = { canonicalKey: "example.com/repo", subdirectory: "", rootPath: "/repo" };
    const thread = { modelSelection: claude } as OrchestrationThread;
    const claudeSession = (size: number): NativeSessionExport => ({
      driver: ProviderDriverKind.make("claudeAgent"),
      cursor: { resume: "s" },
      files: [{ relPath: "projects/-r/s.jsonl", absolutePath: "/c/s.jsonl", size }],
    });
    const outcomes = (session: NativeSessionExport | null, described = peer) =>
      targetPreviewOf({ ...target, described: Option.some(described) }, { thread, place, session })
        .sessionOutcomes;

    // The same driver keeps its memory; another driver gets the summary.
    expect(outcomes(claudeSession(1024))).toEqual([
      { instanceId: "mac-claude", outcome: "carries" },
      { instanceId: "mac-codex", outcome: "summary" },
    ]);
    expect(outcomes(claudeSession(NATIVE_SESSION_MAX_BYTES + 1))?.[0]).toEqual({
      instanceId: "mac-claude",
      outcome: "too_large",
    });
    // No session here, or a computer that can't take one: the summary for every agent.
    expect(outcomes(null)?.map((entry) => entry.outcome)).toEqual(["summary", "summary"]);
    const older = { ...peer, moveNativeSession: undefined } as unknown as PeerDescriptor;
    expect(outcomes(claudeSession(1024), older)?.map((entry) => entry.outcome)).toEqual([
      "summary",
      "summary",
    ]);
    // A batch row says it for the agent the computer suggests for that thread.
    const own = targetPreviewOf(target, { thread, place, session: claudeSession(1024) });
    expect(previewManyThread(THREAD, { targets: [own] }, [own]).sessionOutcomes).toEqual([
      { environmentId: MAC_MINI, outcome: "carries" },
    ]);
    // Both caps: the session itself, and the move with it.
    expect(nativeSessionFits(NATIVE_SESSION_MAX_BYTES, 0)).toBe(true);
    expect(nativeSessionFits(NATIVE_SESSION_MAX_BYTES + 1, 0)).toBe(false);
    expect(nativeSessionFits(10, MOVE_MAX_BYTES - 9)).toBe(false);
    // The dialog weighs the thread's own changes as the export does.
    const heavy = targetPreviewOf(target, {
      thread,
      place,
      session: claudeSession(1024),
      otherBytes: MOVE_MAX_BYTES - 100,
    });
    expect(heavy.sessionOutcomes?.[0]).toEqual({ instanceId: "mac-claude", outcome: "too_large" });
  });

  it("a room's sessions share the move as the export shares them: the largest goes as a summary first", () => {
    const peer = {
      environmentId: MAC_MINI,
      label: "Mac mini",
      agents,
      defaultAgent: claude,
      projects: [{ canonicalKey: "example.com/repo", name: "Threadlines" }],
      moves: true,
      access: "allowed",
      moveNativeSession: true,
    } as unknown as PeerDescriptor;
    const target = { environmentId: MAC_MINI, label: "Mac mini", described: Option.some(peer) };
    const place = { canonicalKey: "example.com/repo", subdirectory: "", rootPath: "/repo" };
    const thread = { modelSelection: claude } as OrchestrationThread;
    const MB = 1024 * 1024;
    const claudeSession = (size: number): NativeSessionExport => ({
      driver: ProviderDriverKind.make("claudeAgent"),
      cursor: { resume: "s" },
      files: [{ relPath: "projects/-r/s.jsonl", absolutePath: "/c/s.jsonl", size }],
    });
    const SOL = "6f1d7c2a-1b2c-4d3e-8f90-0a1b2c3d4e5f";
    const ADA = "7a2e8d3b-2c3d-4e4f-9a01-1b2c3d4e5f60";
    const source = (participantId: string, handle: string) => ({
      participantId: participantId as never,
      handle,
      driver: "claudeAgent",
      model: "opus-5-5",
    });
    // 30 + 45 + 35 MB: over the move's 100 MB together, each fitting alone.
    const preview = targetPreviewOf(target, {
      thread,
      place,
      session: claudeSession(30 * MB),
      room: [source(SOL, "Sol"), source(ADA, "Ada")],
      roomSessions: new Map([
        [SOL, claudeSession(45 * MB)],
        [ADA, claudeSession(35 * MB)],
      ]),
    });
    const outcomeOf = (participantId: string) =>
      preview.roomAgents
        ?.find((entry) => entry.participantId === participantId)
        ?.sessionOutcomes?.find((entry) => entry.instanceId === "mac-claude")?.outcome;
    expect(outcomeOf(SOL)).toBe("too_large");
    expect(outcomeOf(ADA)).toBe("carries");
    expect(preview.sessionOutcomes?.[0]).toEqual({ instanceId: "mac-claude", outcome: "carries" });
    // Exactly what the export keeps.
    expect(
      [
        ...sessionsThatFit(
          [
            { key: "own", bytes: 30 * MB },
            { key: SOL, bytes: 45 * MB },
            { key: ADA, bytes: 35 * MB },
          ],
          0,
        ),
      ].toSorted(),
    ).toEqual([ADA, "own"].toSorted());
  });

  it("waits on an unreachable target, whatever the agent", () => {
    expect(
      checkMoveTarget(
        shown({
          refusal: "Mac mini can't be reached right now.",
          unreachable: true,
          agents: [],
        }),
        MAC_MINI,
        undefined,
        undefined,
      ),
    ).toHaveProperty("unreachable");
  });
});

describe("offerUntilTaken", () => {
  const busy: PeerMoveState = {
    status: "aborted",
    bytesReceived: 0,
    reason: "Mac mini is already taking other moves. Try again once they're done.",
    refusalCode: "busy",
  };
  const offer = (
    answers: ReadonlyArray<PeerMoveState>,
    standing: () => "waiting" | "cancelled" | "gone" = () => "waiting",
  ) => {
    const seen = { offers: 0, waiting: 0 };
    const run = offerUntilTaken({
      prepare: Effect.sync(() => answers[Math.min(seen.offers++, answers.length - 1)]!),
      standing: Effect.sync(standing),
      waiting: Effect.sync(() => {
        seen.waiting += 1;
      }),
      delay: () => Duration.millis(4),
      cancelCheck: Duration.millis(1),
    });
    return Effect.runPromise(run).then((result) => ({ result, seen }));
  };

  it("keeps offering a busy computer the move, saying once that it waits for it", async () => {
    const taken: PeerMoveState = { status: "receiving", bytesReceived: 0 };
    const { result, seen } = await offer([busy, busy, taken]);
    expect(result).toEqual({ kind: "answered", state: taken });
    expect(seen).toEqual({ offers: 3, waiting: 1 });
  });

  it("a Cancel while it waits ends the move here, offering it no more", async () => {
    let looks = 0;
    const { result, seen } = await offer([busy], () => (++looks > 1 ? "cancelled" : "waiting"));
    expect(result).toEqual({ kind: "cancelled" });
    expect(seen.offers).toBe(1);
  });

  it("names why the other computer dropped a move, as a code", () => {
    const dropped = (extra: Partial<PeerMoveState>): PeerMoveState => ({
      status: "aborted",
      bytesReceived: 0,
      reason: "Dropped.",
      ...extra,
    });
    expect(moveAbortCode(dropped({ abortCode: "denied" }), false)).toBe("denied");
    expect(moveAbortCode(dropped({ abortCode: "expired" }), true)).toBe("expired");
    expect(moveAbortCode(dropped({ refusalCode: "staging_full" }), false)).toBe("staging_full");
    expect(moveAbortCode(dropped({}), true)).toBe("cancelled");
    expect(moveAbortCode(dropped({}), false)).toBe("aborted");
  });

  it("a full staging area is a final answer, not a wait", async () => {
    const full: PeerMoveState = {
      status: "aborted",
      bytesReceived: 0,
      reason: "Mac mini is holding other moves until its user allows them.",
      refusalCode: "staging_full",
    };
    const { result, seen } = await offer([full]);
    expect(result).toEqual({ kind: "answered", state: full });
    expect(seen).toEqual({ offers: 1, waiting: 0 });
  });
});

describe("what a thread carries, as the dialog says it (Part 3e)", () => {
  const goal = (status: OrchestrationThreadGoal["status"], tokenBudget: number | null = null) => ({
    threadId: THREAD,
    objective: "Make the suite pass",
    status,
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
  });
  const plan = (index: number, waiting = false) => ({
    id: `plan-${index}`,
    turnId: waiting ? TurnId.make("turn-last") : TurnId.make(`turn-${index}`),
    planMarkdown: `${index}. Do it`,
    implementedAt: waiting ? null : "2026-11-17T10:00:00.000Z",
    implementationThreadId: null,
    dismissedAt: null,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
  });
  const threadWith = (patch: Partial<OrchestrationThread>) =>
    ({
      id: THREAD,
      projectId: "project-1",
      modelSelection: codex,
      goal: null,
      checkBacks: [],
      queuedFollowUps: [],
      proposedPlans: [],
      latestTurn: null,
      pullRequestAutoFix: false,
      pullRequestAutoMerge: null,
      linkedPullRequests: [],
      participants: [],
      agentRequests: { open: [] },
      parentThreadId: null,
      attachedToParent: false,
      childRequests: { open: [] },
      ...patch,
    }) as unknown as OrchestrationThread;
  const view = { projects: [{ id: "project-1", kind: "project" }] } as never;
  const peer = (extra: Partial<PeerDescriptor>) =>
    ({
      environmentId: MAC_MINI,
      label: "Mac mini",
      access: "allowed",
      agents: [
        { ...agents[0]!, threadGoals: true, goalBudget: false, checkBacks: true },
        { ...agents[1]!, threadGoals: true, goalBudget: true, checkBacks: false },
      ],
      defaultAgent: claude,
      projects: [{ canonicalKey: "example.com/repo", name: "Threadlines" }],
      moves: true,
      ...extra,
    }) as unknown as PeerDescriptor;
  const target = (described: PeerDescriptor) => ({
    environmentId: MAC_MINI,
    label: "Mac mini",
    described: Option.some(described),
  });
  const place = { canonicalKey: "example.com/repo", subdirectory: "", rootPath: "/repo" };

  it("a computer that can't take what the thread has going is refused, in words that say why", () => {
    const thread = threadWith({ goal: goal("active") });
    const carry = threadMoveCarry(view, thread);
    const older = targetPreviewOf(target(peer({})), { thread, place, carry });
    expect(older.refusal).toBe(
      "Update Threadlines on Mac mini to move this thread: it has a goal.",
    );
    // Never as the code an older app reads as "set the project up there".
    expect(older.refusalCode).toBeUndefined();
    const current = targetPreviewOf(target(peer({ moveThreadState: true })), {
      thread,
      place,
      carry,
    });
    expect(current.refusal).toBeUndefined();
  });

  it("a thread another computer's agent started goes only home, and says so per computer (Part 3f, (h))", () => {
    const thread = threadWith({
      remoteOrigin: {
        linkDeviceId: "device-mac",
        environmentId: MAC_MINI,
        environmentPinned: true,
        environmentLabel: "Mac mini",
        threadId: ThreadId.make("thread-on-mac"),
        threadTitle: "Ship it",
      },
    });
    const carry = threadMoveCarry(view, thread);
    const third = targetPreviewOf(
      {
        environmentId: EnvironmentId.make("environment-linux"),
        label: "Linux box",
        described: Option.some(peer({ moveThreadState: true, moveLinkLineage: true })),
      },
      { thread, place, carry },
    );
    expect(third.refusal).toBe(
      "This thread was started by an agent on Mac mini, which still directs it. It can move back to Mac mini, not to another computer.",
    );
    expect(third.refusalCode).toBeUndefined();
    expect(
      targetPreviewOf(target(peer({ moveThreadState: true })), { thread, place, carry }).refusal,
    ).toBe(
      "Update Threadlines on Mac mini to move this thread: an agent on another computer started it.",
    );
    expect(
      targetPreviewOf(target(peer({ moveThreadState: true, moveLinkLineage: true })), {
        thread,
        place,
        carry,
      }).refusal,
    ).toBeUndefined();
    // Its manifest names home only to home.
    expect(linkLineageOf([thread], thread, MAC_MINI)).toEqual({
      home: { parentThreadId: "thread-on-mac" },
    });
    // A child that moved here alone names the thread it moved over from, so
    // home can land it under its parent before it heard that move landed.
    const movedHere = {
      ...thread,
      movedFrom: {
        environmentId: MAC_MINI,
        environmentPinned: true as const,
        label: "Mac mini",
        threadId: ThreadId.make("thread-left-on-mac"),
        movedAt: "2026-11-17T10:00:00.000Z",
      },
    };
    expect(linkLineageOf([movedHere], movedHere, MAC_MINI)).toEqual({
      home: { parentThreadId: "thread-on-mac", fromThreadId: "thread-left-on-mac" },
    });
    expect(
      linkLineageOf([thread], thread, EnvironmentId.make("environment-linux")),
    ).toBeUndefined();
  });

  it("a moved thread still fenced is offered only the computer it came from (Part 3f, (h))", () => {
    const movedFrom = {
      environmentId: MAC_MINI,
      environmentPinned: true as const,
      label: "Mac mini",
      threadId: ThreadId.make("thread-on-mac"),
      movedAt: "2026-11-17T10:00:00.000Z",
      fenced: true as const,
    };
    const thread = threadWith({ movedFrom });
    const carry = threadMoveCarry(view, thread);
    const described = peer({ moveThreadState: true, moveLinkLineage: true });
    const linux = {
      environmentId: EnvironmentId.make("environment-linux"),
      label: "Linux box",
      described: Option.some(described),
    };
    expect(targetPreviewOf(linux, { thread, place, carry }).refusal).toBe(
      "This thread moved here from Mac mini, and until you send it a message here it can only move back to Mac mini.",
    );
    expect(targetPreviewOf(target(described), { thread, place, carry }).refusal).toBeUndefined();
    // Over a link that never proved its computer, "back" is only the sender's
    // word: while fenced it goes nowhere.
    const { environmentPinned: _, ...unproven } = movedFrom;
    const unpinned = threadWith({ movedFrom: unproven });
    const unpinnedCarry = threadMoveCarry(view, unpinned);
    const unconfirmed =
      "This thread moved here from Mac mini, and this computer's link can't confirm which computer that is, so it stays here until you send it a message.";
    expect(
      targetPreviewOf(target(described), { thread: unpinned, place, carry: unpinnedCarry }).refusal,
    ).toBe(unconfirmed);
    expect(targetPreviewOf(linux, { thread: unpinned, place, carry: unpinnedCarry }).refusal).toBe(
      unconfirmed,
    );
  });

  it("a child moves alone only to a computer that keeps it its parent's (Part 3f, (h))", () => {
    const parent = threadWith({
      id: ThreadId.make("thread-parent"),
      title: "Ship it",
      deletedAt: null,
    });
    const child = threadWith({ parentThreadId: parent.id, attachedToParent: true });
    const carry = threadMoveCarry(view, child);
    expect(
      targetPreviewOf(target(peer({ moveThreadState: true, moveFamilies: true })), {
        thread: child,
        place,
        carry,
      }).aloneRefusal,
    ).toBe("Update Threadlines on Mac mini to move it without the thread that started it.");
    expect(
      targetPreviewOf(
        target(peer({ moveThreadState: true, moveFamilies: true, moveLinkLineage: true })),
        { thread: child, place, carry },
      ).aloneRefusal,
    ).toBeUndefined();
    expect(linkLineageOf([parent, child], child, MAC_MINI)).toEqual({
      remoteParent: { threadId: parent.id, title: "Ship it" },
    });
    // A parent whose own move is only queued waits for this one: still its parent there.
    const queued = { ...parent, pendingMove: { requestId: "request-parent" } } as never;
    expect(linkLineageOf([queued, child], child, MAC_MINI)).toEqual({
      remoteParent: { threadId: parent.id, title: "Ship it" },
    });
    // One frozen for its own move can't be reached from there: it arrives as its own thread.
    const frozen = { ...parent, move: { transferId: "transfer-parent" } } as never;
    expect(linkLineageOf([frozen, child], child, MAC_MINI)).toBeUndefined();
  });

  it("names only the threads it started on the target, each with the word given here (Part 3f, (g))", () => {
    const record = (environmentId: EnvironmentId, threadId: string, override?: unknown) => ({
      environmentId,
      label: "Mac mini",
      threadId: ThreadId.make(threadId),
      handle: "Agent",
      title: threadId,
      attachmentEpoch: 0,
      cachedStatus: "idle",
      updatedAt: "2026-11-17T10:00:00.000Z",
      ...(override !== undefined ? { override } : {}),
    });
    const wrapped = { state: "done", at: "2026-11-17T09:00:00.000Z" };
    const thread = threadWith({
      childRequests: {
        open: [],
        deliveryEpoch: 0,
        startsSinceUser: 0,
        sendsSinceUser: 0,
        pendingNotes: [],
        remoteChildren: [
          record(MAC_MINI, "thread-wrapped", wrapped),
          record(EnvironmentId.make("environment-linux"), "thread-on-linux"),
          record(MAC_MINI, "thread-plain"),
        ],
      },
    } as never);
    expect(startedThereOf(thread, MAC_MINI)).toEqual([
      { threadId: "thread-wrapped", override: wrapped },
      { threadId: "thread-plain" },
    ]);
  });

  it("warns per agent picked, in the server's words", () => {
    const thread = threadWith({
      goal: goal("active", 50_000),
      checkBacks: [
        {
          id: "cb-1",
          participantId: null,
          scheduledFor: "2026-11-17T14:32:00.000Z",
          exact: true,
          recurring: false,
          durable: false,
        },
      ],
      pullRequestAutoFix: true,
    });
    const preview = targetPreviewOf(target(peer({ moveThreadState: true })), {
      thread,
      place,
      carry: threadMoveCarry(view, thread),
      gitHubReady: new Map([[MAC_MINI, false]]),
      goalHoldsTurn: true,
    });
    expect(preview.notes).toEqual([
      { words: "GitHub isn't signed in on Mac mini. Sign in there before you turn auto-fix on." },
      {
        words:
          "Its goal arrives paused: Claude on Mac mini can't keep its token budget. Resume runs it without one.",
        instanceIds: ["mac-claude"],
      },
      {
        words: "Codex on Mac mini can't set check-backs. It's told once what was planned.",
        instanceIds: ["mac-codex"],
      },
      { words: "It's working toward its goal. Move when it's done waits until it gets there." },
    ]);
  });

  it("says what comes along, one line each", () => {
    const thread = threadWith({
      goal: goal("paused"),
      queuedFollowUps: [
        {
          messageId: MessageId.make("q-1"),
          text: "then this",
          attachments: [],
          runtimeMode: "auto",
          interactionMode: "default",
          createdAt: "2026-11-17T10:00:00.000Z",
        },
      ],
      linkedPullRequests: [
        { number: 212, url: "https://example.com/pull/212", autoFix: true, autoMerge: null },
      ],
    });
    expect(carryBringsWords(threadMoveCarry(view, thread))).toEqual([
      "Its goal arrives paused.",
      "Auto-fix for pull request #212 arrives off, for you to turn on there.",
      "1 queued message is sent there.",
    ]);
  });

  it("past 100 plans the oldest stay, the newest (with Implement) always comes, and it says so", () => {
    const plans = [...Array.from({ length: 102 }, (_, index) => plan(index)), plan(102, true)];
    const thread = threadWith({
      proposedPlans: plans,
      latestTurn: { turnId: TurnId.make("turn-last") } as OrchestrationThread["latestTurn"],
    });
    const carry = threadMoveCarry(view, thread);
    expect(carry.proposedPlans).toHaveLength(100);
    expect(carry.proposedPlans.at(-1)?.id).toBe("plan-102");
    expect(carry.plansLeftBehind).toBe(3);
    expect(carryBringsWords(carry)).toEqual([
      "The plan waits for you there.",
      "3 older plans stay on this computer.",
    ]);
    expect(moveThreadStateOf(carry)).toMatchObject({ plansLeftBehind: 3 });
  });

  it("a goal that finished is never picked up, whatever the move's stop recorded", () => {
    const thread = threadWith({
      goal: goal("complete"),
      move: { interrupted: { goalActive: true } } as OrchestrationThread["move"],
    });
    expect(moveThreadStateOf(threadMoveCarry(view, thread))?.goal).toMatchObject({
      status: "complete",
      pickUp: false,
    });
    const working = threadWith({
      goal: goal("paused"),
      move: { interrupted: { goalActive: true } } as OrchestrationThread["move"],
    });
    expect(moveThreadStateOf(threadMoveCarry(view, working))?.goal?.pickUp).toBe(true);
  });
  it("a batch row keeps the warnings that hold for the agent it moves with", () => {
    const thread = threadWith({
      modelSelection: claude,
      goal: goal("active", 50_000),
      pullRequestAutoFix: true,
    });
    const own = targetPreviewOf(target(peer({ moveThreadState: true })), {
      thread,
      place,
      carry: threadMoveCarry(view, thread),
      gitHubReady: new Map([[MAC_MINI, false]]),
    });
    // A batch moves it with the agent Mac mini suggests: its own Claude.
    expect(own.suggestedAgent?.instanceId).toBe("mac-claude");
    const row = previewManyThread(THREAD, { targets: [own] }, [own]);
    expect(row.targetLines).toEqual([
      {
        environmentId: MAC_MINI,
        notes: [
          {
            words: "GitHub isn't signed in on Mac mini. Sign in there before you turn auto-fix on.",
          },
          {
            words:
              "Its goal arrives paused: Claude on Mac mini can't keep its token budget. Resume runs it without one.",
          },
        ],
      },
    ]);
  });
});

describe("exportThreadHistory", () => {
  it("sends an agent's message still waiting in the queue as never sent", () => {
    const message = (id: string, text: string) => ({
      id: MessageId.make(id),
      role: "user" as const,
      text,
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const thread = {
      messages: [message("ran", "Fix it."), message("waiting", "Run the migration.")],
      activities: [],
      queuedFollowUps: [{ messageId: MessageId.make("waiting") }],
    } as unknown as OrchestrationThread;
    expect(
      exportThreadHistory(thread).messages.map((entry) => [entry.text, entry.notSent ?? false]),
    ).toEqual([
      ["Fix it.", false],
      ["Run the migration.", true],
    ]);
  });
});

describe("how far a room agent's own session got (Part 3f, (i))", () => {
  const SOL = "6f1d7c2a-1b2c-4d3e-8f90-0a1b2c3d4e5f";
  const message = (id: string, sequence: number, participantId?: string, role = "assistant") => ({
    id,
    eventSequence: sequence,
    role,
    participantId,
  });
  const thread = (roomContext?: Record<string, { throughSequence: number }>) =>
    ({
      messages: [
        message("m1", 1, undefined, "user"),
        message("m2", 2, SOL),
        message("m3", 3),
        message("m4", 4, undefined, "user"),
      ],
      ...(roomContext !== undefined ? { roomContext } : {}),
    }) as never;
  const moved = new Set(["m1", "m2", "m3", "m4"]);

  it("is its room context cursor when it has one, else its own last reply, never the room's last", () => {
    expect(seenThroughOf(thread({ [SOL]: { throughSequence: 1 } }), SOL as never, moved)).toBe(
      "m1",
    );
    expect(seenThroughOf(thread(), SOL as never, moved)).toBe("m2");
    expect(seenThroughOf(thread(), null, moved)).toBe("m3");
    expect(seenThroughOf(thread(), SOL as never, new Set(["m1"]))).toBeUndefined();
  });
});
