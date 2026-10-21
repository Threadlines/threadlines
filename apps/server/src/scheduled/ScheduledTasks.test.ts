import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTaskCreateInput,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpSessionRegistry.ts";
import { roomToolsFor } from "../mcp/roomToolAccess.ts";
import { makeScheduleToolHandlers } from "../mcp/scheduleToolHandlers.ts";
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
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { scheduledRunMessageId, scheduledRunThreadId } from "./scheduledRunIds.ts";
import { ScheduledTaskRepository, ScheduledTaskRepositoryLive } from "./ScheduledTaskRepository.ts";
import { ScheduledTasks, ScheduledTasksLive } from "./ScheduledTasks.ts";

const AT = "2026-10-20T10:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const CODEX = ProviderInstanceId.make("codex");

const PROVIDER = {
  instanceId: CODEX,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro Subscription" },
  models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false }],
} as unknown as ServerProvider;

const draft = (patch: Partial<ScheduledTaskCreateInput> = {}): ScheduledTaskCreateInput => ({
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
const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (yield* check) return;
      yield* wallClockSleep(20);
    }
    return yield* Effect.die(new Error(`Timed out waiting until ${what}.`));
  });

/**
 * One computer: the real orchestration engine, projections, thread setup
 * and scheduled-task tables on one database. `boot` starts a scheduler
 * process on it; booting another later is a restart of that process.
 */
const makeComputer = Effect.gen(function* () {
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
    ProjectionTurnRepositoryLive,
  ).pipe(
    Layer.provideMerge(orchestration),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(
      Layer.mock(RepositoryIdentityResolver)({ resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-tasks-test-" })),
  );
  const context = yield* Layer.buildWithScope(base, scope);
  const engine = Context.get(context, OrchestrationEngineService);
  const snapshots = Context.get(context, ProjectionSnapshotQuery);
  const repo = Context.get(context, ScheduledTaskRepository);
  const realBootstrap = Context.get(context, ThreadBootstrap);

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
    } = {},
  ) =>
    Effect.gen(function* () {
      const layer = ScheduledTasksLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ThreadBootstrap, { ...realBootstrap, ...patch.bootstrap }),
            Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([PROVIDER]) }),
            Layer.mock(GitVcsDriver)({}),
            Layer.mock(GitWorkflowService)({}),
            ServerSettingsService.layerTest(patch.settings),
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
    boot,
    thread,
    runs,
    events,
    turnRuns,
    turnCompletes,
    bootstrap: realBootstrap,
  };
});

const setClock = (iso: string) => TestClock.setTime(Date.parse(iso));

