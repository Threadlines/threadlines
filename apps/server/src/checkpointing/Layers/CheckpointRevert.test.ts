import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  type OrchestrationThread,
  ProjectId,
  ThreadCheckoutMovedActivityKind,
  type ThreadCheckoutMovedPayload,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { CheckpointRevert } from "../Services/CheckpointRevert.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { makeCheckpointStoreStub } from "../testing/CheckpointStoreStub.ts";
import type { VcsCheckpointCheckout } from "../../vcs/VcsDriver.ts";
import { checkpointPreTurnRefForThreadTurnCount, checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointRevertLive } from "./CheckpointRevert.ts";

const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-reviewer");
const CODER = ThreadId.make("thread-coder");

// A folder that reads as a git checkout: the revert only looks for `.git`.
const worktree = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "threadlines-revert-"));
NodeFs.mkdirSync(NodePath.join(worktree, ".git"));
afterAll(() => NodeFs.rmSync(worktree, { recursive: true, force: true }));

/** A thread alone in its worktree, three checkpointed turns in. */
const thread = (overrides: Partial<OrchestrationThread> = {}) =>
  ({
    id: THREAD,
    projectId: PROJECT,
    worktreePath: worktree,
    activities: [],
    checkpoints: [1, 2, 3].map((turnCount) => ({
      turnId: TurnId.make(`turn-${turnCount}`),
      checkpointTurnCount: turnCount,
      checkpointRef: checkpointRefForThreadTurn(THREAD, turnCount),
    })),
    ...overrides,
  }) as unknown as OrchestrationThread;

/** A turn's completion snapshot, and the one taken right before it started. */
const done = (turn: number) => checkpointRefForThreadTurn(THREAD, turn);
const start = (turn: number) => checkpointPreTurnRefForThreadTurnCount(THREAD, turn);

/** Every snapshot of these turns, as taken in the folder the thread has since left. */
const leftBehind = (...turns: ReadonlyArray<number>) =>
  Object.fromEntries(
    turns.flatMap((turn) => [
      [done(turn), "elsewhere"],
      [start(turn), "elsewhere"],
    ]),
  ) as Record<string, VcsCheckpointCheckout>;

/**
 * Where a revert to `turnCount` would work, and how, for a thread no one else
 * is near. `takenIn` says where a snapshot was taken; any other one was taken
 * here, in a thread whose snapshots all record their checkout.
 */
const resolve = (
  subject: OrchestrationThread,
  turnCount: number,
  takenIn: Record<string, VcsCheckpointCheckout> | "unrecorded" = {},
) =>
  Effect.gen(function* () {
    const revert = yield* CheckpointRevert;
    return yield* revert.resolveContext({ threadId: THREAD, turnCount });
  }).pipe(
    Effect.provide(
      CheckpointRevertLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              CheckpointStore,
              makeCheckpointStoreStub({
                checkpointCheckouts: (input) =>
                  Effect.succeed(
                    input.checkpointRefs.map((ref) =>
                      takenIn === "unrecorded"
                        ? "unknown"
                        : (takenIn[ref] ??
                          // The older per-turn-id refs don't exist on these threads.
                          (ref.includes("pre-turn/") ? "unknown" : "here")),
                    ),
                  ),
              }),
            ),
            Layer.succeed(ProjectionSnapshotQuery, {
              getThreadDetailById: () => Effect.succeed(Option.some(subject)),
              getProjectShellById: () =>
                Effect.succeed(Option.some({ id: PROJECT, workspaceRoot: "/repo" })),
              getShellSnapshot: () => Effect.succeed({ threads: [subject] }),
            } as unknown as ProjectionSnapshotQueryShape),
            Layer.succeed(ProviderService, {
              listSessions: () => Effect.succeed([]),
            } as unknown as ProviderServiceShape),
          ),
        ),
      ),
    ),
    Effect.runPromise,
  );

const movedSince = {
  kind: "unavailable",
  detail: expect.stringContaining("moved to another checkout"),
};

describe("CheckpointRevert.resolveContext", () => {
  it("restores the whole folder only for a thread whose worktree is its own", async () => {
    expect(await resolve(thread(), 1)).toMatchObject({
      kind: "ready",
      context: { mode: "workspace", targetCheckpointRef: done(1) },
    });
    // A guest in another thread's worktree never does, even with that thread
    // gone and nothing else pointing at the folder.
    const guest = thread({ worktreeOrigin: { kind: "thread", threadId: CODER } });
    expect(await resolve(guest, 1)).toMatchObject({
      kind: "ready",
      context: { mode: "selective" },
    });
  });

  it("never undoes a turn whose snapshots were taken in another checkout", async () => {
    // Turns one and two ran in the folder the thread has since left.
    expect(await resolve(thread(), 1, leftBehind(1, 2))).toMatchObject(movedSince);
    expect(await resolve(thread(), 0, leftBehind(1, 2))).toMatchObject(movedSince);
    // A starting snapshot left over from the other folder spoils its turn too.
    expect(await resolve(thread(), 2, { [start(3)]: "elsewhere" })).toMatchObject(movedSince);
  });

  it("undoes everything since the move from this folder's own snapshot, never the other folder's", async () => {
    // Turn three is the only one that ran here. Reverting to turn two would
    // restore from turn two's snapshot, which holds the other folder's files:
    // the files come from this folder as it was right before turn three.
    expect(await resolve(thread(), 2, leftBehind(1, 2))).toMatchObject({
      kind: "ready",
      context: { targetCheckpointRef: start(3) },
    });
    // With no snapshot of this folder from before that turn, nothing is safe to restore from.
    expect(
      await resolve(thread(), 2, { ...leftBehind(1, 2), [start(3)]: "unknown" }),
    ).toMatchObject(movedSince);
    // And reverting to the newest turn undoes nothing, so there is no such snapshot at all.
    expect(await resolve(thread(), 3, leftBehind(3))).toMatchObject(movedSince);
  });

  it("falls back to the move on the thread's record only for snapshots that don't say where they were taken", async () => {
    const moved = thread({
      worktreeOrigin: { kind: "thread", threadId: CODER },
      activities: [
        {
          kind: ThreadCheckoutMovedActivityKind,
          payload: {
            ownerThreadId: CODER,
            ownerTitle: "Build the retry",
            fromWorktreePath: null,
            toWorktreePath: worktree,
            turnCount: 2,
          } satisfies ThreadCheckoutMovedPayload,
        },
      ] as never,
    });
    // Older snapshots: turns one and two changed the folder it left.
    expect(await resolve(moved, 1, "unrecorded")).toMatchObject(movedSince);
    expect((await resolve(moved, 2, "unrecorded")).kind).toBe("ready");
    // Snapshots that all say "here" outrank the record: it moved away and came back.
    expect((await resolve(moved, 1)).kind).toBe("ready");
  });
});
