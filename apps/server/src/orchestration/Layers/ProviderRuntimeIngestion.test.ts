// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@threadlines/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import * as Duration from "effect/Duration";

import { SubagentWorktreeFollower } from "../Services/SubagentWorktreeFollower.ts";
import { make as makeSubagentWorktreeFollower } from "./SubagentWorktreeFollower.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];
  // Where the provider says each spawned subagent is working. Empty means the
  // provider has not written the record yet, which is its normal first answer.
  const subagentWorktreesByToolUseId = new Map<string, { readonly worktreePath: string }>();

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    listExternalThreads: () => unsupported(),
    readExternalThread: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    interruptTurn: () => unsupported(),
    realtimeStart: () => unsupported(),
    realtimeStop: () => unsupported(),
    realtimeAppendAudio: () => unsupported(),
    realtimeListVoices: () => unsupported(),
    compactContext: () => unsupported(),
    setThreadGoal: () => unsupported(),
    pauseThreadGoalForStop: () => unsupported(),
    clearThreadGoal: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
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
    readSubagentTranscript: () => unsupported(),
    sendSubagentInput: () => unsupported(),
    resolveSubagentWorktree: ({ toolUseId }) =>
      Effect.succeed(subagentWorktreesByToolUseId.get(toolUseId) ?? null),
    deleteThread: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  const setSubagentWorktree = (toolUseId: string, worktreePath: string | null): void => {
    if (worktreePath === null) {
      subagentWorktreesByToolUseId.delete(toolUseId);
      return;
    }
    subagentWorktreesByToolUseId.set(toolUseId, { worktreePath });
  };

  return {
    service,
    emit,
    setSession,
    setSubagentWorktree,
  };
}

/**
 * Enough of GitWorkflowService for the follower's one question: is this path a
 * checkout of the thread's repository? Building the real git stack here would
 * test git, not ingestion.
 */
