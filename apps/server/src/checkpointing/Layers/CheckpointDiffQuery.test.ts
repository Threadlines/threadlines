import {
  CheckpointRef,
  type OrchestrationCheckpointFile,
  ProjectId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  checkpointPreTurnRefForThreadTurn,
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
} from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { makeCheckpointStoreStub } from "../testing/CheckpointStoreStub.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly turnId?: TurnId;
  readonly files?: ReadonlyArray<OrchestrationCheckpointFile>;
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: input.turnId ?? TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: input.files ?? [
          {
            path: "README.md",
            kind: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("CheckpointDiffQueryLive", () => {
  it("scopes all-turns diffs to the thread's attributed paths via the narrow context lookup", async () => {
    const projectId = ProjectId.make("project-full-thread");
    const threadId = ThreadId.make("thread-full-thread");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 4);
    let getThreadCheckpointContextCalls = 0;
    let getFullThreadDiffContextCalls = 0;
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
      readonly filePaths: ReadonlyArray<string> | undefined;
    }> = [];

    const checkpointStore = makeCheckpointStoreStub({
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace, filePaths }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
            filePaths,
          });
          return "full thread diff patch";
        }),
    });

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getProjectCatalog: () => Effect.die("unused"),
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          listRunningWorkflowRuns: () => Effect.succeed([]),
          listArchivedThreadsLiveState: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          isProjectPhoneAlertsMuted: () => Effect.succeed(false),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () =>
            Effect.sync(() => {
              getThreadCheckpointContextCalls += 1;
              return Option.none();
            }),
          getFullThreadDiffContext: () =>
            Effect.sync(() => {
              getFullThreadDiffContextCalls += 1;
              return Option.some({
                threadId,
                projectId,
                workspaceRoot: "/tmp/workspace",
                worktreePath: "/tmp/worktree",
                latestCheckpointTurnCount: 4,
                toCheckpointRef,
                attributedFilePaths: ["src/app.ts", "src\\win.ts", "src/win.ts"],
              });
            }),
          listThreadDiffStatBaselines: () => Effect.die("unused"),
          listThreadTurnOverlapsSince: () => Effect.die("unused"),
          listThreadIdsWithOpenAgentRequests: () => Effect.die("unused"),
          listClaimedSettingsChanges: () => Effect.die("unused"),
          listThreadShells: () => Effect.succeed([]),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getTurnActivities: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(getThreadCheckpointContextCalls).toBe(0);
    expect(getFullThreadDiffContextCalls).toBe(1);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/worktree",
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
        toCheckpointRef,
        ignoreWhitespace: true,
        filePaths: ["src/app.ts", "src/win.ts"],
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 4,
      diff: "full thread diff patch",
    });
  });

  it("computes diffs using canonical turn-0 checkpoint refs", async () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
      readonly filePaths: ReadonlyArray<string> | undefined;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore = makeCheckpointStoreStub({
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace, filePaths }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
            filePaths,
          });
          return "diff patch";
        }),
    });

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getProjectCatalog: () => Effect.die("unused"),
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          listRunningWorkflowRuns: () => Effect.succeed([]),
          listArchivedThreadsLiveState: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          isProjectPhoneAlertsMuted: () => Effect.succeed(false),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          listThreadDiffStatBaselines: () => Effect.die("unused"),
          listThreadTurnOverlapsSince: () => Effect.die("unused"),
          listThreadIdsWithOpenAgentRequests: () => Effect.die("unused"),
          listClaimedSettingsChanges: () => Effect.die("unused"),
          listThreadShells: () => Effect.succeed([]),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getTurnActivities: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
        ignoreWhitespace: true,
        filePaths: ["README.md"],
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("uses the per-turn pre-state ref for single-turn diffs when it exists", async () => {
    const projectId = ProjectId.make("project-pre-turn-diff");
    const threadId = ThreadId.make("thread-pre-turn-diff");
    const turnId = TurnId.make("turn-pre-turn-diff");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
    const preTurnCheckpointRef = checkpointPreTurnRefForThreadTurn(threadId, turnId);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const threadCheckpointContext = {
      ...makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: "/tmp/worktree",
        checkpointTurnCount: 2,
        checkpointRef: toCheckpointRef,
        turnId,
      }),
      checkpoints: [
        {
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          status: "ready" as const,
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          turnId,
          checkpointTurnCount: 2,
          checkpointRef: toCheckpointRef,
          status: "ready" as const,
          files: [
            {
              path: "src/pre-turn.ts",
              kind: "modified",
              additions: 1,
              deletions: 0,
            },
          ],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    };

    const checkpointStore = makeCheckpointStoreStub({
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.succeed(checkpointRef === preTurnCheckpointRef),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
          });
          return "pre-turn diff patch";
        }),
    });

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getProjectCatalog: () => Effect.die("unused"),
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          listRunningWorkflowRuns: () => Effect.succeed([]),
          listArchivedThreadsLiveState: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          isProjectPhoneAlertsMuted: () => Effect.succeed(false),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          listThreadDiffStatBaselines: () => Effect.die("unused"),
          listThreadTurnOverlapsSince: () => Effect.die("unused"),
          listThreadIdsWithOpenAgentRequests: () => Effect.die("unused"),
          listClaimedSettingsChanges: () => Effect.die("unused"),
          listThreadShells: () => Effect.succeed([]),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getTurnActivities: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 1,
          toTurnCount: 2,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/worktree",
        fromCheckpointRef: preTurnCheckpointRef,
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result.diff).toBe("pre-turn diff patch");
  });

  it("defaults to hide whitespace changes", async () => {
    const projectId = ProjectId.make("project-default-whitespace");
    const threadId = ThreadId.make("thread-default-whitespace");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore = makeCheckpointStoreStub({
      hasCheckpointRef: () => Effect.succeed(true),
      diffCheckpoints: ({ ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ ignoreWhitespace });
          return "diff patch";
        }),
    });

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getProjectCatalog: () => Effect.die("unused"),
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          listRunningWorkflowRuns: () => Effect.succeed([]),
          listArchivedThreadsLiveState: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          isProjectPhoneAlertsMuted: () => Effect.succeed(false),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          listThreadDiffStatBaselines: () => Effect.die("unused"),
          listThreadTurnOverlapsSince: () => Effect.die("unused"),
          listThreadIdsWithOpenAgentRequests: () => Effect.die("unused"),
          listClaimedSettingsChanges: () => Effect.die("unused"),
          listThreadShells: () => Effect.succeed([]),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getTurnActivities: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
  });

  it("falls back to checkpoint-chain refs when no per-turn pre-state ref exists", async () => {
    const projectId = ProjectId.make("project-no-preflight");
    const threadId = ThreadId.make("thread-no-preflight");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const hasCheckpointRefCalls: CheckpointRef[] = [];
    const diffCheckpointsCalls: CheckpointRef[] = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore = makeCheckpointStoreStub({
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.sync(() => {
          hasCheckpointRefCalls.push(checkpointRef);
          return false;
        }),
      diffCheckpoints: ({ fromCheckpointRef }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push(fromCheckpointRef);
          return "diff patch";
        }),
    });

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getProjectCatalog: () => Effect.die("unused"),
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          listRunningWorkflowRuns: () => Effect.succeed([]),
          listArchivedThreadsLiveState: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          isProjectPhoneAlertsMuted: () => Effect.succeed(false),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          listThreadDiffStatBaselines: () => Effect.die("unused"),
          listThreadTurnOverlapsSince: () => Effect.die("unused"),
          listThreadIdsWithOpenAgentRequests: () => Effect.die("unused"),
          listClaimedSettingsChanges: () => Effect.die("unused"),
          listThreadShells: () => Effect.succeed([]),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getTurnActivities: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(hasCheckpointRefCalls).toEqual([
      checkpointPreTurnRefForThreadTurnCount(threadId, 1),
      checkpointPreTurnRefForThreadTurn(threadId, TurnId.make("turn-1")),
    ]);
    expect(diffCheckpointsCalls).toEqual([checkpointRefForThreadTurn(threadId, 0)]);
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.make("thread-missing");

    const checkpointStore = makeCheckpointStoreStub({
      hasCheckpointRef: () => Effect.succeed(true),
    });

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getProjectCatalog: () => Effect.die("unused"),
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          listRunningWorkflowRuns: () => Effect.succeed([]),
          listArchivedThreadsLiveState: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          isProjectPhoneAlertsMuted: () => Effect.succeed(false),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          listThreadDiffStatBaselines: () => Effect.die("unused"),
          listThreadTurnOverlapsSince: () => Effect.die("unused"),
          listThreadIdsWithOpenAgentRequests: () => Effect.die("unused"),
          listClaimedSettingsChanges: () => Effect.die("unused"),
          listThreadShells: () => Effect.succeed([]),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getTurnActivities: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});

