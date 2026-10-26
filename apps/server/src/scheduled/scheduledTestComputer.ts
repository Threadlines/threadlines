/**
 * One computer for scheduled-task tests (ScheduledTasks.test.ts,
 * WebhookEvents.test.ts): the real orchestration engine, projections, thread
 * setup and scheduled-task tables on one in-memory database, with fakes for
 * what lives outside it: the relay's hooks, `gh`, and the secret store.
 * `boot` starts a scheduler process on it; booting another later is a
 * restart of that process.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RelayHookId,
  type ScheduledTaskCreateInput,
  type ScheduledTaskId,
  type ServerProvider,
  type ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapLive } from "../orchestration/Layers/ThreadBootstrap.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBootstrap,
  type ThreadBootstrapShape,
} from "../orchestration/Services/ThreadBootstrap.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  type RelayHookOpened,
  RelayHooks,
  RelayHooksError,
  type RelayHooksChange,
  type RelayHookWanted,
} from "../relay/RelayHooks.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitHubCli, GitHubCliError } from "../sourceControl/GitHubCli.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { ScheduledTaskRepository, ScheduledTaskRepositoryLive } from "./ScheduledTaskRepository.ts";
import { ScheduledTasks, ScheduledTasksLive } from "./ScheduledTasks.ts";
import { WebhookTaskRepository, WebhookTaskRepositoryLive } from "./WebhookTaskRepository.ts";

export const AT = "2026-10-20T10:00:00.000Z";
export const PROJECT = ProjectId.make("project-1");
export const CODEX = ProviderInstanceId.make("codex");

export const PROVIDER = {
  instanceId: CODEX,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro Subscription" },
  models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false }],
} as unknown as ServerProvider;

export const draft = (patch: Partial<ScheduledTaskCreateInput> = {}): ScheduledTaskCreateInput => ({
  name: "Morning review",
  prompt: "Review yesterday's commits and list anything risky.",
  projectId: PROJECT,
  checkout: "local",
  modelSelection: { instanceId: CODEX, model: "gpt-6-astra" },
  runtimeMode: "auto",
  interactionMode: "default",
  cadence: { kind: "daily", time: { hour: 9, minute: 0 } },
  timeZone: "UTC",
  target: { kind: "new_thread" },
  ...patch,
});

/** Real time: launches are forked, and these suites run on the test clock. */
export const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

export const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (yield* check) return;
      yield* wallClockSleep(20);
    }
    return yield* Effect.die(new Error(`Timed out waiting until ${what}.`));
  });

export const setClock = (iso: string) => TestClock.setTime(Date.parse(iso));

/**
 * The relay's hooks as a test drives them: hooks minted while `reachable`
 * under `hostId`, every wanted list sent, deliveries pushed in, acks and
 * changes recorded.
 */
const makeFakeRelay = Effect.gen(function* () {
  const deliveries = yield* Queue.unbounded<RelayHookOpened>();
  const changes = yield* Queue.unbounded<RelayHooksChange>();
  const state = {
    hostId: "host-1",
    reachable: true,
    minted: 0,
    wanted: [] as Array<ReadonlyArray<RelayHookWanted>>,
    acked: [] as Array<string>,
  };
  const layer = Layer.succeed(
    RelayHooks,
    RelayHooks.of({
      mint: () =>
        Effect.suspend(() => {
          if (!state.reachable) return Effect.fail(new RelayHooksError({ detail: "Offline." }));
          state.minted += 1;
          const hookId = RelayHookId.make(`hook-${state.minted}`);
          return Effect.succeed({
            hookId,
            url: `https://relay.test/v2/hooks/${state.hostId}/${hookId}/mac`,
            hostId: state.hostId,
          });
        }),
      setActive: (hooks) => Effect.sync(() => void state.wanted.push(hooks)),
      deliveries: Stream.fromQueue(deliveries),
      ack: (ids) => Effect.sync(() => void state.acked.push(...ids)),
      hostId: Effect.sync(() => state.hostId),
      changes: Stream.fromQueue(changes),
      connected: Effect.sync(() => state.reachable),
    }),
  );
  return {
    layer,
    state,
    /** The relay hands over one delivery. */
    deliver: (opened: RelayHookOpened) => Queue.offer(deliveries, opened),
    change: (change: RelayHooksChange) => Queue.offer(changes, change),
    /** The hooks the relay was last told to keep active. */
    active: () => state.wanted.at(-1) ?? [],
  };
});

/**
 * `gh` as a test drives it: `respond` answers each call (signed in as
 * badcuban, a new webhook is number 42); every call is recorded.
 */