function createGitWorkflowHarness() {
  const worktreePaths: string[] = [];
  const service = {
    listWorktrees: () =>
      Effect.succeed(worktreePaths.map((worktreePath) => ({ path: worktreePath, branch: null }))),
  } as unknown as GitWorkflowServiceShape;
  return {
    service,
    setWorktrees: (paths: ReadonlyArray<string>): void => {
      worktreePaths.splice(0, worktreePaths.length, ...paths);
    },
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 10_000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: { serverSettings?: Partial<ServerSettings> }) {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const gitWorkflow = createGitWorkflowHarness();
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
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(
        Layer.effect(
          SubagentWorktreeFollower,
          // Real delay races the harness's worktree cleanup; tests fake git
          // state directly, so only the scheduling behavior matters.
          makeSubagentWorktreeFollower({ lingerValidationDelay: Duration.millis(25) }),
        ),
      ),
      Layer.provideMerge(Layer.succeed(GitWorkflowService, gitWorkflow.service)),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
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
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      workspaceRoot,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      emit: provider.emit,
      setProviderSession: provider.setSession,
      setSubagentWorktree: provider.setSubagentWorktree,
      setRepositoryWorktrees: gitWorkflow.setWorktrees,
      drain,
    };
  }

  it("drops realtime audio deltas before any orchestration event is persisted", async () => {
    const harness = await createHarness();
    const before = await harness.readModel();

    harness.emit({
      type: "thread.realtime.audio.delta",
      eventId: asEventId("evt-realtime-audio-dropped"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        audio: {
          data: "AAEC",
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 2,
        },
      },
    });
    await Effect.runPromise(Effect.yieldNow);
    await harness.drain();

    const after = await harness.readModel();
    expect(after.snapshotSequence).toBe(before.snapshotSequence);
    expect(after.threads[0]).toEqual(before.threads[0]);
  });

  it("records finished user realtime transcripts as user messages", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "thread.realtime.transcript.done",
      eventId: asEventId("evt-realtime-user-done"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        role: "user",
        text: "What does the failing test cover?",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.role === "user" && message.text === "What does the failing test cover?",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.role === "user",
    );
    expect(message?.id).toBe("user:realtime:thread-1:evt-realtime-user-done");
  });

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("settles a running session from a fresh provider thread idle signal", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-before-thread-idle"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      turnId: asTurnId("turn-thread-idle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session.activeTurnId === "turn-thread-idle",
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-idle-after-lost-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { state: "idle" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
    );
    expect(thread.session).toMatchObject({
      status: "ready",
      activeTurnId: null,
      lastError: null,
    });
  });

  it("does not let an older thread idle signal settle a newer running turn", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-newer-turn-started-before-stale-thread-idle"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:03.000Z",
      turnId: asTurnId("turn-newer-than-thread-idle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session.activeTurnId === "turn-newer-than-thread-idle",
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-stale-thread-idle"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { state: "idle" },
    });
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "running",
      activeTurnId: "turn-newer-than-thread-idle",
    });
  });

  it("settles orphaned roster subagents when a fresh provider session starts", async () => {
    const harness = await createHarness();

    // A promoted background run whose completion will never arrive: its
    // in-memory tracking lived in a provider process that is about to be
    // replaced (e.g. the machine shut down mid-run).
    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-subagent-orphan-running"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        callId: "call-exec-orphan",
        agentThreadId: "codexExec:orphan-session",
        agentRole: "codex exec",
        status: "running",
      },
    });
    // A row that finished normally must stay finished, not be re-stamped.
    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-subagent-orphan-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: {
        callId: "call-exec-done",
        agentThreadId: "codexExec:done-session",
        agentRole: "codex exec",
        status: "completed",
      },
    });
    await waitForThread(harness.readModel, (thread) =>
      (thread.subagents ?? []).some(
        (subagent) =>
          subagent.agentThreadId === "codexExec:orphan-session" && subagent.status === "running",
      ),
    );

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-orphan-sweep"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:10.000Z",
      payload: {
        message: "ready",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      (entry.subagents ?? []).some(
        (subagent) =>
          subagent.agentThreadId === "codexExec:orphan-session" &&
          subagent.status === "interrupted",
      ),
    );
    const settled = (thread.subagents ?? []).find(
      (subagent) => subagent.agentThreadId === "codexExec:done-session",
    );
    expect(settled?.status).toBe("completed");
  });

  it("records and clears the session's observed cwd divergence", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    await waitForThread(harness.readModel, (thread) => thread.session?.status === "ready");

    // A cwd away from the configured checkout records the divergence.
    harness.emit({
      type: "session.cwd.changed",
      eventId: asEventId("evt-cwd-worktree"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        cwd: `${harness.workspaceRoot}/.claude/worktrees/feature`,
        reason: "worktree-entered",
      },
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.effectiveCwd === `${harness.workspaceRoot}/.claude/worktrees/feature`,
    );

    // Observing the configured checkout again clears it. Windows drive paths
    // may arrive with different slash and drive-letter casing.
    const equivalentConfiguredCwd = /^[a-zA-Z]:[/\\]/u.test(harness.workspaceRoot)
      ? `${harness.workspaceRoot.replaceAll("\\", "/").toUpperCase()}/`
      : `${harness.workspaceRoot}/`;
    harness.emit({
      type: "session.cwd.changed",
      eventId: asEventId("evt-cwd-configured"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: { cwd: equivalentConfiguredCwd, reason: "session-init" },
    });
    await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === null);
  });

  describe("subagent worktree inference", () => {
    const CLAUDE = ProviderDriverKind.make("claudeAgent");
    const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
    const NOW = "2026-01-01T00:00:00.000Z";

    async function createClaudeHarness() {
      const harness = await createHarness();
      await waitForThread(harness.readModel, (thread) => thread.session?.status === "ready");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-claude-subagent-worktree"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: CLAUDE,
            providerInstanceId: CLAUDE_INSTANCE,
            runtimeMode: "approval-required",
            activeTurnId: null,
            pendingBackgroundTaskCount: 0,
            updatedAt: NOW,
            lastError: null,
          },
          createdAt: NOW,
        }),
      );
      await waitForThread(harness.readModel, (thread) => thread.session?.providerName === CLAUDE);
      return harness;
    }

    function startAgentTask(
      harness: Awaited<ReturnType<typeof createClaudeHarness>>,
      taskId: string,
      toolUseId: string,
    ) {
      harness.emit({
        type: "task.started",
        eventId: asEventId(`evt-agent-task-started-${taskId}`),
        provider: CLAUDE,
        providerInstanceId: CLAUDE_INSTANCE,
        threadId: asThreadId("thread-1"),
        createdAt: NOW,
        payload: { taskId, taskType: "local_agent", toolUseId, description: "Subagent" },
      });
    }

    function completeTask(
      harness: Awaited<ReturnType<typeof createClaudeHarness>>,
      taskId: string,
    ) {
      harness.emit({
        type: "task.completed",
        eventId: asEventId(`evt-agent-task-completed-${taskId}`),
        provider: CLAUDE,
        providerInstanceId: CLAUDE_INSTANCE,
        threadId: asThreadId("thread-1"),
        createdAt: NOW,
        payload: { taskId, status: "completed" },
      });
    }

    it("keeps following a finished subagent's worktree while it still exists", async () => {
      // The worktree surviving the task means the agent left changes behind,
      // and the session usually keeps working there (review, fixes, commit)
      // without ever announcing the move.
      const harness = await createClaudeHarness();
      const worktree = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, worktree]);
      harness.setSubagentWorktree("toolu_a", worktree);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === worktree);

      completeTask(harness, "task-a");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("100 millis"));
      expect((await harness.readModel()).threads[0]?.effectiveCwd).toBe(worktree);
    });

    it("stops following when the finished subagent's worktree is gone", async () => {
      // An unchanged worktree is auto-removed at task end — nothing lingers.
      const harness = await createClaudeHarness();
      const worktree = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, worktree]);
      harness.setSubagentWorktree("toolu_a", worktree);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === worktree);

      harness.setRepositoryWorktrees([harness.workspaceRoot]);
      completeTask(harness, "task-a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === null);
    });

    it("lets a new subagent supersede a lingering worktree", async () => {
      const harness = await createClaudeHarness();
      const first = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      const second = `${harness.workspaceRoot}/.claude/worktrees/agent-b`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, first, second]);
      harness.setSubagentWorktree("toolu_a", first);
      harness.setSubagentWorktree("toolu_b", second);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === first);
      completeTask(harness, "task-a");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("100 millis"));
      expect((await harness.readModel()).threads[0]?.effectiveCwd).toBe(first);

      startAgentTask(harness, "task-b", "toolu_b");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === second);
    });

    it("ignores a subagent whose checkout the provider never reports", async () => {
      const harness = await createClaudeHarness();
      harness.setRepositoryWorktrees([harness.workspaceRoot]);

      startAgentTask(harness, "task-unknown", "toolu_unknown");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("50 millis"));

      const snapshot = await harness.readModel();
      expect(snapshot.threads[0]?.effectiveCwd).toBeNull();
    });

    it("ignores a checkout that does not belong to the thread's repository", async () => {
      const harness = await createClaudeHarness();
      // The provider reports a path, but git does not know it as a checkout of
      // this repository, so it must not be followed.
      harness.setRepositoryWorktrees([harness.workspaceRoot]);
      harness.setSubagentWorktree("toolu_foreign", "/somewhere/else/agent-x");

      startAgentTask(harness, "task-foreign", "toolu_foreign");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("50 millis"));

      const snapshot = await harness.readModel();
      expect(snapshot.threads[0]?.effectiveCwd).toBeNull();
    });

    it("follows nothing while two subagents work in different checkouts", async () => {
      const harness = await createClaudeHarness();
      const first = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      const second = `${harness.workspaceRoot}/.claude/worktrees/agent-b`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, first, second]);
      harness.setSubagentWorktree("toolu_a", first);
      harness.setSubagentWorktree("toolu_b", second);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === first);

      // A second place makes "where is the work" ambiguous, so follow neither.
      startAgentTask(harness, "task-b", "toolu_b");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === null);

      // Back down to one place, and it is followable again.
      completeTask(harness, "task-b");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === first);
    });

    it("keeps following one place when two subagents share a checkout", async () => {
      const harness = await createClaudeHarness();
      const shared = `${harness.workspaceRoot}/.claude/worktrees/agent-shared`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, shared]);
      harness.setSubagentWorktree("toolu_a", shared);
      harness.setSubagentWorktree("toolu_b", shared);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === shared);
      startAgentTask(harness, "task-b", "toolu_b");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("50 millis"));

      const snapshot = await harness.readModel();
      expect(snapshot.threads[0]?.effectiveCwd).toBe(shared);
    });

    it("never overwrites or clears a cwd the session itself reported", async () => {
      const harness = await createClaudeHarness();
      const sessionCwd = `${harness.workspaceRoot}/.claude/worktrees/session-moved`;
      const subagentWorktree = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, sessionCwd, subagentWorktree]);
      harness.setSubagentWorktree("toolu_a", subagentWorktree);

      harness.emit({
        type: "session.cwd.changed",
        eventId: asEventId("evt-session-moved"),
        provider: CLAUDE,
        providerInstanceId: CLAUDE_INSTANCE,
        threadId: asThreadId("thread-1"),
        createdAt: NOW,
        payload: { cwd: sessionCwd, reason: "worktree-entered" },
      });
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === sessionCwd);

      startAgentTask(harness, "task-a", "toolu_a");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("50 millis"));
      expect((await harness.readModel()).threads[0]?.effectiveCwd).toBe(sessionCwd);

      // Nor may the subagent finishing clear what the session reported.
      completeTask(harness, "task-a");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("50 millis"));
      expect((await harness.readModel()).threads[0]?.effectiveCwd).toBe(sessionCwd);
    });

    it("does not reassert a subagent worktree after the user selects the project checkout", async () => {
      const harness = await createClaudeHarness();
      const worktree = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, worktree]);
      harness.setSubagentWorktree("toolu_a", worktree);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === worktree);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkout.select",
          commandId: CommandId.make("cmd-select-project-checkout"),
          threadId: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath: null,
        }),
      );
      await waitForThread(
        harness.readModel,
        (thread) => thread.effectiveCwd === null && thread.effectiveCwdSource === "selection",
      );

      // Model a lookup that read the old state before the selection but only
      // reached the serialized decider afterward.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.effective-cwd.set",
          commandId: CommandId.make("cmd-stale-subagent-result"),
          threadId: ThreadId.make("thread-1"),
          effectiveCwd: worktree,
          effectiveCwdSource: "subagent",
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
      await waitForThread(
        harness.readModel,
        (thread) => thread.effectiveCwd === null && thread.effectiveCwdSource === "selection",
      );

      completeTask(harness, "task-a");
      await harness.drain();
      await Effect.runPromise(Effect.sleep("100 millis"));
      const selected = (await harness.readModel()).threads[0];
      expect(selected?.effectiveCwd).toBeNull();
      expect(selected?.effectiveCwdSource).not.toBe("subagent");
    });

    it("stops following when the provider session exits", async () => {
      const harness = await createClaudeHarness();
      const worktree = `${harness.workspaceRoot}/.claude/worktrees/agent-a`;
      harness.setRepositoryWorktrees([harness.workspaceRoot, worktree]);
      harness.setSubagentWorktree("toolu_a", worktree);

      startAgentTask(harness, "task-a", "toolu_a");
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === worktree);

      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited"),
        provider: CLAUDE,
        providerInstanceId: CLAUDE_INSTANCE,
        threadId: asThreadId("thread-1"),
        createdAt: NOW,
        payload: { kind: "graceful" },
      });
      await waitForThread(harness.readModel, (thread) => thread.effectiveCwd === null);
    });
  });

  it("tracks pending provider tasks on the thread session", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await waitForThread(harness.readModel, (thread) => thread.session?.status === "ready");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude-background-task"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          pendingBackgroundTaskCount: 0,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.providerName === ProviderDriverKind.make("claudeAgent") &&
        thread.session.pendingBackgroundTaskCount === 0,
    );

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-background-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-1",
        description: "Running background command",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 1,
    );

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-background-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-1",
        status: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 0,
    );

    // A detailed edge can arrive before a snapshot-capable process proves that
    // support. The compatibility fallback counts it until the level signal
    // replaces the count absolutely.
    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-background-task-edge-before-snapshot"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-snapshot-1",
        description: "Reviewing provider state",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.pendingBackgroundTaskCount === 1 &&
        thread.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-background-task-edge-before-snapshot",
        ),
    );

    harness.emit({
      type: "task.snapshot.updated",
      eventId: asEventId("evt-background-task-snapshot-running"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        tasks: [
          { taskId: "background-task-snapshot-1", taskType: "local_agent" },
          // Defensive duplicate: snapshot semantics are a set even if a
          // provider accidentally repeats an id in its array.
          { taskId: "background-task-snapshot-1", taskType: "local_agent" },
          { taskId: "background-task-snapshot-2", taskType: "local_bash" },
          // Ambient housekeeping is listed but is not work the user waits on.
          { taskId: "background-task-snapshot-ambient", taskType: "local_bash", ambient: true },
        ],
      },
    });

    const snapshotThread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 2,
    );
    expect(
      snapshotThread.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-background-task-snapshot-running",
      ),
    ).toBe(false);

    // The snapshot already counted this task. Its richer edge remains visible
    // without incrementing the session count again.
    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-background-task-snapshot-edge-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-snapshot-2",
        description: "Running provider checks",
        pendingCountManagedBySnapshot: true,
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.pendingBackgroundTaskCount === 2 &&
        thread.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-background-task-snapshot-edge-started",
        ),
    );

    harness.emit({
      type: "task.snapshot.updated",
      eventId: asEventId("evt-background-task-snapshot-settled"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: { tasks: [] },
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 0,
    );

    // A terminal edge arriving after the replace-all snapshot must not
    // decrement another task or hide its real completion status.
    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-background-task-snapshot-edge-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-snapshot-1",
        status: "failed",
        summary: "Review failed",
        pendingCountManagedBySnapshot: true,
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.pendingBackgroundTaskCount === 0 &&
        thread.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-background-task-snapshot-edge-completed" &&
            activity.tone === "error",
        ),
    );

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-background-task-started-before-exit"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-2",
        description: "Running another background command",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 1,
    );

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-restarted-clears-background-task"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {},
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 0,
    );

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-background-task-started-before-exit-2"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        taskId: "background-task-3",
        description: "Running after restart",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.pendingBackgroundTaskCount === 1,
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-session-exited-clears-background-task"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        reason: "provider exited",
        exitKind: "graceful",
      },
    });

    const stoppedThread = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "stopped" && thread.session.pendingBackgroundTaskCount === 0,
    );
    expect(stoppedThread.session?.pendingBackgroundTaskCount).toBe(0);
  });

  it("ignores stale lifecycle events from a previous provider instance", async () => {
    const harness = await createHarness();
    const reboundAt = "2026-01-01T00:00:03.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-rebound-provider-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: reboundAt,
          lastError: null,
        },
        createdAt: reboundAt,
      }),
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-stale-claude-exited"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:04.000Z",
      payload: {
        reason: "stale provider stopped after handoff",
        exitKind: "graceful",
      },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === asThreadId("thread-1"),
    );
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.providerInstanceId).toBe("codex");
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.updatedAt).toBe(reboundAt);
  });

  it("settles an idle session restart instead of inventing a pending turn", async () => {
    const harness = await createHarness();
    const restartAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-idle-session-restart-starting"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "starting",
          providerName: "codex",
          providerSessionId: null,
          providerThreadId: null,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: restartAt,
        },
        createdAt: restartAt,
      }),
    );

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-idle-session-restarted"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:05.000Z",
      payload: {
        message: "ready",
      },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === asThreadId("thread-1"),
    );
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.updatedAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("keeps pending turn startup visible until the provider turn starts", async () => {
    const harness = await createHarness();
    const requestedAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-preserve-starting"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-preserve-starting"),
          role: "user",
          text: "keep startup visible",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: requestedAt,
      }),
    );

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "starting" && thread.session.updatedAt === requestedAt,
    );

    const preparingThread = await waitForThread(harness.readModel, (thread) =>
      thread.activities.some(
        (activity) =>
          activity.kind === "provider.turn.preparing" &&
          activity.summary === "Preparing provider turn" &&
          activity.turnId === null,
      ),
    );
    const preparingActivity = preparingThread.activities.find(
      (activity) => activity.kind === "provider.turn.preparing",
    );
    expect(preparingActivity?.createdAt).toBe(requestedAt);
    expect(preparingActivity?.payload).toMatchObject({
      phase: "preparing",
    });

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-before-turn"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:05.000Z",
      payload: {
        message: "ready",
      },
    });
    await harness.drain();

    const stillStarting = (await harness.readModel()).threads.find(
      (entry) => entry.id === asThreadId("thread-1"),
    );
    expect(stillStarting?.session?.status).toBe("starting");
    expect(stillStarting?.session?.updatedAt).toBe(requestedAt);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-after-session"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:06.000Z",
      turnId: asTurnId("turn-preserve-starting"),
    });

    const runningThread = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session.activeTurnId === asTurnId("turn-preserve-starting") &&
        thread.activities.some(
          (activity) =>
            activity.kind === "provider.turn.started" &&
            activity.turnId === asTurnId("turn-preserve-starting"),
        ),
    );
    expect(runningThread.session?.updatedAt).toBe("2026-01-01T00:00:06.000Z");
    const turnStartedActivity = runningThread.activities.find(
      (activity) => activity.kind === "provider.turn.started",
    );
    expect(turnStartedActivity).toMatchObject({
      tone: "thinking",
      summary: "Waiting for model response",
      payload: {
        phase: "waiting-for-model",
      },
    });
  });

  it("settles a running turn when the provider reports turn.aborted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-abort"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-abort"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-abort",
    );

    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-subagent-started-before-abort"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      turnId: asTurnId("turn-abort"),
      payload: {
        callId: "call-live-before-abort",
        agentThreadId: "agent-live-before-abort",
        status: "running",
      },
    });
    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-subagent-waiting-before-abort"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      turnId: asTurnId("turn-abort"),
      payload: {
        callId: "call-live-before-abort",
        agentThreadId: "agent-live-before-abort",
        status: "waiting",
      },
    });
    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-subagent-completed-before-abort"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:03.000Z",
      turnId: asTurnId("turn-abort"),
      payload: {
        callId: "call-completed-before-abort",
        agentThreadId: "agent-completed-before-abort",
        status: "completed",
      },
    });

    await waitForThread(harness.readModel, (thread) =>
      (thread.subagents ?? []).some(
        (subagent) =>
          subagent.agentThreadId === "agent-live-before-abort" && subagent.status === "waiting",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-subagent-result-before-abort-1"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:03.500Z",
      turnId: asTurnId("turn-abort"),
      itemId: asItemId("item-subagent-result-before-abort"),
      providerRefs: {
        providerThreadId: "agent-live-before-abort",
        providerTurnId: "agent-turn-before-abort",
        providerItemId: asItemId("item-subagent-result-before-abort"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: "First chunk. ",
      },
    });
    await waitForThread(harness.readModel, (thread) =>
      thread.activities.some((activity) => {
        const payload = activity.payload as {
          sourceAgentThreadId?: string;
          data?: { subagentLiveText?: string };
        };
        return (
          activity.kind === "subagent.result" &&
          payload.sourceAgentThreadId === "agent-live-before-abort" &&
          payload.data?.subagentLiveText === "First chunk. "
        );
      }),
    );
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-subagent-result-before-abort-2"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:04.000Z",
      turnId: asTurnId("turn-abort"),
      itemId: asItemId("item-subagent-result-before-abort"),
      providerRefs: {
        providerThreadId: "agent-live-before-abort",
        providerTurnId: "agent-turn-before-abort",
        providerItemId: asItemId("item-subagent-result-before-abort"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: "Second chunk.",
      },
    });

    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-turn-aborted"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:05.000Z",
      turnId: asTurnId("turn-abort"),
      payload: {
        reason: "User interrupted the turn.",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "interrupted" &&
        entry.session?.activeTurnId === null &&
        entry.latestTurn?.turnId === "turn-abort" &&
        entry.latestTurn.state === "interrupted" &&
        entry.latestTurn.completedAt === "2026-01-01T00:00:05.000Z",
    );

    expect(thread.session?.lastError).toBeNull();
    expect(
      thread.subagents?.find((subagent) => subagent.agentThreadId === "agent-live-before-abort")
        ?.status,
    ).toBe("interrupted");
    expect(
      thread.subagents?.find(
        (subagent) => subagent.agentThreadId === "agent-completed-before-abort",
      )?.status,
    ).toBe("completed");
    const streamedResult = thread.activities.find((activity) => {
      const payload = activity.payload as { sourceAgentThreadId?: string };
      return (
        activity.kind === "subagent.result" &&
        payload.sourceAgentThreadId === "agent-live-before-abort"
      );
    });
    expect(streamedResult?.payload).toMatchObject({
      data: {
        subagentLiveText: "First chunk. Second chunk.",
      },
    });

    await Effect.runPromise(Effect.sleep("150 millis"));
    await harness.drain();
    const settledThread = (await harness.readModel()).threads.find(
      (entry) => entry.id === "thread-1",
    );
    expect(
      settledThread?.subagents?.find(
        (subagent) => subagent.agentThreadId === "agent-live-before-abort",
      )?.status,
    ).toBe("interrupted");
  });

  it("settles live subagents when turn.completed reports an interruption", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-before-interrupted-completion"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-interrupted-completion"),
    });
    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-subagent-waiting-before-interrupted-completion"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      turnId: asTurnId("turn-interrupted-completion"),
      payload: {
        callId: "call-waiting-before-interrupted-completion",
        status: "waiting",
      },
    });

    await waitForThread(harness.readModel, (thread) =>
      (thread.subagents ?? []).some(
        (subagent) =>
          subagent.spawnCallId === "call-waiting-before-interrupted-completion" &&
          subagent.status === "waiting",
      ),
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-interrupted-completion"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      turnId: asTurnId("turn-interrupted-completion"),
      payload: {
        state: "interrupted",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      (entry.subagents ?? []).some(
        (subagent) =>
          subagent.spawnCallId === "call-waiting-before-interrupted-completion" &&
          subagent.status === "interrupted",
      ),
    );
    expect(
      thread.subagents?.find(
        (subagent) => subagent.spawnCallId === "call-waiting-before-interrupted-completion",
      )?.status,
    ).toBe("interrupted");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores turn diff updates for a different active turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-diff-guard"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-diff-guard-main"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-diff-guard-main",
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-guard-other"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-diff-guard-other"),
      payload: {
        unifiedDiff:
          "diff --git a/leaked.txt b/leaked.txt\nindex e69de29..ce01362 100644\n--- a/leaked.txt\n+++ b/leaked.txt\n@@ -0,0 +1 @@\n+leaked\n",
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.activeTurnId).toBe("turn-diff-guard-main");
    expect(thread?.checkpoints.some((entry) => entry.turnId === "turn-diff-guard-other")).toBe(
      false,
    );
    expect(
      thread?.activities.some(
        (activity) =>
          activity.turnId === "turn-diff-guard-other" &&
          activity.kind === "tool.completed" &&
          activity.summary === "Changed files",
      ),
    ).toBe(false);
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("keeps child commentary live, attributes child activity, and completes only the final answer", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-provider-thread"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          providerThreadId: "parent-provider-thread",
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-child-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-message-1"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-message-1"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: "I am checking the runtime path. ",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-child-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-message-1"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-message-1"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: "I will report back when done.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-child-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-message-1"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-message-1"),
      },
      payload: {
        itemType: "assistant_message",
        status: "completed",
        data: {
          item: {
            phase: "commentary",
          },
        },
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-child-command-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-command-1"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-command-1"),
      },
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Running command",
        detail: "git status --short",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-child-final-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-message-final"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-message-final"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: "The runtime path is correct.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-child-final-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-message-final"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-message-final"),
      },
      payload: {
        itemType: "assistant_message",
        status: "completed",
        data: {
          item: {
            phase: "final_answer",
          },
        },
      },
    });

    await harness.drain();

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => {
        const payload =
          activity.payload && typeof activity.payload === "object"
            ? (activity.payload as Record<string, unknown>)
            : null;
        return activity.kind === "subagent.result" && payload?.status === "completed";
      }),
    );

    expect(
      thread.messages.some((message) => message.text.includes("I am checking the runtime path.")),
    ).toBe(false);

    const subagentActivities = thread.activities.filter(
      (entry) => entry.kind === "subagent.result",
    );
    const commentaryActivity = subagentActivities.find(
      (entry) => (entry.payload as { status?: string }).status === "inProgress",
    );
    expect(commentaryActivity?.payload).toMatchObject({
      status: "inProgress",
      sourceAgentThreadId: "child-provider-thread",
      data: {
        subagentLiveText: "I am checking the runtime path. I will report back when done.",
        subagentLiveTextAt: now,
        item: {
          agentsStates: {
            "child-provider-thread": {
              status: "running",
            },
          },
        },
      },
    });
    expect(
      (
        (commentaryActivity?.payload ?? {}) as {
          data?: { item?: { agentsStates?: Record<string, { message?: string }> } };
        }
      ).data?.item?.agentsStates?.["child-provider-thread"]?.message,
    ).toBeUndefined();

    const childCommandActivity = thread.activities.find((entry) => {
      const payload = entry.payload as { itemType?: string; sourceAgentThreadId?: string };
      return (
        payload.itemType === "command_execution" &&
        payload.sourceAgentThreadId === "child-provider-thread"
      );
    });
    expect(childCommandActivity).toBeDefined();

    const activity = subagentActivities.find(
      (entry) => (entry.payload as { status?: string }).status === "completed",
    );
    expect(activity).toBeDefined();
    expect(activity?.turnId).toBe("turn-parent");
    const payload = activity?.payload as {
      status?: string;
      sourceAgentThreadId?: string;
      data?: {
        item?: {
          receiverThreadIds?: string[];
          agentsStates?: Record<string, { status?: string; message?: string }>;
        };
      };
    };
    expect(payload.status).toBe("completed");
    expect(payload.sourceAgentThreadId).toBe("child-provider-thread");
    expect(payload.data?.item?.receiverThreadIds).toEqual(["child-provider-thread"]);
    expect(payload.data?.item?.agentsStates?.["child-provider-thread"]).toMatchObject({
      status: "completed",
      message: "The runtime path is correct.",
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-child-final-late-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("child-message-final"),
      providerRefs: {
        providerThreadId: "child-provider-thread",
        providerTurnId: "child-turn-1",
        providerItemId: asItemId("child-message-final"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: " Late duplicate text.",
      },
    });
    await harness.drain();

    const afterLateDelta = (await harness.readModel()).threads.find(
      (entry) => entry.id === "thread-1",
    );
    const finalActivity = afterLateDelta?.activities.find((entry) => entry.id === activity?.id);
    expect(finalActivity?.payload).toMatchObject({
      status: "completed",
      data: {
        item: {
          agentsStates: {
            "child-provider-thread": {
              status: "completed",
              message: "The runtime path is correct.",
            },
          },
        },
      },
    });
  });

  it("retains a child result when turn and session completion arrive before item completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-out-of-order-child-completion"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-out-of-order-child-completion"),
          providerThreadId: "parent-provider-thread",
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    for (const [index, delta] of ["Full child ", "result."].entries()) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-out-of-order-child-delta-${index}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-out-of-order-child-completion"),
        itemId: asItemId("out-of-order-child-message"),
        providerRefs: {
          providerThreadId: "out-of-order-child-provider-thread",
          providerTurnId: "out-of-order-child-turn",
          providerItemId: asItemId("out-of-order-child-message"),
        },
        payload: {
          streamKind: "assistant_text",
          delta,
        },
      });
    }

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-out-of-order-parent-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-out-of-order-child-completion"),
      payload: {
        state: "completed",
      },
    });
    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-out-of-order-session-exited"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        reason: "provider exited",
        exitKind: "graceful",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-out-of-order-child-item-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-out-of-order-child-completion"),
      itemId: asItemId("out-of-order-child-message"),
      providerRefs: {
        providerThreadId: "out-of-order-child-provider-thread",
        providerTurnId: "out-of-order-child-turn",
        providerItemId: asItemId("out-of-order-child-message"),
      },
      payload: {
        itemType: "assistant_message",
        status: "completed",
        data: {
          item: {
            phase: "final_answer",
          },
        },
      },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    const result = thread?.activities.find((entry) => {
      const resultPayload = entry.payload as { sourceAgentThreadId?: string; status?: string };
      return (
        entry.kind === "subagent.result" &&
        resultPayload.sourceAgentThreadId === "out-of-order-child-provider-thread" &&
        resultPayload.status === "completed"
      );
    });
    expect(result?.payload).toMatchObject({
      data: {
        item: {
          agentsStates: {
            "out-of-order-child-provider-thread": {
              status: "completed",
              message: "Full child result.",
            },
          },
        },
      },
    });
  });

  it("keeps rapid updates from three child agents independent", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const childProviderThreadIds = ["child-provider-a", "child-provider-b", "child-provider-c"];
    const readSubagentResultEvents = async () => {
      const events = await Effect.runPromise(
        Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        ),
      );
      return events.filter((event) => {
        if (event.type !== "thread.activity-appended") {
          return false;
        }
        const activity = event.payload.activity;
        return (
          activity.kind === "subagent.result" &&
          childProviderThreadIds.includes(
            (activity.payload as { sourceAgentThreadId?: string }).sourceAgentThreadId ?? "",
          )
        );
      });
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-three-streaming-children"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-three-streaming-children"),
          providerThreadId: "parent-provider-thread",
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    for (const [childIndex, childProviderThreadId] of childProviderThreadIds.entries()) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-three-streaming-children-${childIndex}-0`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-three-streaming-children"),
        itemId: asItemId(`child-message-${childIndex}`),
        providerRefs: {
          providerThreadId: childProviderThreadId,
          providerTurnId: `child-turn-${childIndex}`,
          providerItemId: asItemId(`child-message-${childIndex}`),
        },
        payload: {
          streamKind: "assistant_text",
          delta: `${childProviderThreadId}:0`,
        },
      });
    }

    await waitForThread(harness.readModel, (thread) => {
      const sources = new Set(
        thread.activities
          .filter((activity) => activity.kind === "subagent.result")
          .map(
            (activity) =>
              (activity.payload as { sourceAgentThreadId?: string }).sourceAgentThreadId,
          ),
      );
      return childProviderThreadIds.every((childProviderThreadId) =>
        sources.has(childProviderThreadId),
      );
    });
    expect(await readSubagentResultEvents()).toHaveLength(3);

    for (let updateIndex = 1; updateIndex < 10; updateIndex += 1) {
      for (const [childIndex, childProviderThreadId] of childProviderThreadIds.entries()) {
        harness.emit({
          type: "content.delta",
          eventId: asEventId(`evt-three-streaming-children-${childIndex}-${updateIndex}`),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-three-streaming-children"),
          itemId: asItemId(`child-message-${childIndex}`),
          providerRefs: {
            providerThreadId: childProviderThreadId,
            providerTurnId: `child-turn-${childIndex}`,
            providerItemId: asItemId(`child-message-${childIndex}`),
          },
          payload: {
            streamKind: "assistant_text",
            delta: `|${updateIndex}`,
          },
        });
      }
    }

    const thread = await waitForThread(harness.readModel, (entry) =>
      childProviderThreadIds.every((childProviderThreadId) =>
        entry.activities.some((activity) => {
          const payload = activity.payload as {
            sourceAgentThreadId?: string;
            data?: { subagentLiveText?: string };
          };
          return (
            activity.kind === "subagent.result" &&
            payload.sourceAgentThreadId === childProviderThreadId &&
            payload.data?.subagentLiveText === `${childProviderThreadId}:0|1|2|3|4|5|6|7|8|9`
          );
        }),
      ),
    );
    expect(
      thread.activities.filter((activity) => activity.kind === "subagent.result"),
    ).toHaveLength(3);

    expect(await readSubagentResultEvents()).toHaveLength(6);
  });

  it("uses the durable child roster when the projected parent provider id is missing", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-thread"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          providerThreadId: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "subagent.metadata.updated",
      eventId: asEventId("evt-known-child-metadata"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      payload: {
        callId: "call-known-child",
        agentThreadId: "known-child-provider-thread",
        agentPath: "/root/known_child",
        status: "running",
      },
    });
    await harness.drain();
    await waitForThread(harness.readModel, (thread) =>
      Boolean(
        thread.subagents?.some(
          (subagent) => subagent.agentThreadId === "known-child-provider-thread",
        ),
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-known-child-commentary-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("known-child-message"),
      providerRefs: {
        providerThreadId: "known-child-provider-thread",
        providerTurnId: "known-child-turn",
        providerItemId: asItemId("known-child-message"),
      },
      payload: {
        streamKind: "assistant_text",
        delta: "Known child commentary stays out of the parent chat.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-known-child-commentary-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("known-child-message"),
      providerRefs: {
        providerThreadId: "known-child-provider-thread",
        providerTurnId: "known-child-turn",
        providerItemId: asItemId("known-child-message"),
      },
      payload: {
        itemType: "assistant_message",
        status: "completed",
        data: {
          item: {
            phase: "commentary",
          },
        },
      },
    });
    await harness.drain();

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => {
        const payload = activity.payload as { sourceAgentThreadId?: string };
        return payload.sourceAgentThreadId === "known-child-provider-thread";
      }),
    );
    expect(thread.messages.some((message) => message.text.includes("Known child commentary"))).toBe(
      false,
    );
    expect(
      thread.activities.some((activity) => {
        const payload = activity.payload as { sourceAgentThreadId?: string };
        return (
          activity.kind === "subagent.result" &&
          payload.sourceAgentThreadId === "known-child-provider-thread"
        );
      }),
    ).toBe(true);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects a completed native review into an assistant message", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-review-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-review"),
      itemId: asItemId("review-result"),
      payload: {
        itemType: "review_exited",
        status: "completed",
        title: "Review completed",
        detail: "Found one correctness issue in the reconnect path.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:review-result" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:review-result",
    );
    expect(message?.role).toBe("assistant");
    expect(message?.turnId).toBe("turn-review");
    expect(message?.text).toBe("Found one correctness issue in the reconnect path.");
  });

  it("preserves completed tool metadata on projected tool activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-completed-with-data"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-completed"),
      itemId: asItemId("item-tool-completed"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        data: {
          toolCallId: "tool-read-1",
          kind: "read",
          rawOutput: {
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-completed-with-data",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-with-data",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("tool.completed");
    expect(activity?.summary).toBe("Read file");
    expect(payload?.itemType).toBe("dynamic_tool_call");
    expect(payload?.detail).toBeUndefined();
    expect(data?.toolCallId).toBe("tool-read-1");
    expect(data?.kind).toBe("read");
    expect(rawOutput?.content).toBe('import * as Effect from "effect/Effect"\n');
  });

  it("normalizes command execution activities to ran-command summaries", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-completed"),
      itemId: asItemId("item-command-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun run lint",
        data: {
          toolCallId: "tool-command-1",
          kind: "execute",
          command: "bun run lint",
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Ran command");
    expect(payload?.detail).toBe("bun run lint");
  });

  it("uses structured read-file paths when available", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-read-path-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-read-path"),
      itemId: asItemId("item-read-path"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        detail: "/tmp/app.ts",
        data: {
          toolCallId: "tool-read-path-1",
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-read-path-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-read-path-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Read file");
    expect(payload?.detail).toBe("/tmp/app.ts");
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas until completion when streaming is disabled", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when an approval request opens", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      itemId: asItemId("item-buffered-request-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      requestId: ApprovalRequestId.make("req-buffered-request-flush"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-flush" &&
          !message.streaming &&
          message.text === "visible before approval",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when user input is requested", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-user-input-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      itemId: asItemId("item-buffered-user-input-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before user input",
      },
    });
    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      requestId: ApprovalRequestId.make("req-buffered-user-input-flush"),
      payload: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Pick one",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-user-input-flush" &&
          !message.streaming &&
          message.text === "visible before user input",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-user-input-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("does not create assistant segments for whitespace-only buffered text at approval boundaries", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const startedAt = "2026-03-28T06:28:00.000Z";
    const pausedAt = "2026-03-28T06:28:01.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-whitespace-request",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      itemId: asItemId("item-buffered-whitespace-request"),
      payload: {
        streamKind: "assistant_text",
        delta: "\n\n\n",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      requestId: ApprovalRequestId.make("req-buffered-whitespace-request"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
      ),
    );
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace-request",
      ),
    ).toBe(false);
  });

  it("starts a new buffered assistant message segment after approval and completes without duplication", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const startedAt = "2026-03-28T06:07:00.000Z";
    const pausedAt = "2026-03-28T06:07:01.000Z";
    const resumedAt = "2026-03-28T06:07:02.000Z";
    const completedAt = "2026-03-28T06:07:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-append",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: "first half",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      requestId: ApprovalRequestId.make("req-buffered-request-append"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append" &&
          !message.streaming &&
          message.text === "first half",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: " second half",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append:segment:1" &&
          !message.streaming &&
          message.text === " second half",
      ),
    );
    const firstMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-append",
    );
    const resumedMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-request-append:segment:1",
    );
    expect(firstMessage?.text).toBe("first half");
    expect(firstMessage?.streaming).toBe(false);
    expect(resumedMessage?.text).toBe(" second half");
    expect(resumedMessage?.streaming).toBe(false);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId.startsWith("assistant:item-buffered-request-append"),
    );
    expect(assistantEvents).toHaveLength(4);
    expect(assistantEvents[0]?.payload.streaming).toBe(true);
    expect(assistantEvents[0]?.payload.text).toBe("first half");
    expect(assistantEvents[1]?.payload.streaming).toBe(false);
    expect(assistantEvents[1]?.payload.text).toBe("");
    expect(assistantEvents[2]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[2]?.payload.streaming).toBe(true);
    expect(assistantEvents[2]?.payload.text).toBe(" second half");
    expect(assistantEvents[3]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[3]?.payload.streaming).toBe(false);
    expect(assistantEvents[3]?.payload.text).toBe("");
  });

  it("starts a new streaming assistant message segment after approval", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const startedAt = "2026-03-28T07:00:00.000Z";
    const pausedAt = "2026-03-28T07:00:01.000Z";
    const resumedAt = "2026-03-28T07:00:02.000Z";
    const completedAt = "2026-03-28T07:00:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-request-segment",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: "before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      requestId: ApprovalRequestId.make("req-streaming-request-segment"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment" &&
          !message.streaming &&
          message.text === "before approval",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: " after approval",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1" &&
          !message.streaming &&
          message.text === " after approval",
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment",
      )?.text,
    ).toBe("before approval");
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1",
      )?.text,
    ).toBe(" after approval");
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("batches rapid streaming assistant deltas into one projected update", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-batch"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-batch"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-batch",
    );

    for (const [index, delta] of ["hello", " ", "batched"].entries()) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-message-delta-streaming-batch-${index}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-batch"),
        itemId: asItemId("item-streaming-batch"),
        payload: {
          streamKind: "assistant_text",
          delta,
        },
      });
    }

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-batch" &&
          message.streaming &&
          message.text === "hello batched",
      ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === "assistant:item-streaming-batch",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]?.payload.streaming).toBe(true);
    expect(assistantEvents[0]?.payload.text).toBe("hello batched");
  });

  it("holds incomplete inline code markdown while streaming assistant deltas", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-markdown-batch"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-markdown-batch"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-markdown-batch",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-markdown-batch-prefix"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-markdown-batch"),
      itemId: asItemId("item-streaming-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "Use ",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-markdown-batch" &&
          message.streaming &&
          message.text === "Use ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-markdown-batch-open"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-markdown-batch"),
      itemId: asItemId("item-streaming-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "`80",
      },
    });
    await Effect.runPromise(Effect.sleep("200 millis"));
    await harness.drain();

    const partialSnapshot = await harness.readModel();
    const partialThread = partialSnapshot.threads.find(
      (entry) => entry.id === asThreadId("thread-1"),
    );
    const partialMessage = partialThread?.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-markdown-batch",
    );
    expect(partialMessage?.text).toBe("Use ");

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-markdown-batch-close"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-markdown-batch"),
      itemId: asItemId("item-streaming-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "ms` chunks.",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-markdown-batch" &&
          message.streaming &&
          message.text === "Use `80ms` chunks.",
      ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === "assistant:item-streaming-markdown-batch",
    );
    expect(assistantEvents.map((event) => event.payload.text)).toEqual(["Use ", "`80ms` chunks."]);
  });

  it("holds incomplete emphasis and link markdown while streaming assistant deltas", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const messageId = "assistant:item-streaming-inline-markdown-batch";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-inline-markdown-batch"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-inline-markdown-batch",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-prefix"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "Styled ",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === messageId && message.streaming && message.text === "Styled ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-bold-open"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "**bo",
      },
    });
    await Effect.runPromise(Effect.sleep("200 millis"));
    await harness.drain();

    let snapshot = await harness.readModel();
    let thread = snapshot.threads.find((entry) => entry.id === asThreadId("thread-1"));
    let message = thread?.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === messageId,
    );
    expect(message?.text).toBe("Styled ");

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-bold-close"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "ld** and ",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId && candidate.text === "Styled **bold** and ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-italic-open"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "*it",
      },
    });
    await Effect.runPromise(Effect.sleep("200 millis"));
    await harness.drain();

    snapshot = await harness.readModel();
    thread = snapshot.threads.find((entry) => entry.id === asThreadId("thread-1"));
    message = thread?.messages.find((entry: ProviderRuntimeTestMessage) => entry.id === messageId);
    expect(message?.text).toBe("Styled **bold** and ");

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-italic-close"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "alic* with ",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId && candidate.text === "Styled **bold** and *italic* with ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-link-open"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "[ProviderRuntimeIngestion.ts",
      },
    });
    await Effect.runPromise(Effect.sleep("200 millis"));
    await harness.drain();

    snapshot = await harness.readModel();
    thread = snapshot.threads.find((entry) => entry.id === asThreadId("thread-1"));
    message = thread?.messages.find((entry: ProviderRuntimeTestMessage) => entry.id === messageId);
    expect(message?.text).toBe("Styled **bold** and *italic* with ");

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-inline-markdown-batch-link-close"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-inline-markdown-batch"),
      itemId: asItemId("item-streaming-inline-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "](file:///C:/repo/ProviderRuntimeIngestion.ts).",
      },
    });

    const finalText =
      "Styled **bold** and *italic* with [ProviderRuntimeIngestion.ts](file:///C:/repo/ProviderRuntimeIngestion.ts).";
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId && candidate.streaming && candidate.text === finalText,
      ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" && event.payload.messageId === messageId,
    );
    expect(assistantEvents.map((event) => event.payload.text)).toEqual([
      "Styled ",
      "**bold** and ",
      "*italic* with ",
      "[ProviderRuntimeIngestion.ts](file:///C:/repo/ProviderRuntimeIngestion.ts).",
    ]);
  });

  it("keeps streaming after emphasis that closes against punctuation", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const messageId = "assistant:item-streaming-punctuation-emphasis";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-punctuation-emphasis"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-punctuation-emphasis"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-punctuation-emphasis",
    );

    // The closing ** is preceded by a period, not an alphanumeric. It must
    // still count as a closer — otherwise every delta after it stays held
    // until the message completes and the tail arrives as one burst.
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-punctuation-emphasis-bold"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-punctuation-emphasis"),
      itemId: asItemId("item-streaming-punctuation-emphasis"),
      payload: {
        streamKind: "assistant_text",
        delta: "Logged **1.89 hours tonight.** ",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId &&
          candidate.streaming &&
          candidate.text === "Logged **1.89 hours tonight.** ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-punctuation-emphasis-tail"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-punctuation-emphasis"),
      itemId: asItemId("item-streaming-punctuation-emphasis"),
      payload: {
        streamKind: "assistant_text",
        delta: "The tail keeps streaming.",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId &&
          candidate.streaming &&
          candidate.text === "Logged **1.89 hours tonight.** The tail keeps streaming.",
      ),
    );
  });

  it("holds incomplete table markdown while streaming assistant deltas", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const messageId = "assistant:item-streaming-table-markdown-batch";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-table-markdown-batch"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-table-markdown-batch"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-table-markdown-batch",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-table-markdown-batch-prefix"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-table-markdown-batch"),
      itemId: asItemId("item-streaming-table-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "A table:\n\n",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === messageId && message.streaming && message.text === "A table:\n\n",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-table-markdown-batch-header"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-table-markdown-batch"),
      itemId: asItemId("item-streaming-table-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "| Area | Reference | Purpose |\n",
      },
    });
    await Effect.runPromise(Effect.sleep("200 millis"));
    await harness.drain();

    let snapshot = await harness.readModel();
    let thread = snapshot.threads.find((entry) => entry.id === asThreadId("thread-1"));
    let message = thread?.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === messageId,
    );
    expect(message?.text).toBe("A table:\n\n");

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-table-markdown-batch-separator"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-table-markdown-batch"),
      itemId: asItemId("item-streaming-table-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "| --- | --- | --- |\n",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId &&
          candidate.text === "A table:\n\n| Area | Reference | Purpose |\n| --- | --- | --- |\n",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-table-markdown-batch-row-open"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-table-markdown-batch"),
      itemId: asItemId("item-streaming-table-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "| Flush interval | `50ms` | Smoother",
      },
    });
    await Effect.runPromise(Effect.sleep("200 millis"));
    await harness.drain();

    snapshot = await harness.readModel();
    thread = snapshot.threads.find((entry) => entry.id === asThreadId("thread-1"));
    message = thread?.messages.find((entry: ProviderRuntimeTestMessage) => entry.id === messageId);
    expect(message?.text).toBe("A table:\n\n| Area | Reference | Purpose |\n| --- | --- | --- |\n");

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-table-markdown-batch-row-close"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-table-markdown-batch"),
      itemId: asItemId("item-streaming-table-markdown-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: " text |\n",
      },
    });

    const finalText =
      "A table:\n\n| Area | Reference | Purpose |\n| --- | --- | --- |\n| Flush interval | `50ms` | Smoother text |\n";
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (candidate: ProviderRuntimeTestMessage) =>
          candidate.id === messageId && candidate.streaming && candidate.text === finalText,
      ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" && event.payload.messageId === messageId,
    );
    expect(assistantEvents.map((event) => event.payload.text)).toEqual([
      "A table:\n\n",
      "| Area | Reference | Purpose |\n| --- | --- | --- |\n",
      "| Flush interval | `50ms` | Smoother text |\n",
    ]);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const now = "2026-01-01T00:00:00.000Z";
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    const afterItemCompletion = await waitForThread(harness.readModel, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-complete-dedup" && !message.streaming,
      ),
    );
    expect(afterItemCompletion.session?.activeTurnId).toBe("turn-complete-dedup");
    expect(afterItemCompletion.latestTurn).toMatchObject({
      turnId: "turn-complete-dedup",
      state: "running",
      completedAt: null,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
    const completionEvent = completionEvents[0];
    expect(completionEvent?.type).toBe("thread.message-sent");
    if (completionEvent?.type !== "thread.message-sent") {
      throw new Error("Expected one assistant message completion event");
    }
    expect(completionEvent.payload.completesTurn).toBe(false);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("labels authentication runtime errors distinctly", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-auth-error"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-auth-error"),
      payload: {
        message: "Failed to authenticate.",
        class: "authentication_error",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-auth-error"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-auth-error",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Authentication required");
    expect(activityPayload?.class).toBe("authentication_error");
    expect(activityPayload?.provider).toBe("claudeAgent");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      itemId: asItemId("item-tool-started"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
        data: { item: { command: "Get-Content /tmp/file.ts" } },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
    const toolStartedActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
    );
    const toolStartedPayload =
      toolStartedActivity?.payload && typeof toolStartedActivity.payload === "object"
        ? (toolStartedActivity.payload as Record<string, unknown>)
        : undefined;
    expect(toolStartedPayload?.toolCallId).toBe("item-tool-started");
    expect(toolStartedPayload?.title).toBe("Read file");
    expect(toolStartedPayload?.data).toEqual({ item: { command: "Get-Content /tmp/file.ts" } });
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff:
          "diff --git a/file.txt b/file.txt\nindex e69de29..ce01362 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1 @@\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.kind === "tool.completed" && activity.summary === "Changed files",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
    expect(checkpoint?.files).toEqual([
      {
        path: "file.txt",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
    ]);

    const fileActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "tool.completed" && activity.summary === "Changed files",
    );
    const fileActivityPayload =
      fileActivity?.payload && typeof fileActivity.payload === "object"
        ? (fileActivity.payload as { itemType?: string; data?: { files?: unknown[] } })
        : undefined;
    expect(fileActivity?.id).toBe("checkpoint-files:thread-1:turn-p1:1");
    expect(fileActivityPayload?.itemType).toBe("file_change");
    expect(fileActivityPayload?.data?.files).toEqual(checkpoint?.files);
  });

  it("refreshes the active turn's summary from later cumulative diffs and ignores late ones", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-cumulative-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cumulative"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-cumulative",
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-cumulative-diff-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cumulative"),
      payload: {
        unifiedDiff:
          "diff --git a/file.txt b/file.txt\nindex e69de29..ce01362 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1 @@\n+hello\n",
      },
    });
    const afterFirst = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-cumulative",
      ),
    );
    const placeholder = afterFirst.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-cumulative",
    );
    expect(afterFirst.session?.status).toBe("running");
    expect(afterFirst.session?.activeTurnId).toBe("turn-cumulative");
    expect(afterFirst.latestTurn).toMatchObject({
      turnId: "turn-cumulative",
      state: "running",
      completedAt: null,
    });
    expect(placeholder?.files).toEqual([
      { path: "file.txt", kind: "modified", additions: 1, deletions: 0 },
    ]);

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-cumulative-diff-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:05.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cumulative"),
      payload: {
        unifiedDiff: [
          "diff --git a/file.txt b/file.txt\nindex e69de29..ce01362 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n",
          "diff --git a/second.txt b/second.txt\nindex e69de29..ce01362 100644\n--- a/second.txt\n+++ b/second.txt\n@@ -0,0 +1 @@\n+more\n",
        ].join(""),
      },
    });
    const afterSecond = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (entry: ProviderRuntimeTestCheckpoint) =>
          entry.turnId === "turn-cumulative" && entry.files.length === 2,
      ),
    );
    const refreshed = afterSecond.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-cumulative",
    );
    expect(refreshed?.files).toEqual([
      { path: "file.txt", kind: "modified", additions: 2, deletions: 0 },
      { path: "second.txt", kind: "modified", additions: 1, deletions: 0 },
    ]);
    // The refresh patches files only; the placeholder's identity is untouched.
    expect(refreshed?.checkpointRef).toBe("provider-diff:evt-cumulative-diff-1");
    expect(refreshed?.checkpointTurnCount).toBe(placeholder?.checkpointTurnCount);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-cumulative-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:06.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cumulative"),
      status: "completed",
    });
    await waitForThread(harness.readModel, (thread) => thread.session?.activeTurnId === null);

    // A notification that arrives after the turn settled must not clobber the
    // now-authoritative summary.
    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-cumulative-diff-late"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:07.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cumulative"),
      payload: {
        unifiedDiff:
          "diff --git a/late.txt b/late.txt\nindex e69de29..ce01362 100644\n--- a/late.txt\n+++ b/late.txt\n@@ -0,0 +1 @@\n+late\n",
      },
    });
    await harness.drain();
    const final = await harness.readModel();
    const finalCheckpoint = final.threads
      .find((entry) => entry.id === ThreadId.make("thread-1"))
      ?.checkpoints.find(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-cumulative",
      );
    expect(finalCheckpoint?.files).toEqual(refreshed?.files);
  });

  it("builds claude turn summaries from accumulated per-tool file-change evidence", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-evidence"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-claude-evidence-turn-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-files"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-claude-files",
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-claude-edit-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-files"),
      itemId: asItemId("item-claude-edit-1"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "Edit a.ts",
        data: {
          toolName: "Edit",
          changes: [{ path: "src/a.ts", kind: "update", additions: 3, deletions: 1 }],
        },
      },
    });
    const afterFirst = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-claude-files",
      ),
    );
    expect(
      afterFirst.checkpoints.find(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-claude-files",
      )?.files,
    ).toEqual([{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }]);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-claude-edit-2"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-files"),
      itemId: asItemId("item-claude-edit-2"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "Write b.ts",
        data: {
          toolName: "Write",
          changes: [
            { path: "src/a.ts", kind: "update", additions: 2, deletions: 0 },
            { path: "src/b.ts", kind: "add", additions: 5, deletions: 0 },
          ],
        },
      },
    });
    const afterSecond = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (entry: ProviderRuntimeTestCheckpoint) =>
          entry.turnId === "turn-claude-files" && entry.files.length === 2,
      ),
    );
    expect(
      afterSecond.checkpoints.find(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-claude-files",
      )?.files,
    ).toEqual([
      { path: "src/a.ts", kind: "modified", additions: 5, deletions: 1 },
      { path: "src/b.ts", kind: "add", additions: 5, deletions: 0 },
    ]);
  });

  it("unions a codex child agent's edits with the parent's cumulative turn diff", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";
    const childRefs = {
      providerThreadId: "child-provider-thread",
      providerTurnId: "child-turn-1",
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-child-evidence"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          providerThreadId: "parent-provider-thread",
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-child-evidence-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child-files"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-child-files",
    );

    // The child's edit lands first: with no cumulative diff yet, it is the
    // only evidence the turn has.
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-child-file-change-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child-files"),
      itemId: asItemId("child-file-change-1"),
      providerRefs: { ...childRefs, providerItemId: asItemId("child-file-change-1") },
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        data: {
          item: {
            type: "fileChange",
            changes: [
              {
                path: "src/child.ts",
                kind: { type: "update" },
                diff: "--- a/src/child.ts\n+++ b/src/child.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
              },
            ],
          },
        },
      },
    });
    const afterChild = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-child-files",
      ),
    );
    expect(
      afterChild.checkpoints.find(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-child-files",
      )?.files,
    ).toEqual([{ path: "src/child.ts", kind: "modified", additions: 2, deletions: 1 }]);

    // The parent's cumulative diff has only caught up with its own edit. The
    // child's stays until git sees it.
    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-child-evidence-wholesale"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child-files"),
      payload: {
        unifiedDiff:
          "diff --git a/src/parent.ts b/src/parent.ts\nindex e69de29..ce01362 100644\n--- a/src/parent.ts\n+++ b/src/parent.ts\n@@ -0,0 +1 @@\n+parent\n",
      },
    });
    const afterUnion = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (entry: ProviderRuntimeTestCheckpoint) =>
          entry.turnId === "turn-child-files" && entry.files.length === 2,
      ),
    );
    expect(
      afterUnion.checkpoints.find(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-child-files",
      )?.files,
    ).toEqual([
      { path: "src/child.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/parent.ts", kind: "modified", additions: 1, deletions: 0 },
    ]);

    // Once git covers a path, the cumulative diff is the truth for it: a
    // child item naming the same file must not add its lines on top.
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-child-file-change-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child-files"),
      itemId: asItemId("child-file-change-2"),
      providerRefs: { ...childRefs, providerItemId: asItemId("child-file-change-2") },
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        data: {
          item: {
            type: "fileChange",
            changes: [
              {
                path: "src/parent.ts",
                kind: { type: "update" },
                diff: "--- a/src/parent.ts\n+++ b/src/parent.ts\n@@ -0,0 +1,9 @@\n+a\n+b\n+c\n+d\n+e\n+f\n+g\n+h\n+i\n",
              },
            ],
          },
        },
      },
    });
    await harness.drain();
    const final = await harness.readModel();
    expect(
      final.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.checkpoints.find(
          (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-child-files",
        )?.files,
    ).toEqual([
      { path: "src/child.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/parent.ts", kind: "modified", additions: 1, deletions: 0 },
    ]);
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
    expect((activity?.payload as Record<string, unknown> | undefined)?.status).toBe("completed");
  });

  it("projects provider compacting status into a running context compaction activity", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-claude-compacting"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "waiting",
        reason: "status:compacting",
        detail: { status: "compacting" },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "context-compaction" && activity.summary === "Compacting context...",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(activity?.summary).toBe("Compacting context...");
    expect(activity?.tone).toBe("info");
    expect(payload?.status).toBe("inProgress");
    expect(payload?.state).toBe("waiting");
  });

  it("updates Codex context compaction item activity from running to compacted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-context-compaction-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      itemId: asItemId("item-context-compaction"),
      payload: {
        itemType: "context_compaction",
        status: "inProgress",
        title: "Context compaction",
        detail: "Summarizing earlier conversation",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "context-compaction" && activity.summary === "Compacting context...",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-context-compaction-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      itemId: asItemId("item-context-compaction"),
      payload: {
        itemType: "context_compaction",
        status: "completed",
        title: "Context compaction",
        detail: "Summarized earlier conversation",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "context-compaction" && activity.summary === "Context compacted",
      ),
    );

    const activities = thread.activities.filter(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]?.summary).toBe("Context compacted");
    expect((activities[0]?.payload as Record<string, unknown> | undefined)?.status).toBe(
      "completed",
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted-after-context-item"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "thread-event" },
      },
    });

    const updatedThread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity: ProviderRuntimeTestActivity) => {
        if (activity.kind !== "context-compaction") {
          return false;
        }
        const payload = activity.payload as Record<string, unknown> | undefined;
        return payload?.state === "compacted";
      }),
    );

    const updatedActivities = updatedThread.activities.filter(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
    );
    expect(updatedActivities).toHaveLength(1);
    expect((updatedActivities[0]?.payload as Record<string, unknown> | undefined)?.status).toBe(
      "completed",
    );
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects reasoning summary deltas into a stable thinking activity", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("item-reasoning"),
      payload: {
        streamKind: "reasoning_summary_text",
        delta: "Inspecting ",
        summaryIndex: 0,
      },
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("item-reasoning"),
      payload: {
        streamKind: "reasoning_summary_text",
        delta: "the event pipeline ".repeat(8),
        summaryIndex: 0,
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "thinking.progress" &&
          JSON.stringify(activity.payload).includes("Inspecting the event pipeline"),
      ),
    );

    const thinkingActivities = thread.activities.filter(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "thinking.progress",
    );
    expect(thinkingActivities).toHaveLength(1);
    expect(thinkingActivities[0]?.tone).toBe("thinking");
  });

  it("projects reasoning lifecycle events as visible thinking activity", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-reasoning-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-lifecycle"),
      itemId: asItemId("reasoning-item-1"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
        data: {
          item: {
            id: "reasoning-item-1",
            type: "reasoning",
            content: [],
            summary: [],
          },
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "thinking.progress" &&
          JSON.stringify(activity.payload).includes("inProgress"),
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.kind === "thinking.progress",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    expect(activity?.tone).toBe("thinking");
    expect(activity?.summary).toBe("Thinking");
    expect(payload?.status).toBe("inProgress");
    expect(payload?.redacted).toBe(true);
  });

  it("projects command output deltas as tool output activity", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-output"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        streamKind: "command_output",
        delta: "linting files\n",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.output.updated",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.kind === "tool.output.updated",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    expect(payload?.itemType).toBe("command_execution");
    expect(payload?.detail).toBe("linting files");
    expect(payload?.status).toBe("inProgress");
  });

  it("coalesces tiny command output deltas before appending another activity update", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const baseEvent = {
      type: "content.delta" as const,
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output-coalesced"),
      itemId: asItemId("item-command-output-coalesced"),
      payload: {
        streamKind: "command_output" as const,
        delta: "",
      },
    };

    harness.emit({
      ...baseEvent,
      eventId: asEventId("evt-command-output-coalesced-1"),
      payload: {
        ...baseEvent.payload,
        delta: "a",
      },
    });
    harness.emit({
      ...baseEvent,
      eventId: asEventId("evt-command-output-coalesced-2"),
      payload: {
        ...baseEvent.payload,
        delta: "b",
      },
    });

    await harness.drain();
    let thread = await harness.readModel();
    let activity = thread.threads
      .find((entry) => entry.id === "thread-1")
      ?.activities.find(
        (entry: ProviderRuntimeTestActivity) => entry.kind === "tool.output.updated",
      );
    let payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    expect(payload?.detail).toBe("a");

    harness.emit({
      ...baseEvent,
      eventId: asEventId("evt-command-output-coalesced-3"),
      payload: {
        ...baseEvent.payload,
        delta: "c".repeat(2048),
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((candidate: ProviderRuntimeTestActivity) => {
        const candidatePayload =
          candidate.payload && typeof candidate.payload === "object"
            ? (candidate.payload as Record<string, unknown>)
            : undefined;
        return candidate.kind === "tool.output.updated" && candidatePayload?.byteCount === 2050;
      }),
    );
    thread = await harness.readModel();
    activity = thread.threads
      .find((entry) => entry.id === "thread-1")
      ?.activities.find(
        (entry: ProviderRuntimeTestActivity) => entry.kind === "tool.output.updated",
      );
    payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    expect(payload?.byteCount).toBe(2050);
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