describe("CheckpointDiffQueryLive.getTurnFile", () => {
  const projectId = ProjectId.make("project-turn-file");
  const threadId = ThreadId.make("thread-turn-file");
  const turnId = TurnId.make("turn-turn-file-1");
  const turnOneRef = checkpointRefForThreadTurn(threadId, 1);
  const context: ProjectionThreadCheckpointContext = {
    threadId,
    projectId,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    checkpoints: [
      {
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: turnOneRef,
        status: "ready",
        files: [
          { path: "art/hero.png", kind: "modified", additions: 0, deletions: 0 },
          {
            path: "art/renamed.png",
            kind: "modified",
            additions: 0,
            deletions: 0,
            previousPath: "art/original.png",
          },
        ],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  const readTurnFile = (input: {
    readonly range:
      | { readonly kind: "turn"; readonly turnCount: number }
      | {
          readonly kind: "thread";
          readonly toTurnCount: number;
        };
    readonly side: "before" | "after";
    readonly path: string;
    readonly previousPath?: string;
  }) => {
    const reads: Array<{ readonly revision: string; readonly path: string }> = [];
    const checkpointStore = makeCheckpointStoreStub({
      // The snapshot taken just before turn 1 ran exists, as it does for any
      // turn recorded since pre-turn snapshots were kept.
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.succeed(checkpointRef === checkpointPreTurnRefForThreadTurnCount(threadId, 1)),
      readRevisionFile: ({ revision, path }) =>
        Effect.sync(() => {
          reads.push({ revision, path });
          return { kind: "file" as const, base64: "iVBORw==", size: 4 };
        }),
    });
    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
        }),
      ),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnFile({
          threadId,
          range: input.range as never,
          side: input.side,
          path: input.path,
          ...(input.previousPath ? { previousPath: input.previousPath } : {}),
        });
      }).pipe(Effect.provide(layer)),
    ).then((result) => ({ result, reads }));
  };

  it("reads each side from the snapshots the Diff tab compares for that view", async () => {
    // One turn's own change starts at the snapshot taken just before it ran...
    const turnBefore = await readTurnFile({
      range: { kind: "turn", turnCount: 1 },
      side: "before",
      path: "art/hero.png",
    });
    expect(turnBefore.reads).toEqual([
      { revision: checkpointPreTurnRefForThreadTurnCount(threadId, 1), path: "art/hero.png" },
    ]);
    expect(turnBefore.result).toEqual({
      kind: "image",
      relativePath: "art/hero.png",
      mimeType: "image/png",
      base64: "iVBORw==",
      size: 4,
    });

    // ...while "All chat changes" starts where the thread began, even over the
    // same single turn.
    const threadBefore = await readTurnFile({
      range: { kind: "thread", toTurnCount: 1 },
      side: "before",
      path: "art/hero.png",
    });
    expect(threadBefore.reads).toEqual([
      { revision: checkpointRefForThreadTurn(threadId, 0), path: "art/hero.png" },
    ]);

    const after = await readTurnFile({
      range: { kind: "turn", turnCount: 1 },
      side: "after",
      path: "art/hero.png",
    });
    expect(after.reads).toEqual([{ revision: turnOneRef, path: "art/hero.png" }]);
  });

  it("reads a renamed picture's Before under its old name", async () => {
    const { reads, result } = await readTurnFile({
      range: { kind: "turn", turnCount: 1 },
      side: "before",
      path: "art/renamed.png",
    });
    expect(reads).toEqual([
      {
        revision: checkpointPreTurnRefForThreadTurnCount(threadId, 1),
        path: "art/original.png",
      },
    ]);
    expect(result).toMatchObject({ kind: "image", relativePath: "art/renamed.png" });
  });

  it("takes the patch's old name for a rename its records predate", async () => {
    // hero.png's record has no previousPath, as turns recorded before renames
    // were kept don't; the Diff tab passes the name its patch shows.
    const { reads } = await readTurnFile({
      range: { kind: "turn", turnCount: 1 },
      side: "before",
      path: "art/hero.png",
      previousPath: "art/hero-old.png",
    });
    expect(reads).toEqual([
      {
        revision: checkpointPreTurnRefForThreadTurnCount(threadId, 1),
        path: "art/hero-old.png",
      },
    ]);
  });

  it("never reads a file the range's turns did not change", async () => {
    const { reads, result } = await readTurnFile({
      range: { kind: "turn", turnCount: 1 },
      side: "after",
      path: ".env",
    });
    expect(reads).toEqual([]);
    expect(result).toEqual({ kind: "missing", relativePath: ".env" });
  });
});