it.layer(NodeServices.layer)("ScheduledTasks", (it) => {
  it.effect("runs a due slot once, as a new thread marked as the task's run", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(draft());
      assert.equal(task.nextRunAt, "2026-10-20T09:00:00.000Z");

      yield* service.tick;
      assert.deepEqual(yield* computer.runs(task.id), []);

      yield* setClock("2026-10-20T09:00:10.000Z");
      yield* service.tick;
      yield* service.tick;
      const threadId = scheduledRunThreadId(task.id, "2026-10-20T09:00:00.000Z");
      yield* eventually(
        computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
        "the run started",
      );

      const rows = yield* computer.runs(task.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.trigger, "schedule");
      assert.equal(rows[0]?.threadId, threadId);
      const thread = (yield* computer.thread(threadId))!;
      assert.equal(thread.title, "Morning review");
      assert.deepEqual(thread.scheduledRun, {
        taskId: task.id,
        taskName: "Morning review",
        slotUtc: "2026-10-20T09:00:00.000Z",
      });
      assert.include(thread.messages[0]?.text ?? "", "Review yesterday's commits");
      // Codex takes the Threadlines tools: the message says how to finish quietly.
      assert.include(thread.messages[0]?.text ?? "", "scheduled_run_finish");
      const next = yield* service.getTask(task.id);
      assert.equal(next?.nextRunAt, "2026-10-21T09:00:00.000Z");
    }),
  );

  it.effect("many missed slots make one catch-up run and one skipped row", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T09:30:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(draft({ cadence: { kind: "hourly", minute: 0 } }));
      // Asleep from 10:00 until 15:30.
      yield* setClock("2026-10-20T15:30:00.000Z");
      yield* service.tick;

      const rows = yield* computer.runs(task.id);
      assert.deepEqual(
        rows.map((row) => [row.slotUtc, row.trigger, row.status === "skipped", row.reason]),
        [
          [
            "2026-10-20T10:00:00.000Z",
            "catch_up",
            true,
            "Missed 5 runs while the computer was off or asleep.",
          ],
          ["2026-10-20T15:00:00.000Z", "catch_up", false, null],
        ],
      );
      assert.equal((yield* service.getTask(task.id))?.nextRunAt, "2026-10-20T16:00:00.000Z");
    }),
  );

  it.effect("a slot missed more than a week ago gets no catch-up run", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-09-20T08:00:00.000Z");
      const service = yield* computer.boot();
      // The 1st of every month at 9:00, missed on Oct 1.
      const task = yield* service.create(draft({ cadence: { kind: "custom", cron: "0 9 1 * *" } }));
      yield* setClock("2026-10-10T08:00:00.000Z");
      yield* service.tick;

      const rows = yield* computer.runs(task.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "skipped");
      assert.equal(rows[0]?.reason, "The computer was off or asleep.");
      assert.equal((yield* service.getTask(task.id))?.nextRunAt, "2026-11-01T09:00:00.000Z");
    }),
  );

  it.effect("a one-time task runs once, is done, and runs again only when given a new time", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(
        draft({ cadence: { kind: "once", date: "2026-10-21", time: { hour: 7, minute: 30 } } }),
      );
      assert.equal(task.nextRunAt, "2026-10-21T07:30:00.000Z");

      yield* setClock("2026-10-21T07:30:05.000Z");
      yield* service.tick;
      yield* setClock("2026-10-22T07:30:05.000Z");
      yield* service.tick;
      assert.deepEqual(
        (yield* computer.runs(task.id)).map((row) => row.slotUtc),
        ["2026-10-21T07:30:00.000Z"],
      );
      const done = yield* service.getTask(task.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.nextRunAt, null);

      // A rename leaves it done, its unchanged schedule sent along as the
      // form sends it; a new date makes it active again.
      assert.equal(
        (yield* service.update({
          id: task.id,
          name: "Release check",
          cadence: { kind: "once", date: "2026-10-21", time: { hour: 7, minute: 30 } },
          timeZone: "UTC",
        })).status,
        "done",
      );
      const again = yield* service.update({
        id: task.id,
        cadence: { kind: "once", date: "2026-10-23", time: { hour: 7, minute: 30 } },
      });
      assert.equal(again.status, "active");
      assert.equal(again.nextRunAt, "2026-10-23T07:30:00.000Z");
      // A time already past can't be saved.
      const past = yield* service
        .update({
          id: task.id,
          cadence: { kind: "once", date: "2026-10-22", time: { hour: 7, minute: 0 } },
        })
        .pipe(Effect.flip);
      assert.match(past.detail, /already passed/);
    }),
  );

  it.effect("a one-time task whose time passed unseen can still be paused", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(
        draft({ cadence: { kind: "once", date: "2026-10-20", time: { hour: 9, minute: 0 } } }),
      );
      // Asleep through its time, and paused before the scheduler looked.
      yield* setClock("2026-10-20T10:00:00.000Z");
      const paused = yield* service.update({ id: task.id, status: "paused" });
      assert.equal(paused.status, "paused");
      yield* service.tick;
      assert.deepEqual(yield* computer.runs(task.id), []);
    }),
  );

  it.effect("a one-time task's only run waits for room instead of being skipped", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(
        draft({ cadence: { kind: "once", date: "2026-10-20", time: { hour: 9, minute: 0 } } }),
      );
      // Its own run, started by hand, still works at its time.
      const manual = yield* service.runNow({ id: task.id });
      const manualThread = scheduledRunThreadId(task.id, manual.slotUtc);
      yield* eventually(
        computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
        "the manual run started",
      );
      yield* setClock("2026-10-20T09:00:05.000Z");
      yield* service.tick;
      assert.equal((yield* computer.runs(task.id)).length, 1);
      assert.equal((yield* service.getTask(task.id))?.nextRunAt, "2026-10-20T09:00:00.000Z");

      // Once that run ends, it runs: late, so as a catch-up.
      const turnId = TurnId.make("manual-turn");
      yield* computer.turnRuns(manualThread, turnId);
      yield* computer.turnCompletes(manualThread, turnId);
      yield* setClock("2026-10-20T09:10:00.000Z");
      yield* service.tick;
      yield* service.tick;
      assert.deepEqual(
        (yield* computer.runs(task.id)).map((row) => [row.trigger, row.status === "skipped"]),
        [
          ["manual", false],
          ["catch_up", false],
        ],
      );
      assert.equal((yield* service.getTask(task.id))?.status, "done");
    }),
  );

  it.effect(
    "a slot claimed from a read older than an edit is refused; the next tick runs the edit",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* setClock("2026-10-20T08:00:00.000Z");
        const service = yield* computer.boot();
        const task = yield* service.create(draft({ cadence: { kind: "hourly", minute: 0 } }));
        yield* setClock("2026-10-20T09:00:05.000Z");
        // A tick read the task, then the user changed its instructions.
        const read = Option.getOrThrow(yield* computer.repo.getTask(task.id));
        yield* service.update({ id: task.id, prompt: "Only look at the release branch." });
        const stale = yield* computer.repo.claimSlot({
          taskId: task.id,
          expectedRevision: read.revision,
          expectedNextSlotUtc: read.nextSlotUtc!,
          nextSlotUtc: "2026-10-20T10:00:00.000Z",
          done: false,
          waitWhenBusy: false,
          missed: null,
          run: {
            slotUtc: read.nextSlotUtc!,
            trigger: "schedule",
            launch: {
              taskName: read.name,
              prompt: read.prompt,
              projectId: read.projectId,
              checkout: read.checkout,
              workspace: null,
              modelSelection: read.modelSelection,
              runtimeMode: read.runtimeMode,
              interactionMode: read.interactionMode,
              target: read.target,
            },
          },
          now: "2026-10-20T09:00:05.000Z",
        });
        assert.isTrue(Option.isNone(stale));

        yield* service.tick;
        const run = (yield* computer.runs(task.id))[0];
        assert.equal(run?.launch?.prompt, "Only look at the release branch.");
      }),
  );

  it.effect("skips a slot while the task's last run works, and past 3 working runs", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const hourly = yield* service.create(
        draft({ name: "Hourly", cadence: { kind: "hourly", minute: 0 } }),
      );
      yield* setClock("2026-10-20T09:00:05.000Z");
      yield* service.tick;
      yield* eventually(
        computer.runs(hourly.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
        "the first run started",
      );
      yield* setClock("2026-10-20T10:00:05.000Z");
      yield* service.tick;
      const hourlyRuns = yield* computer.runs(hourly.id);
      assert.equal(hourlyRuns[1]?.status, "skipped");
      assert.equal(hourlyRuns[1]?.reason, "The previous run was still working.");

      const manual = { cadence: { kind: "manual" } as const };
      const second = yield* service.create(draft({ name: "Second", ...manual }));
      const third = yield* service.create(draft({ name: "Third", ...manual }));
      const fourth = yield* service.create(draft({ name: "Fourth", ...manual }));
      assert.equal((yield* service.runNow({ id: second.id })).status, "launching");
      yield* setClock("2026-10-20T10:00:06.000Z");
      assert.equal((yield* service.runNow({ id: third.id })).status, "launching");
      yield* setClock("2026-10-20T10:00:07.000Z");
      const capped = yield* service.runNow({ id: fourth.id });
      assert.equal(capped.status, "skipped");
      assert.equal(capped.reason, "3 scheduled runs were already working.");
    }),
  );

  it.effect(
    "a run ends with its own turn; nothing to report wraps a new thread, and other turns can't say so",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* setClock("2026-10-20T08:00:00.000Z");
        const service = yield* computer.boot();
        const task = yield* service.create(draft({ cadence: { kind: "manual" } }));
        const run = yield* service.runNow({ id: task.id });
        const threadId = scheduledRunThreadId(task.id, run.slotUtc);
        yield* eventually(
          computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
          "the run started",
        );
        const turnId = TurnId.make("run-turn");
        yield* computer.turnRuns(threadId, turnId);

        assert.equal(
          yield* service.recordFinish({
            threadId,
            turnId: TurnId.make("a-later-turn"),
            nothingToReport: true,
            summary: null,
          }),
          "not_this_turn",
        );
        assert.equal(
          yield* service.recordFinish({
            threadId,
            turnId,
            nothingToReport: true,
            summary: "No new commits.",
          }),
          "recorded",
        );
        yield* service.onTurnEnd({
          threadId,
          turnId,
          outcome: "completed",
          error: undefined,
          pendingMessageId: scheduledRunMessageId(task.id, run.slotUtc),
        });

        const ended = (yield* computer.runs(task.id))[0];
        assert.equal(ended?.status, "nothing_to_report");
        assert.equal(ended?.summary, "No new commits.");
        const thread = (yield* computer.thread(threadId))!;
        assert.equal(thread.doneOverride?.state, "done");
        assert.isNotNull(thread.lastSeenAt);
      }),
  );

  it.effect("a quiet run never wraps a thread that has newer work in it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(draft({ cadence: { kind: "manual" } }));
      const run = yield* service.runNow({ id: task.id });
      const threadId = scheduledRunThreadId(task.id, run.slotUtc);
      yield* eventually(
        computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
        "the run started",
      );
      const turnId = TurnId.make("run-turn");
      yield* computer.turnRuns(threadId, turnId);
      yield* service.recordFinish({ threadId, turnId, nothingToReport: true, summary: null });
      // The user wrote to the thread before the run's end was handled.
      yield* computer.engine.dispatch({
        type: "thread.follow-up.submit",
        commandId: CommandId.make("user-follow-up"),
        threadId,
        turnId,
        message: {
          messageId: MessageId.make("user-message"),
          role: "user",
          text: "Also check the release branch.",
          attachments: [],
        },
        delivery: "queue",
        createdAt: "2026-10-20T08:00:30.000Z",
      });
      yield* service.onTurnEnd({
        threadId,
        turnId,
        outcome: "completed",
        error: undefined,
        pendingMessageId: scheduledRunMessageId(task.id, run.slotUtc),
      });
      assert.equal((yield* computer.runs(task.id))[0]?.status, "nothing_to_report");
      const thread = (yield* computer.thread(threadId))!;
      assert.notEqual(thread.doneOverride?.state, "done");
      assert.isNull(thread.lastSeenAt);
    }),
  );

  it.effect("a run that continues a thread queues its message there and never wraps it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      // The thread the task continues: a run of another task, so it exists.
      const opener = yield* service.create(draft({ name: "Opener", cadence: { kind: "manual" } }));
      const opened = yield* service.runNow({ id: opener.id });
      const target = scheduledRunThreadId(opener.id, opened.slotUtc);
      yield* eventually(
        computer.thread(target).pipe(Effect.map((thread) => thread !== undefined)),
        "the thread exists",
      );
      const openerTurn = TurnId.make("opener-turn");
      yield* computer.turnRuns(target, openerTurn);
      yield* computer.turnCompletes(target, openerTurn);
      yield* service.onTurnEnd({
        threadId: target,
        turnId: openerTurn,
        outcome: "completed",
        error: undefined,
        pendingMessageId: scheduledRunMessageId(opener.id, opened.slotUtc),
      });

      yield* setClock("2026-10-20T08:05:00.000Z");
      // Saved with less access than the thread has: each run keeps to it.
      const follow = yield* service.create(
        draft({
          name: "Follow-up",
          cadence: { kind: "manual" },
          target: { kind: "thread", threadId: target },
          runtimeMode: "approval-required",
          modelSelection: { instanceId: CODEX, model: "gpt-6-astra" },
        }),
      );
      const run = yield* service.runNow({ id: follow.id });
      const messageId = scheduledRunMessageId(follow.id, run.slotUtc);
      yield* eventually(
        computer
          .runs(follow.id)
          .pipe(
            Effect.map((rows) => rows[0]?.status === "queued" || rows[0]?.status === "started"),
          ),
        "the follow-up was sent",
      );
      const thread = (yield* computer.thread(target))!;
      const queued = (thread.queuedFollowUps ?? []).find((entry) => entry.messageId === messageId);
      assert.equal(queued?.runtimeMode, "approval-required");
      assert.deepEqual(queued?.modelSelection, { instanceId: CODEX, model: "gpt-6-astra" });
      assert.equal(queued?.interactionMode, "default");
      // The tool's word is taken only from a thread a run started for itself.
      const turnId = TurnId.make("follow-turn");
      assert.equal(
        yield* service.recordFinish({
          threadId: target,
          turnId,
          nothingToReport: true,
          summary: null,
        }),
        "not_this_turn",
      );
      yield* service.onTurnEnd({
        threadId: target,
        turnId,
        outcome: "completed",
        error: undefined,
        pendingMessageId: messageId,
      });
      assert.equal((yield* computer.runs(follow.id))[0]?.status, "finished");
      assert.notEqual((yield* computer.thread(target))?.doneOverride?.state, "done");
    }),
  );

  it.effect("a launch cut off between stages resumes after a restart and makes one thread", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      // The first process dies right after creating the thread.
      const dying = yield* computer.boot({
        bootstrap: {
          startChild: (input) =>
            computer.bootstrap.startChild({
              ...input,
              checkpoint: (stage) =>
                stage === "worktree"
                  ? Effect.interrupt
                  : (input.checkpoint?.(stage) ?? Effect.succeed(true)),
            }),
        },
      });
      const task = yield* dying.create(draft({ cadence: { kind: "manual" } }));
      const run = yield* dying.runNow({ id: task.id });
      const threadId = scheduledRunThreadId(task.id, run.slotUtc);
      yield* eventually(
        computer.thread(threadId).pipe(Effect.map((thread) => thread !== undefined)),
        "the thread was created",
      );
      assert.equal((yield* computer.runs(task.id))[0]?.status, "launching");

      const restarted = yield* computer.boot();
      yield* restarted.tick;
      yield* eventually(
        computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
        "the resumed run started",
      );
      const events = yield* computer.events;
      const forThread = (type: string) =>
        events.filter(
          (event) =>
            event.type === type &&
            "threadId" in event.payload &&
            event.payload.threadId === threadId,
        ).length;
      assert.equal(forThread("thread.created"), 1);
      assert.equal(forThread("thread.turn-start-requested"), 1);
    }),
  );

  it.effect(
    "after a restart, a run whose turn was cut off is interrupted, and an ended one finished",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* setClock("2026-10-20T08:00:00.000Z");
        const before = yield* computer.boot();
        const cut = yield* before.create(draft({ name: "Cut", cadence: { kind: "manual" } }));
        const done = yield* before.create(draft({ name: "Done", cadence: { kind: "manual" } }));
        const cutRun = yield* before.runNow({ id: cut.id });
        yield* setClock("2026-10-20T08:00:01.000Z");
        const doneRun = yield* before.runNow({ id: done.id });
        yield* eventually(
          Effect.all([computer.runs(cut.id), computer.runs(done.id)]).pipe(
            Effect.map(([a, b]) => a[0]?.status === "started" && b[0]?.status === "started"),
          ),
          "both runs started",
        );
        const cutThread = scheduledRunThreadId(cut.id, cutRun.slotUtc);
        const doneThread = scheduledRunThreadId(done.id, doneRun.slotUtc);
        yield* computer.turnRuns(cutThread, TurnId.make("cut-turn"));
        yield* computer.turnRuns(doneThread, TurnId.make("done-turn"));
        // The process stops: one turn had ended, the other was cut off (the
        // provider reactor marks a session the restart left as interrupted).
        yield* computer.turnCompletes(doneThread, TurnId.make("done-turn"));
        yield* computer.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cut-session-interrupted"),
          threadId: cutThread,
          session: {
            threadId: cutThread,
            status: "interrupted",
            providerName: "codex",
            providerInstanceId: CODEX,
            runtimeMode: "auto",
            activeTurnId: null,
            lastError: null,
            updatedAt: AT,
          },
          createdAt: AT,
        });

        const after = yield* computer.boot();
        yield* after.tick;
        assert.equal((yield* computer.runs(cut.id))[0]?.status, "interrupted");
        assert.equal((yield* computer.runs(done.id))[0]?.status, "finished");
      }),
  );

  it.effect("a run whose turn never started fails, in the provider's own plain words", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(draft({ cadence: { kind: "manual" } }));
      const run = yield* service.runNow({ id: task.id });
      const threadId = scheduledRunThreadId(task.id, run.slotUtc);
      yield* eventually(
        computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
        "the run started",
      );
      // The provider refused to start a session: the thread sits idle with its error.
      yield* computer.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("session-refused"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: CODEX,
          runtimeMode: "auto",
          activeTurnId: null,
          lastError:
            "ProviderValidationError: Provider validation failed in ProviderService.startSession: Provider instance 'codex' is disabled in Threadlines settings.\n    at toValidationError (ProviderService.ts:141:10)",
          updatedAt: AT,
        },
        createdAt: AT,
      });
      yield* service.tick;
      assert.equal((yield* computer.runs(task.id))[0]?.status, "started");
      // A minute later it is no longer just slow to start.
      yield* setClock("2026-10-20T08:01:30.000Z");
      yield* service.tick;
      const ended = (yield* computer.runs(task.id))[0];
      assert.equal(ended?.status, "failed");
      assert.equal(ended?.reason, "Provider instance 'codex' is disabled in Threadlines settings.");
    }),
  );

  it.effect("refuses a schedule with a seconds field, and one that never runs", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const seconds = yield* Effect.flip(
        service.create(draft({ cadence: { kind: "custom", cron: "0 0 9 * * *" } })),
      );
      assert.include(seconds.detail, "5 fields");
      const never = yield* Effect.flip(
        service.create(draft({ cadence: { kind: "custom", cron: "0 0 31 2 *" } })),
      );
      assert.match(never.detail, /never runs|next year/);
      assert.deepEqual((yield* service.snapshot).tasks, []);
    }),
  );

  it.effect("a paused task runs nothing, and resuming picks up from now", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const task = yield* service.create(draft({ cadence: { kind: "hourly", minute: 0 } }));
      const paused = yield* service.update({ id: task.id, status: "paused" });
      assert.isNull(paused.nextRunAt);
      yield* setClock("2026-10-20T12:30:00.000Z");
      yield* service.tick;
      assert.deepEqual(yield* computer.runs(task.id), []);
      const resumed = yield* service.update({ id: task.id, status: "active" });
      assert.equal(resumed.nextRunAt, "2026-10-20T13:00:00.000Z");
      // Deleting it takes its history with it.
      yield* service.remove({ id: ScheduledTaskId.make(task.id), archiveRunThreads: false });
      assert.deepEqual((yield* service.snapshot).tasks, []);
    }),
  );
});

