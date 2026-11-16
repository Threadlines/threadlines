import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationThread,
  type PeerDescriptor,
  type PeerMoveState,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadMovePreview,
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
import { MOVE_MAX_BYTES, nativeSessionFits } from "./moveExport.ts";
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
    expect(checkMoveTarget(shown({ suggestedAgent: claude }), MAC_MINI, undefined)).toMatchObject({
      agent: claude,
    });
    expect(checkMoveTarget(shown({ suggestedAgent: claude }), MAC_MINI, codex)).toMatchObject({
      agent: codex,
    });
  });

  it("can't go when the target suggests none and none is named", () => {
    expect(checkMoveTarget(shown({}), MAC_MINI, undefined)).toEqual({
      refusal: "Mac mini has no agent ready.",
    });
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
