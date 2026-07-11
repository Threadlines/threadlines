// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@threadlines/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCheckpointFile,
  ProjectId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CheckpointRevertLive } from "../../checkpointing/Layers/CheckpointRevert.ts";
import { CheckpointRevert } from "../../checkpointing/Services/CheckpointRevert.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  checkpointPreTurnRefForThreadTurn,
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
} from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
  extraSessions: ReadonlyArray<ProviderSession> = [],
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
      readonly targetUserMessageId?: MessageId;
    }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () => {
    const primarySession: ReadonlyArray<ProviderSession> = hasSession
      ? [
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ]
      : [];
    return Effect.succeed([
      ...primarySession,
      ...extraSessions,
    ] satisfies ReadonlyArray<ProviderSession>);
  };
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    interruptTurn: () => unsupported(),
    compactContext: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    deleteThread: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly latestTurn: { readonly turnId: string } | null;
      readonly checkpoints: ReadonlyArray<{
        readonly checkpointTurnCount: number;
        readonly files?: ReadonlyArray<OrchestrationCheckpointFile>;
        readonly status?: string;
      }>;
      readonly activities: ReadonlyArray<{
        readonly kind: string;
        readonly summary?: string | undefined;
        readonly payload?: unknown | undefined;
      }>;
    }>;
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{
      checkpointTurnCount: number;
      files?: ReadonlyArray<OrchestrationCheckpointFile>;
      status?: string;
    }>;
    activities: ReadonlyArray<{
      kind: string;
      summary?: string | undefined;
      payload?: unknown | undefined;
    }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{
      checkpointTurnCount: number;
      files?: ReadonlyArray<OrchestrationCheckpointFile>;
      status?: string;
    }>;
    activities: ReadonlyArray<{
      kind: string;
      summary?: string | undefined;
      payload?: unknown | undefined;
    }>;
  }> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  runGit(cwd, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore
    | CheckpointRevert
    | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly includeConcurrentSession?: boolean;
    readonly extraProviderSessions?: ReadonlyArray<ProviderSession>;
    readonly gitStatusRefreshCalls?: Array<string>;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const now = "2026-01-01T00:00:00.000Z";
    const extraProviderSessions = [
      ...(options?.includeConcurrentSession
        ? [
            {
              provider: options?.providerName ?? ProviderDriverKind.make("codex"),
              status: "running" as const,
              runtimeMode: "full-access" as const,
              threadId: ThreadId.make("thread-2"),
              cwd,
              activeTurnId: asTurnId("turn-other-active"),
              createdAt: now,
              updatedAt: now,
            },
          ]
        : []),
      ...(options?.extraProviderSessions ?? []),
    ] satisfies ReadonlyArray<ProviderSession>;
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
      extraProviderSessions,
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-checkpoint-reactor-test-",
    });
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(CheckpointRevertLive),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = now;
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider,
      cwd,
      drain,
      checkpointStore: {
        captureCheckpoint: (input: { cwd: string; checkpointRef: CheckpointRef }) =>
          runtime === null
            ? Promise.reject(new Error("Harness runtime is unavailable."))
            : runtime.runPromise(checkpointStore.captureCheckpoint(input)),
      },
      getRevertPlan: (input: { threadId: ThreadId; turnCount: number }) =>
        runtime === null
          ? Promise.reject(new Error("Harness runtime is unavailable."))
          : runtime.runPromise(
              Effect.flatMap(Effect.service(CheckpointRevert), (revert) =>
                revert.getRevertPlan(input),
              ),
            ),
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointPreTurnRefForThreadTurn(ThreadId.make("thread-1"), asTurnId("turn-1")),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-1" &&
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.summary === "Changed files"),
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => {
        const payload = activity.payload as { itemType?: string; data?: { files?: unknown[] } };
        return (
          activity.kind === "tool.completed" &&
          payload.itemType === "file_change" &&
          Array.isArray(payload.data?.files) &&
          payload.data.files.length === 1
        );
      }),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitRefExists(
        harness.cwd,
        checkpointPreTurnRefForThreadTurn(ThreadId.make("thread-1"), asTurnId("turn-1")),
      ),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("skips changed-file summaries from a shared checkout while another session is active", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-shared-checkout");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-shared-checkout"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    await waitForGitRefExists(harness.cwd, checkpointPreTurnRefForThreadTurn(threadId, turnId));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "changed by another session\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-shared-checkout"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-shared-checkout" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.files).toEqual([]);
    expect(thread.activities.some((activity) => activity.summary === "Changed files")).toBe(false);
  });

  it("keeps provider-reported shared-checkout summaries when final diffs include unreported paths", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-shared-provider-summary");
    const providerFiles: OrchestrationCheckpointFile[] = [
      {
        path: "README.md",
        kind: "modified",
        additions: 1,
        deletions: 1,
      },
    ];

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-shared-provider-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    await waitForGitRefExists(harness.cwd, checkpointPreTurnRefForThreadTurn(threadId, turnId));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "provider-owned edit\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-provider-summary-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("provider-diff:evt-shared-provider-summary"),
        status: "missing",
        files: providerFiles,
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "EXTERNAL.md"), "other session edit\n", "utf8");

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-shared-provider-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready" &&
        entry.activities.some(
          (activity) => activity.kind === "tool.completed" && activity.summary === "Changed files",
        ),
    );

    expect(thread.checkpoints[0]?.files).toEqual(providerFiles);

    const fileActivity = thread.activities.find(
      (activity) => activity.kind === "tool.completed" && activity.summary === "Changed files",
    );
    const payload =
      fileActivity?.payload && typeof fileActivity.payload === "object"
        ? (fileActivity.payload as { data?: { files?: unknown } })
        : undefined;
    expect(payload?.data?.files).toEqual(providerFiles);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-shared-provider-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const completedThread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-shared-provider-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready",
    );

    expect(completedThread.checkpoints[0]?.files).toEqual(providerFiles);
  });

  it("refreshes same-path shared-checkout summaries from the final checkpoint diff", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-shared-refresh-same-path-summary");
    const providerFiles: OrchestrationCheckpointFile[] = [
      {
        path: "README.md",
        kind: "modified",
        additions: 1,
        deletions: 1,
      },
    ];

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-shared-refresh-same-path-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    await waitForGitRefExists(harness.cwd, checkpointPreTurnRefForThreadTurn(threadId, turnId));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "early\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-shared-refresh-same-path-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("provider-diff:evt-shared-refresh-same-path"),
        status: "missing",
        files: providerFiles,
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-shared-refresh-same-path-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready",
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "final\nmore\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-shared-refresh-same-path-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-shared-refresh-same-path-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready" &&
        entry.checkpoints[0]?.files?.[0]?.additions === 2,
    );

    expect(thread.checkpoints[0]?.files).toEqual([
      {
        path: "README.md",
        kind: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  it("does not replace an empty provider diff summary with shared-checkout Git changes", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-empty-provider-summary");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-empty-provider-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    await waitForGitRefExists(harness.cwd, checkpointPreTurnRefForThreadTurn(threadId, turnId));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "changed outside provider\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-empty-provider-summary-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("provider-diff:evt-empty-provider-summary"),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-empty-provider-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready",
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-empty-provider-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-empty-provider-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready",
    );

    expect(thread.checkpoints[0]?.files).toEqual([]);
    expect(thread.activities.some((activity) => activity.summary === "Changed files")).toBe(false);
  });

  it("uses the per-turn pre-state for changed-file summaries when the branch advances between turns", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-before-branch-move-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-before-branch-move-1"),
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "turn 1\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-before-branch-move-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-before-branch-move-1"),
      payload: { state: "completed" },
    });
    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-before-branch-move-1" && entry.checkpoints.length === 1,
    );

    runGit(harness.cwd, ["add", "README.md"]);
    runGit(harness.cwd, ["commit", "-m", "Commit first turn output"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "external branch move\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    runGit(harness.cwd, ["commit", "-m", "External branch movement"]);

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-branch-move-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-after-branch-move-2"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointPreTurnRefForThreadTurn(threadId, asTurnId("turn-after-branch-move-2")),
    );
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-after-branch-move-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-after-branch-move-2"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-after-branch-move-2" && entry.checkpoints.length === 2,
    );
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const secondCheckpoint = thread?.checkpoints.find(
      (checkpoint) => checkpoint.checkpointTurnCount === 2,
    );
    expect(secondCheckpoint?.files).toEqual([]);

    const chainDiff = runGit(harness.cwd, [
      "diff",
      "--numstat",
      checkpointRefForThreadTurn(threadId, 1),
      checkpointRefForThreadTurn(threadId, 2),
    ]);
    expect(chainDiff).toContain("README.md");
  });

  it("refreshes an early diff checkpoint when the turn completes", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-refresh-diff");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-refresh-diff"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "early\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-placeholder-diff-refresh"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("provider-diff:evt-refresh"),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1));
    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
    ).toBe("early\n");

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "final\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-diff"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const refreshedRef = checkpointRefForThreadTurn(threadId, 1);
    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-refresh-diff" &&
        entry.checkpoints.length === 1 &&
        gitShowFileAtRef(harness.cwd, refreshedRef, "README.md") === "final\n",
    );
    expect(gitShowFileAtRef(harness.cwd, refreshedRef, "README.md")).toBe("final\n");
  });

  it("recomputes final changed-file summaries from the refreshed checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-refresh-summary");
    const providerFiles: OrchestrationCheckpointFile[] = [
      {
        path: "packages/contracts/src/ipc.ts",
        kind: "modified",
        additions: 2,
        deletions: 0,
      },
    ];

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-refresh-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    await waitForGitRefExists(harness.cwd, checkpointPreTurnRefForThreadTurn(threadId, turnId));

    const ipcPath = path.join(harness.cwd, "packages", "contracts", "src", "ipc.ts");
    fs.mkdirSync(path.dirname(ipcPath), { recursive: true });
    fs.writeFileSync(ipcPath, "export const one = 1;\nexport const two = 2;\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-partial-provider-summary-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("provider-diff:evt-partial-provider-summary"),
        status: "missing",
        files: providerFiles,
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-refresh-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready",
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "final\n", "utf8");
    const desktopMainPath = path.join(harness.cwd, "apps", "desktop", "src", "main.ts");
    fs.mkdirSync(path.dirname(desktopMainPath), { recursive: true });
    fs.writeFileSync(desktopMainPath, "export const main = true;\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-summary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-refresh-summary" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.status === "ready" &&
        (entry.checkpoints[0]?.files?.length ?? 0) > 1,
    );

    expect(thread.checkpoints[0]?.files).toEqual(
      expect.arrayContaining([
        {
          path: "README.md",
          kind: "modified",
          additions: 1,
          deletions: 1,
        },
        {
          path: "apps/desktop/src/main.ts",
          kind: "modified",
          additions: 1,
          deletions: 0,
        },
        {
          path: "packages/contracts/src/ipc.ts",
          kind: "modified",
          additions: 2,
          deletions: 0,
        },
      ]),
    );
    expect(thread.checkpoints[0]?.files).toHaveLength(3);
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-baseline"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    // A dedicated worktree (distinct from the project workspace root) keeps
    // the whole-checkout restore path.
    const harness = await createHarness({
      projectWorkspaceRoot: path.join(os.tmpdir(), "t3-isolated-project-root-revert"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(
      fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({
      providerName: ProviderDriverKind.make("claudeAgent"),
      projectWorkspaceRoot: path.join(os.tmpdir(), "t3-isolated-project-root-claude"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const firstUserMessageId = MessageId.make("11111111-1111-4111-8111-111111111111");
    const secondUserMessageId = MessageId.make("22222222-2222-4222-8222-222222222222");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-user-claude-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: firstUserMessageId,
          role: "user",
          text: "first turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-user-claude-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: secondUserMessageId,
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      targetUserMessageId: secondUserMessageId,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("reverts only the thread's attributed files in a shared checkout", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
    });
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
    });
    // Another session's file lands between this thread's turns, so it is
    // baked into the thread's later snapshots without being attributed.
    fs.writeFileSync(path.join(harness.cwd, "other-session.txt"), "other v1\n", "utf8");
    // The thread's second turn edits README.md and creates a new file.
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "created-by-thread.txt"), "mine\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 2),
    });
    // More foreign work after the thread's last snapshot.
    fs.writeFileSync(path.join(harness.cwd, "late-other-session.txt"), "other v2\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-shared"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-shared-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-shared-diff-2"),
        threadId,
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
        status: "ready",
        files: [
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
          { path: "created-by-thread.txt", kind: "added", additions: 1, deletions: 0 },
        ],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-shared-revert"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    // The thread's own changes are rolled back.
    expect(
      fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(fs.existsSync(path.join(harness.cwd, "created-by-thread.txt"))).toBe(false);
    // The other session's work survives.
    expect(fs.readFileSync(path.join(harness.cwd, "other-session.txt"), "utf8")).toBe("other v1\n");
    expect(fs.readFileSync(path.join(harness.cwd, "late-other-session.txt"), "utf8")).toBe(
      "other v2\n",
    );
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);

    const outcomeActivity = thread.activities.find(
      (activity) => activity.kind === "checkpoint.reverted",
    );
    expect(outcomeActivity?.payload).toMatchObject({
      mode: "selective",
      revertedFileCount: 2,
      conflictPathCount: 0,
      unattributedPathCount: 1,
    });
  });

  it("keeps overlapping foreign edits as conflicts instead of overwriting them", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
    });
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
    });
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "created-by-thread.txt"), "mine\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 2),
    });
    // Another actor edits the thread's file after its last snapshot.
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "foreign edit\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-conflict"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-conflict-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-conflict-diff-2"),
        threadId,
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
        status: "ready",
        files: [
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
          { path: "created-by-thread.txt", kind: "added", additions: 1, deletions: 0 },
        ],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-conflict-revert"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    // The conflicted file keeps the foreign edit; the safe file is reverted.
    expect(
      fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("foreign edit\n");
    expect(fs.existsSync(path.join(harness.cwd, "created-by-thread.txt"))).toBe(false);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);

    const outcomeActivity = thread.activities.find(
      (activity) => activity.kind === "checkpoint.reverted",
    );
    expect(outcomeActivity?.payload).toMatchObject({
      mode: "selective",
      revertedFileCount: 1,
      conflictPathCount: 1,
      conflictPaths: ["README.md"],
    });
  });

  it("hunk-reverts the thread's edits around non-overlapping foreign edits", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const lines = (first: string, last: string): string =>
      [first, "line2", "line3", "line4", "line5", "line6", "line7", "line8", "line9", last]
        .join("\n")
        .concat("\n");

    fs.writeFileSync(path.join(harness.cwd, "lines.txt"), lines("line1", "line10"), "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
    });
    // The thread's turn edits the first line.
    fs.writeFileSync(path.join(harness.cwd, "lines.txt"), lines("line1-thread", "line10"), "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
    });
    // Another actor later edits the last line, far from the thread's hunk.
    fs.writeFileSync(
      path.join(harness.cwd, "lines.txt"),
      lines("line1-thread", "line10-other"),
      "utf8",
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-hunk"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-hunk-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "lines.txt", kind: "modified", additions: 1, deletions: 1 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-hunk-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.reverted"),
    );

    // The thread's edit is undone while the foreign edit survives.
    expect(
      fs.readFileSync(path.join(harness.cwd, "lines.txt"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe(lines("line1", "line10-other"));

    const outcomeActivity = thread.activities.find(
      (activity) => activity.kind === "checkpoint.reverted",
    );
    expect(outcomeActivity?.payload).toMatchObject({
      mode: "selective",
      revertedFileCount: 1,
      hunkRevertedFileCount: 1,
      conflictPathCount: 0,
    });
  });

  it("hunk-reverts an EOF append while keeping a block another session appended after it", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const baseline = ["# TODO", "", "- [ ] existing item"].join("\n").concat("\n");
    const threadBlock = ["", "## thread scratchpad", "", "- [ ] mine"].join("\n").concat("\n");
    const foreignBlock = ["", "## second session", "", "- [ ] theirs"].join("\n").concat("\n");
    const notesPath = path.join(harness.cwd, "notes.md");

    fs.writeFileSync(notesPath, baseline, "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
    });
    // The thread's turn appends its block at the end of the file.
    fs.writeFileSync(notesPath, baseline + threadBlock, "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
    });
    // Another session appends its own block directly after the thread's.
    fs.writeFileSync(notesPath, baseline + threadBlock + foreignBlock, "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-eof-append"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-eof-append-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "notes.md", kind: "modified", additions: 4, deletions: 0 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-eof-append-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.reverted"),
    );

    // The thread's block is removed; the other session's block survives.
    expect(fs.readFileSync(notesPath, "utf8").replaceAll("\r\n", "\n")).toBe(
      baseline + foreignBlock,
    );

    const outcomeActivity = thread.activities.find(
      (activity) => activity.kind === "checkpoint.reverted",
    );
    expect(outcomeActivity?.payload).toMatchObject({
      mode: "selective",
      revertedFileCount: 1,
      hunkRevertedFileCount: 1,
      conflictPathCount: 0,
    });
    expect(outcomeActivity?.summary).toBe("Reverted 1 file for this thread");
  });

  it("rolls back the thread's edits to a file another actor created between its turns", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
    });
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
    });
    // Another actor creates shared.txt between the thread's turns; the
    // pre-turn snapshot records the gap.
    fs.writeFileSync(path.join(harness.cwd, "shared.txt"), "other\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointPreTurnRefForThreadTurnCount(threadId, 2),
    });
    // The thread's second turn rewrites shared.txt and README.md.
    fs.writeFileSync(path.join(harness.cwd, "shared.txt"), "thread version\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 2),
    });
    // The thread's third turn appends to shared.txt.
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointPreTurnRefForThreadTurnCount(threadId, 3),
    });
    fs.writeFileSync(
      path.join(harness.cwd, "shared.txt"),
      "thread version\nsecond thread line\n",
      "utf8",
    );
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 3),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-contested"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-contested-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-contested-diff-2"),
        threadId,
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
        status: "ready",
        files: [
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
          { path: "shared.txt", kind: "modified", additions: 1, deletions: 1 },
        ],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-contested-diff-3"),
        threadId,
        turnId: asTurnId("turn-3"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 3),
        status: "ready",
        files: [{ path: "shared.txt", kind: "modified", additions: 1, deletions: 0 }],
        checkpointTurnCount: 3,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-contested-revert"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    // Both of the thread's edits to the interleaved file are unwound turn by
    // turn, restoring the other actor's original content; the thread-only
    // file reverts exactly.
    expect(fs.readFileSync(path.join(harness.cwd, "shared.txt"), "utf8")).toBe("other\n");
    expect(
      fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId,
      numTurns: 2,
    });

    const outcomeActivity = thread.activities.find(
      (activity) => activity.kind === "checkpoint.reverted",
    );
    expect(outcomeActivity?.payload).toMatchObject({
      mode: "selective",
      revertedFileCount: 2,
      interleavedRevertedFileCount: 1,
      conflictPathCount: 0,
    });
    expect(outcomeActivity?.summary).toBe("Reverted 2 files for this thread");
  });

  it("computes a dry-run revert plan without touching the workspace", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      includeConcurrentSession: true,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
    });
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
    });
    fs.writeFileSync(path.join(harness.cwd, "other-session.txt"), "other v1\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "created-by-thread.txt"), "mine\n", "utf8");
    await harness.checkpointStore.captureCheckpoint({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 2),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const [turnCount, files] of [
      [1, [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }]],
      [
        2,
        [
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
          { path: "created-by-thread.txt", kind: "added", additions: 1, deletions: 0 },
        ],
      ],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-plan-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [...files],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    const plan = await harness.getRevertPlan({ threadId, turnCount: 1 });

    expect(plan).toMatchObject({
      mode: "selective",
      turnCount: 1,
      currentTurnCount: 2,
      revertFileCount: 2,
      conflictCount: 0,
      unattributedPathCount: 1,
      hasProviderSession: true,
    });
    expect([...plan.revertPaths].toSorted()).toEqual(["README.md", "created-by-thread.txt"]);

    // Dry run: the workspace is untouched and checkpoints are preserved.
    expect(
      fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v3\n");
    expect(fs.existsSync(path.join(harness.cwd, "created-by-thread.txt"))).toBe(true);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("reverts files without a live provider session and reports the skipped rollback", async () => {
    const harness = await createHarness({ hasSession: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    for (const turnCount of [1, 2] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-sessionless-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sessionless-revert"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.rollback-skipped"),
    );

    // Files revert from thread/project config alone; provider rollback is
    // skipped and surfaced instead of failing the whole revert.
    expect(
      fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.reverted")).toBe(
      true,
    );
  });

  it("appends an error activity when revert targets a turn missing from the read model", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
