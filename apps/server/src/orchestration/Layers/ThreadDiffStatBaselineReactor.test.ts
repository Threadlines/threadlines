import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type VcsStatusLocalResult,
} from "@threadlines/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
  type ProjectionThreadDiffStatBaseline,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDiffStatBaselineReactor } from "../Services/ThreadDiffStatBaselineReactor.ts";
import {
  VcsStatusBroadcaster,
  type VcsLocalStatusObservation,
  type VcsStatusBroadcasterShape,
} from "../../vcs/VcsStatusBroadcaster.ts";
import { ThreadDiffStatBaselineReactorLive } from "./ThreadDiffStatBaselineReactor.ts";

const PROJECT_ID = ProjectId.make("project-diffstat-baseline");
const PROJECT_CWD = "C:\\repos\\project";

function baseline(
  overrides: Partial<ProjectionThreadDiffStatBaseline> = {},
): ProjectionThreadDiffStatBaseline {
  return {
    threadId: ThreadId.make("thread-1"),
    projectId: PROJECT_ID,
    workspaceRoot: PROJECT_CWD,
    worktreePath: null,
    effectiveCwd: null,
    baselineTurnCount: 0,
    latestCompletedCheckpointTurnCount: 3,
    ...overrides,
  };
}

function localStatus(overrides: Partial<VcsStatusLocalResult> = {}): VcsStatusLocalResult {
  return {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    ...overrides,
  };
}

function makeSnapshotQuery(
  baselines: () => ReadonlyArray<ProjectionThreadDiffStatBaseline>,
): ProjectionSnapshotQueryShape {
  return {
    getProjectCatalog: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    listThreadDiffStatBaselines: () => Effect.sync(() => baselines()),
    listThreadTurnOverlapsSince: () => Effect.succeed([]),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
  };
}

type RebaseCommand = Extract<OrchestrationCommand, { type: "thread.diffstat.rebase" }>;

describe("ThreadDiffStatBaselineReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ThreadDiffStatBaselineReactor, never> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  /**
   * Feeds a fixed set of observations through the reactor and returns the
   * rebase commands it dispatched. The observation stream is finite and the
   * harness waits for it to drain, so no test depends on timing.
   */
  async function observe(input: {
    readonly observations: ReadonlyArray<VcsLocalStatusObservation>;
    readonly baselines: () => ReadonlyArray<ProjectionThreadDiffStatBaseline>;
  }): Promise<ReadonlyArray<RebaseCommand>> {
    const dispatched: RebaseCommand[] = [];
    const streamDone = await Effect.runPromise(Deferred.make<void>());

    const orchestrationEngine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => {
        if (command.type !== "thread.diffstat.rebase") {
          return Effect.die(`Unexpected command: ${command.type}`);
        }
        return Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        });
      },
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    };

    const vcsStatusBroadcaster: VcsStatusBroadcasterShape = {
      getStatus: () => Effect.die("unused"),
      refreshLocalStatus: () => Effect.die("unused"),
      refreshStatus: () => Effect.die("unused"),
      streamStatus: () => Stream.empty,
      observeLocalStatus: () =>
        Stream.fromIterable(input.observations).pipe(
          Stream.ensuring(Deferred.succeed(streamDone, undefined)),
        ),
      observeMissingCheckouts: () => Stream.empty,
    };

    const layer = ThreadDiffStatBaselineReactorLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, makeSnapshotQuery(input.baselines)),
      ),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(VcsStatusBroadcaster, vcsStatusBroadcaster)),
    );
    runtime = ManagedRuntime.make(layer);
    const reactor = await runtime.runPromise(Effect.service(ThreadDiffStatBaselineReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));

    await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(Deferred.await(streamDone));
    await runtime.runPromise(reactor.drain);

    return dispatched;
  }

  it("rebases a thread when its checkout is observed clean", async () => {
    const dispatched = await observe({
      observations: [{ cwd: PROJECT_CWD, local: localStatus() }],
      baselines: () => [baseline()],
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.diffstat.rebase",
      threadId: ThreadId.make("thread-1"),
      baselineTurnCount: 3,
    });
  });

  // The dedupe that matters: the checkout is polled every couple of minutes and
  // usually has not changed. Only the observation that outruns the stored
  // baseline may append an event.
  it("does not rebase again while a clean checkout stays clean", async () => {
    let baselineTurnCount = 0;
    const dispatched = await observe({
      observations: [
        { cwd: PROJECT_CWD, local: localStatus() },
        { cwd: PROJECT_CWD, local: localStatus() },
        { cwd: PROJECT_CWD, local: localStatus() },
      ],
      // Stands in for the projection catching up after the first rebase.
      baselines: () => [baseline({ baselineTurnCount: baselineTurnCount++ === 0 ? 0 : 3 })],
    });

    expect(dispatched).toHaveLength(1);
  });

  it("leaves a dirty checkout alone", async () => {
    const dispatched = await observe({
      observations: [
        { cwd: PROJECT_CWD, local: localStatus({ hasWorkingTreeChanges: true }) },
        { cwd: PROJECT_CWD, local: localStatus({ isRepo: false }) },
      ],
      baselines: () => [baseline()],
    });

    expect(dispatched).toEqual([]);
  });

  it("skips a thread with no completed turn to rebase to", async () => {
    const dispatched = await observe({
      observations: [{ cwd: PROJECT_CWD, local: localStatus() }],
      baselines: () => [baseline({ latestCompletedCheckpointTurnCount: null })],
    });

    expect(dispatched).toEqual([]);
  });

  it("matches a worktree thread by normalized path and leaves other checkouts alone", async () => {
    const worktreeThread = ThreadId.make("thread-worktree");
    const dispatched = await observe({
      // Separators and case differ from the stored worktree path, which is
      // routine on win32 once a path has been through realpath.
      observations: [{ cwd: "c:/repos/worktrees/feature", local: localStatus() }],
      baselines: () => [
        baseline({
          threadId: worktreeThread,
          worktreePath: "C:\\repos\\worktrees\\Feature\\",
          latestCompletedCheckpointTurnCount: 5,
        }),
        baseline({ threadId: ThreadId.make("thread-elsewhere") }),
      ],
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      threadId: worktreeThread,
      baselineTurnCount: 5,
    });
  });

  // The observed cwd wins over the configured checkout, matching the precedence
  // the workspace surfaces use, so a thread whose agent moved into a worktree
  // resets on that worktree's commit rather than the project root's.
  it("follows a thread's observed working directory over its project root", async () => {
    const dispatched = await observe({
      observations: [{ cwd: PROJECT_CWD, local: localStatus() }],
      baselines: () => [baseline({ effectiveCwd: "C:\\repos\\somewhere-else" })],
    });

    expect(dispatched).toEqual([]);
  });
});
