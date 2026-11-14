import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  type OrchestrationThread,
  ProjectId,
  ThreadCheckoutMovedActivityKind,
  type ThreadCheckoutMovedPayload,
  ThreadId,
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
import { checkpointRefForThreadTurn } from "../Utils.ts";
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
      checkpointTurnCount: turnCount,
      checkpointRef: checkpointRefForThreadTurn(THREAD, turnCount),
    })),
    ...overrides,
  }) as unknown as OrchestrationThread;

/** Where a revert to `turnCount` would work, and how, for a thread no one else is near. */
const resolve = (subject: OrchestrationThread, turnCount: number) =>
  Effect.gen(function* () {
    const revert = yield* CheckpointRevert;
    return yield* revert.resolveContext({ threadId: THREAD, turnCount });
  }).pipe(
    Effect.provide(
      CheckpointRevertLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CheckpointStore, makeCheckpointStoreStub()),
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

describe("CheckpointRevert.resolveContext", () => {
  it("restores the whole folder only for a thread whose worktree is its own", async () => {
    expect(await resolve(thread(), 1)).toMatchObject({
      kind: "ready",
      context: { mode: "workspace" },
    });
    // A guest in another thread's worktree never does, even with that thread
    // gone and nothing else pointing at the folder.
    const guest = thread({ worktreeOrigin: { kind: "thread", threadId: CODER } });
    expect(await resolve(guest, 1)).toMatchObject({
      kind: "ready",
      context: { mode: "selective" },
    });
  });

  it("never reaches back past the point an agent moved the thread into another checkout", async () => {
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
    // Turns one and two changed the folder it left.
    const before = await resolve(moved, 1);
    expect(before.kind).toBe("unavailable");
    expect(before).toMatchObject({
      detail: expect.stringContaining("moved into another checkout"),
    });
    // Undoing only what it did since the move stays possible.
    expect((await resolve(moved, 2)).kind).toBe("ready");
  });
});