const makeFakeGitHub = () => {
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }> = [];
  const state = {
    /** Runs before each call is answered: a test holds one here. */
    before: (_args: ReadonlyArray<string>): Effect.Effect<void> => Effect.void,
    respond: (
      args: ReadonlyArray<string>,
    ): { readonly stdout: string } | { readonly fail: string } => {
      if (args[0] === "auth") {
        return {
          stdout: JSON.stringify({
            hosts: {
              "github.com": [
                { state: "success", active: true, host: "github.com", login: "badcuban" },
              ],
            },
          }),
        };
      }
      if (args.includes("POST")) return { stdout: JSON.stringify({ id: 42 }) };
      return { stdout: "{}" };
    },
  };
  const layer = Layer.mock(GitHubCli)({
    execute: (input) =>
      Effect.suspend(() => {
        calls.push({
          args: input.args,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        });
        return state.before(input.args).pipe(
          Effect.flatMap(() => {
            const answer = state.respond(input.args);
            return "fail" in answer
              ? Effect.fail(new GitHubCliError({ operation: "execute", detail: answer.fail }))
              : Effect.succeed({
                  exitCode: 0 as never,
                  stdout: answer.stdout,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                });
          }),
        );
      }),
  });
  return { layer, calls, state };
};

/** The server's secret store, in memory; it outlives a restart like the real one. */
const makeFakeSecrets = () => {
  const secrets = new Map<string, Uint8Array>();
  const layer = Layer.succeed(ServerSecretStore, {
    get: (name) => Effect.sync(() => secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing) return existing;
        const created = crypto.getRandomValues(new Uint8Array(bytes));
        secrets.set(name, created);
        return created;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  return { layer, secrets };
};

export const makeComputer = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-tasks-project-"));
  const orchestration = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const bootstrapLayer = ThreadBootstrapLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitWorkflowService)({}),
        Layer.mock(VcsStatusBroadcaster)({}),
        Layer.mock(ProjectSetupScriptRunner)({}),
      ),
    ),
  );
  const base = Layer.mergeAll(
    bootstrapLayer,
    ScheduledTaskRepositoryLive,
    WebhookTaskRepositoryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(
    Layer.provideMerge(orchestration),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(
      Layer.mock(RepositoryIdentityResolver)({
        resolve: () =>
          Effect.succeed({
            canonicalKey: "github.com/acme/app",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/app.git",
            },
          }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-tasks-test-" })),
  );
  const context = yield* Layer.buildWithScope(base, scope);
  const engine = Context.get(context, OrchestrationEngineService);
  const snapshots = Context.get(context, ProjectionSnapshotQuery);
  const repo = Context.get(context, ScheduledTaskRepository);
  const webhooks = Context.get(context, WebhookTaskRepository);
  const realBootstrap = Context.get(context, ThreadBootstrap);
  const relay = yield* makeFakeRelay;
  const github = makeFakeGitHub();
  const secrets = makeFakeSecrets();

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId: PROJECT,
    title: "threadlines",
    workspaceRoot,
    defaultModelSelection: null,
    createdAt: AT,
  });

  const boot = (
    patch: {
      readonly bootstrap?: Partial<ThreadBootstrapShape>;
      readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
      /** The agents the server reports; Codex, signed in, otherwise. */
      readonly providers?: ReadonlyArray<ServerProvider>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const layer = ScheduledTasksLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ThreadBootstrap, { ...realBootstrap, ...patch.bootstrap }),
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed(patch.providers ?? [PROVIDER]),
            }),
            Layer.mock(GitVcsDriver)({}),
            Layer.mock(GitWorkflowService)({}),
            ServerEnvironment.layerTest({ label: "Test Mac" }),
            ServerSettingsService.layerTest(patch.settings),
            relay.layer,
            github.layer,
            secrets.layer,
          ),
        ),
        Layer.provide(Layer.succeedContext(context)),
      );
      return Context.get(yield* Layer.buildWithScope(layer, scope), ScheduledTasks);
    });

  const thread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));
  const runs = (taskId: ScheduledTaskId) =>
    repo.listRuns({ taskId, limit: 50 }).pipe(Effect.map((rows) => rows.toReversed()));
  const events = engine.readEvents(0).pipe(Stream.runCollect);

  /** The thread's agent starts work on `turnId`: the turn binds to the pending message. */
  const turnRuns = (threadId: ThreadId, turnId: TurnId) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`session-running:${threadId}:${turnId}`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: CODEX,
        runtimeMode: "auto",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: AT,
      },
      createdAt: AT,
    });

  const turnCompletes = (threadId: ThreadId, turnId: TurnId) =>
    engine.dispatch({
      type: "thread.turn.complete",
      commandId: CommandId.make(`turn-complete:${threadId}:${turnId}`),
      threadId,
      turnId,
      state: "completed",
      completedAt: AT,
      createdAt: AT,
    });

  return {
    engine,
    repo,
    webhooks,
    workspaceRoot,
    boot,
    thread,
    runs,
    events,
    turnRuns,
    turnCompletes,
    bootstrap: realBootstrap,
    relay,
    github,
    secrets,
  };
});

export type TestComputer = Effect.Success<typeof makeComputer>;
