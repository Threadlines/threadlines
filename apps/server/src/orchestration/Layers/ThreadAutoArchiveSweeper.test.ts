import {
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import {
  type AutoArchiveInactiveThreadsDays,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
} from "@threadlines/contracts/settings";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadAutoArchiveSweeper } from "../Services/ThreadAutoArchiveSweeper.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { makeThreadAutoArchiveSweeperLive } from "./ThreadAutoArchiveSweeper.ts";

const NOW_MS = Date.now();
const PROJECT_ID = ProjectId.make("project-thread-auto-archive");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60 * 1_000).toISOString();
}

function thread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    latestTurn: null,
    createdAt: daysAgo(45),
    updatedAt: daysAgo(45),
    archivedAt: null,
    pinnedAt: null,
    doneOverride: null,
    lastSeenAt: null,
    session: null,
    latestUserMessageAt: daysAgo(45),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    cumulativeDiffStat: null,
    diffStatBaselineTurnCount: 0,
    ...overrides,
  };
}

function runningSession(threadId: ThreadId): OrchestrationSession {
  return {
    threadId,
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    pendingBackgroundTaskCount: 0,
    lastError: null,
    updatedAt: daysAgo(45),
  };
}

function makeSnapshotQuery(
  threads: readonly OrchestrationThreadShell[],
): ProjectionSnapshotQueryShape {
  const shellSnapshot = {
    snapshotSequence: 1,
    projects: [],
    threads: [...threads],
    updatedAt: new Date(NOW_MS).toISOString(),
  };
  return {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.succeed(shellSnapshot),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    listThreadDiffStatBaselines: () => Effect.succeed([]),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
  };
}

describe("ThreadAutoArchiveSweeper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ThreadAutoArchiveSweeper, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly inactiveDays: AutoArchiveInactiveThreadsDays;
    readonly threads: readonly OrchestrationThreadShell[];
    readonly failingThreadIds?: ReadonlySet<ThreadId>;
    readonly settingsShape?: ServerSettingsShape;
  }) {
    const dispatched: Array<Extract<OrchestrationCommand, { type: "thread.archive" }>> = [];
    let onDispatch: (() => void) | null = null;
    // Bounded so a regression that never dispatches fails in seconds instead
    // of hanging until the suite-wide timeout.
    const nextDispatch = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no archive dispatched")), 5_000);
        onDispatch = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    const orchestrationEngine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => {
        if (command.type !== "thread.archive") {
          return Effect.die(`Unexpected command: ${command.type}`);
        }
        return Effect.sync(() => {
          dispatched.push(command);
          onDispatch?.();
        }).pipe(
          Effect.andThen(
            input.failingThreadIds?.has(command.threadId) === true
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "test dispatch failure",
                  }),
                )
              : Effect.succeed({ sequence: dispatched.length }),
          ),
        );
      },
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    };
    const layer = makeThreadAutoArchiveSweeperLive({ sweepIntervalMs: 60_000 }).pipe(
      Layer.provideMerge(
        input.settingsShape === undefined
          ? ServerSettingsService.layerTest({
              autoArchiveInactiveThreadsDays: input.inactiveDays,
            })
          : Layer.succeed(ServerSettingsService, input.settingsShape),
      ),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, makeSnapshotQuery(input.threads))),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    );
    runtime = ManagedRuntime.make(layer);
    const sweeper = await runtime.runPromise(Effect.service(ThreadAutoArchiveSweeper));
    return { dispatched, nextDispatch, sweeper };
  }

  it("archives nothing when disabled", async () => {
    const { dispatched, sweeper } = await createHarness({
      inactiveDays: 0,
      threads: [thread("inactive")],
    });

    expect(await runtime!.runPromise(sweeper.sweepNow())).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("archives an inactive unprotected thread", async () => {
    const candidate = thread("inactive");
    const { dispatched, sweeper } = await createHarness({
      inactiveDays: 30,
      threads: [candidate],
    });

    expect(await runtime!.runPromise(sweeper.sweepNow())).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({
      type: "thread.archive",
      commandId: expect.stringContaining(`thread-auto-archive:${candidate.id}:`),
      threadId: candidate.id,
    });
  });

  it("does not archive protected or recently active threads", async () => {
    const running = thread("running");
    const { dispatched, sweeper } = await createHarness({
      inactiveDays: 30,
      threads: [
        thread("pinned", { pinnedAt: daysAgo(40) }),
        { ...running, session: runningSession(running.id) },
        thread("approval", { hasPendingApprovals: true }),
        thread("recent", { updatedAt: daysAgo(2) }),
      ],
    });

    expect(await runtime!.runPromise(sweeper.sweepNow())).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("sweeps as soon as the retention setting turns on", async () => {
    const candidate = thread("inactive");
    const enabled: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      autoArchiveInactiveThreadsDays: 30,
    };
    // Starts disabled, so only the settings change can produce this archive.
    // `getSettings` follows the stream the way the real service does: the
    // current value is updated before subscribers see the change event.
    let current: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const settingsShape: ServerSettingsShape = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.sync(() => current),
      updateSettings: () => Effect.die("unused"),
      streamChanges: Stream.make(enabled).pipe(
        Stream.tap((settings) =>
          Effect.sync(() => {
            current = settings;
          }),
        ),
      ),
    };
    const { dispatched, nextDispatch, sweeper } = await createHarness({
      inactiveDays: 0,
      threads: [candidate],
      settingsShape,
    });

    const scope = await runtime!.runPromise(Scope.make("sequential"));
    try {
      const archived = nextDispatch();
      await runtime!.runPromise(sweeper.start().pipe(Scope.provide(scope)));
      await archived;
      expect(dispatched.map((command) => command.threadId)).toEqual([candidate.id]);
    } finally {
      await runtime!.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("continues archiving after one dispatch fails", async () => {
    const failing = thread("failing");
    const remaining = thread("remaining");
    const { dispatched, sweeper } = await createHarness({
      inactiveDays: 30,
      threads: [failing, remaining],
      failingThreadIds: new Set([failing.id]),
    });

    expect(await runtime!.runPromise(sweeper.sweepNow())).toBe(1);
    expect(dispatched.map((command) => command.threadId)).toEqual([failing.id, remaining.id]);
  });
});