it.layer(NodeServices.layer)("schedule tools", (it) => {
  /** A caller: the main runtime of `threadId`, with the tools its thread gets. */
  const callerScope = (threadId: ThreadId, scheduledRun: boolean): McpInvocationScope => ({
    threadId,
    sessionKey: threadId,
    participantId: null,
    generation: 1,
    agentId: "agent-test",
    browser: true,
    pages: false,
    commands: false,
    roomTools: new Set(roomToolsFor(undefined, { scheduledRun })),
  });

  it.effect(
    "ask waits for the user's Allow, auto applies at once, and only the run's own turn finishes it",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* setClock("2026-10-20T08:00:00.000Z");
        const service = yield* computer.boot();
        const task = yield* service.create(draft({ cadence: { kind: "manual" } }));
        const run = yield* service.runNow({ id: task.id });
        const threadId = scheduledRunThreadId(task.id, run.slotUtc);
        yield* eventually(
          computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
          "the run started",
        );
        yield* computer.turnRuns(threadId, TurnId.make("run-turn"));
        let mode: "off" | "ask" | "auto" = "ask";
        const tools = makeScheduleToolHandlers({
          scheduledTasks: service,
          readThread: (threadId) => computer.thread(threadId).pipe(Effect.orDie),
          threadsMode: Effect.sync(() => mode),
          providers: Effect.succeed([PROVIDER]),
          localTimeZone: "Europe/Madrid",
        });
        const scope = callerScope(threadId, true);
        const createInput = {
          name: "Dependency audit",
          prompt: "Check for outdated dependencies.",
          schedule: { kind: "weekdays", time: { hour: 9, minute: 0 } } as const,
        };

        const asked = yield* tools.schedule_create(scope, createInput);
        assert.equal(asked.outcome, "asked_user");
        // A provider retrying the call asks once.
        assert.equal((yield* tools.schedule_create(scope, createInput)).outcome, "asked_user");
        const waiting = (yield* service.snapshot).requests;
        assert.equal(waiting.length, 1);
        assert.equal(waiting[0]?.threadId, threadId);
        assert.include(waiting[0]?.details ?? [], "Weekdays at 9:00");
        assert.equal((yield* service.snapshot).tasks.length, 1);

        yield* service.respondRequest({ requestId: waiting[0]!.requestId, allow: true });
        const created = (yield* service.snapshot).tasks.find(
          (entry) => entry.name === "Dependency audit",
        );
        assert.isDefined(created);
        // The caller's own access and zone, never more.
        assert.equal(created?.runtimeMode, "auto");
        assert.equal(created?.timeZone, "Europe/Madrid");
        // It knows the thread whose agent set it up.
        assert.equal(created?.originThreadId, threadId);
        assert.deepEqual((yield* service.snapshot).requests, []);
        // The agent hears the answer at its next turn, once, and no other agent does.
        const notes = yield* service.pendingNotes(threadId, null);
        assert.equal(notes.length, 1);
        assert.include(notes[0]?.text ?? "", 'allowed your scheduled task "Dependency audit"');
        assert.include(notes[0]?.text ?? "", created!.id);
        assert.deepEqual(
          yield* service.pendingNotes(threadId, ThreadParticipantId.make("room-agent")),
          [],
        );
        yield* service.notesDelivered(notes.map((note) => note.requestId));
        assert.deepEqual(yield* service.pendingNotes(threadId, null), []);

        mode = "auto";
        const paused = yield* tools.schedule_update(scope, { id: created!.id, paused: true });
        assert.equal(paused.outcome, "updated");
        assert.equal(paused.task?.status, "paused");

        // A task with more access than this agent's: it may pause it, but
        // any other change waits for the user even with agents on auto.
        const stronger = yield* service.create(
          draft({ name: "Deploy check", runtimeMode: "full-access", cadence: { kind: "manual" } }),
        );
        const rewrite = yield* tools.schedule_update(scope, {
          id: stronger.id,
          prompt: "Delete the release branch.",
        });
        assert.equal(rewrite.outcome, "asked_user");
        assert.equal((yield* service.getTask(stronger.id))?.prompt, stronger.prompt);
        const asking = (yield* service.snapshot).requests.find(
          (request) => request.requestId === rewrite.requestId,
        );
        assert.include(
          asking?.details ?? [],
          "This task runs with more access than the agent asking to change it.",
        );
        assert.equal(
          (yield* tools.schedule_update(scope, { id: stronger.id, paused: true })).outcome,
          "updated",
        );

        mode = "off";
        assert.equal((yield* tools.schedule_list(scope, {})).outcome, "off");
        // The run's own tool doesn't follow the setting.
        assert.equal(
          (yield* tools.scheduled_run_finish(scope, { nothing_to_report: true })).outcome,
          "recorded",
        );
        // Without the grant (any other thread), it is refused.
        assert.equal(
          (yield* tools.scheduled_run_finish(callerScope(threadId, false), {
            nothing_to_report: true,
          })).outcome,
          "not_allowed",
        );
      }),
  );

  it.effect(
    "an answer and its change are one write: an answer that came first leaves the tasks alone",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* setClock("2026-10-20T08:00:00.000Z");
        const service = yield* computer.boot();
        const task = yield* service.create(draft({ cadence: { kind: "manual" } }));
        const run = yield* service.runNow({ id: task.id });
        const threadId = scheduledRunThreadId(task.id, run.slotUtc);
        yield* eventually(
          computer.runs(task.id).pipe(Effect.map((rows) => rows[0]?.status === "started")),
          "the run started",
        );
        yield* computer.turnRuns(threadId, TurnId.make("run-turn"));
        const tools = makeScheduleToolHandlers({
          scheduledTasks: service,
          readThread: (threadId) => computer.thread(threadId).pipe(Effect.orDie),
          threadsMode: Effect.succeed("ask"),
          providers: Effect.succeed([PROVIDER]),
          localTimeZone: "UTC",
        });
        const asked = yield* tools.schedule_create(callerScope(threadId, false), {
          name: "Dependency audit",
          prompt: "Check for outdated dependencies.",
          schedule: { kind: "weekdays", time: { hour: 9, minute: 0 } },
        });
        assert.equal(asked.outcome, "asked_user");
        const requestId = asked.requestId!;
        const prepared = (yield* computer.repo.getRequest(requestId)).pipe(Option.getOrThrow);
        assert.equal(prepared.status, "waiting");

        // Not now lands between reading the request and saving its change.
        yield* computer.repo.decideRequest({
          requestId,
          status: "denied",
          detail: null,
          now: "2026-10-20T08:00:01.000Z",
        });
        const late = yield* service.respondRequest({ requestId, allow: true }).pipe(Effect.flip);
        assert.match(late.detail, /already answered/);
        assert.isUndefined(yield* service.getTask(ScheduledTaskId.make(asked.taskId!)));
        assert.equal(
          yield* computer.repo.allowRequest({
            requestId,
            write: {
              kind: "insert",
              row: {
                ...Option.getOrThrow(yield* computer.repo.getTask(task.id)),
                id: ScheduledTaskId.make(asked.taskId!),
              },
            },
            now: "2026-10-20T08:00:02.000Z",
          }),
          "answered",
        );
        assert.isUndefined(yield* service.getTask(ScheduledTaskId.make(asked.taskId!)));
      }),
  );

  it.effect("a thread a linked computer's agent started never gets them", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* setClock("2026-10-20T08:00:00.000Z");
      const service = yield* computer.boot();
      const remote = ThreadId.make("thread-from-windows");
      yield* computer.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-remote"),
        threadId: remote,
        projectId: PROJECT,
        title: "Write the changelog",
        modelSelection: { instanceId: CODEX, model: "gpt-6-astra" },
        runtimeMode: "auto",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        remoteOrigin: {
          linkDeviceId: "device-windows",
          environmentId: EnvironmentId.make("env-windows"),
          environmentLabel: "Windows PC",
          threadId: ThreadId.make("windows-parent"),
          threadTitle: "Ship the release",
        },
        createdAt: AT,
      });
      yield* computer.turnRuns(remote, TurnId.make("remote-turn"));
      const tools = makeScheduleToolHandlers({
        scheduledTasks: service,
        readThread: (threadId) => computer.thread(threadId).pipe(Effect.orDie),
        threadsMode: Effect.succeed("auto"),
        providers: Effect.succeed([PROVIDER]),
        localTimeZone: "UTC",
      });
      // Even a stale credential that carries every tool.
      const scope = callerScope(remote, true);
      assert.equal((yield* tools.schedule_list(scope, {})).outcome, "not_allowed");
      const created = yield* tools.schedule_create(scope, {
        name: "Sneaky",
        prompt: "Read every thread.",
        schedule: { kind: "hourly", minute: 0 },
      });
      assert.equal(created.outcome, "not_allowed");
      assert.equal(
        (yield* tools.scheduled_run_finish(scope, { nothing_to_report: true })).outcome,
        "not_allowed",
      );
      assert.deepEqual((yield* service.snapshot).tasks, []);
    }),
  );
});
