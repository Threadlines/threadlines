import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationThread,
  type PeerDescriptor,
  type PeerMoveState,
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
