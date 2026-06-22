import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
} from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      pinnedAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      messages: [],
      session: thread.session,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

function makeProviderSession(input: {
  readonly threadId: ThreadId;
  readonly provider?: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly status?: ProviderSession["status"];
  readonly activeTurnId?: TurnId;
  readonly updatedAt?: string;
}): ProviderSession {
  const provider = input.provider ?? ProviderDriverKind.make("codex");
  const providerInstanceId = input.providerInstanceId ?? ProviderInstanceId.make(String(provider));
  const updatedAt = input.updatedAt ?? "2026-01-01T00:00:00.000Z";
  return {
    provider,
    providerInstanceId,
    status: input.status ?? "running",
    runtimeMode: "full-access",
    threadId: input.threadId,
    ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
    createdAt: updatedAt,
    updatedAt,
  };
}

function expectStoppedSessionProjection(command: unknown, threadId: ThreadId) {
  expect(command).toMatchObject({
    type: "thread.session.set",
    threadId,
    session: {
      threadId,
      status: "stopped",
      activeTurnId: null,
    },
  });
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
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

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly activeProviderSessions?: ReadonlyArray<ProviderSession>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );
    const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>(() =>
      Effect.succeed({ sequence: 1 }),
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      compactContext: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed(input.activeProviderSessions ?? []),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      deleteThread: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: (threadId) =>
            Effect.succeed(
              input.readModel.threads.find((thread) => thread.id === threadId)
                ? Option.some(input.readModel.threads.find((thread) => thread.id === threadId)!)
                : Option.none(),
            ),
          getThreadDetailById: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch,
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { dispatch, stopSession, stoppedThreadIds };
  }

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expectStoppedSessionProjection(harness.dispatch.mock.calls[0]?.[0], threadId);
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("reaps stale projected active turns when the provider no longer lists the session", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expectStoppedSessionProjection(harness.dispatch.mock.calls[0]?.[0], threadId);
  });

  it("skips stale projected active turns while the provider still lists the session", async () => {
    const threadId = ThreadId.make("thread-reaper-live-active-turn");
    const turnId = TurnId.make("turn-reaper-live-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      activeProviderSessions: [
        makeProviderSession({
          threadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          activeTurnId: turnId,
        }),
      ],
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-live-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("reconciles stopped persisted sessions with stale active projections on startup", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped-active-projection");
    const turnId = TurnId.make("turn-reaper-stopped-active-projection");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-stopped-active-projection",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.dispatch.mock.calls.length === 1);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expectStoppedSessionProjection(harness.dispatch.mock.calls[0]?.[0], threadId);
  });

  it("stops fresh orphaned active projections on startup without waiting for inactivity", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh-orphaned-active");
    const turnId = TurnId.make("turn-reaper-fresh-orphaned-active");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh-orphaned-active",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expectStoppedSessionProjection(harness.dispatch.mock.calls[0]?.[0], threadId);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });
});
