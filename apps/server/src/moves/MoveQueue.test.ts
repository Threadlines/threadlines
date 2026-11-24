import {
  CommandId,
  CommandRunId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveError,
  ThreadMoveId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationQueuedFollowUp,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  type ThreadMoveRequestId,
  type ThreadMoveTakes,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import type { ProviderStopConfirmation } from "../provider/Services/ProviderAdapter.ts";
import { makeMoveQueue, type MoveQueueShape } from "./MoveQueue.ts";
import type { ThreadMoveBatchRow } from "./ThreadMoveBatchRepository.ts";
import type { QueuedMoveStart, ThreadMovesShape } from "./ThreadMoves.ts";

const now = "2026-11-15T10:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const MAC_MINI = EnvironmentId.make("environment-mac-mini");
const agent: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-${(commandCount += 1)}`);

/**
 * The real decider and projector behind a fake engine, with a fake provider
 * side (a session stop lands as a stopped session, as ProviderCommandReactor
 * does) and fake links.
 */
async function harness(options?: { readonly model?: OrchestrationReadModel }) {
  const scope = await Effect.runPromise(Scope.make());
  const events = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
  const linkChanges = await Effect.runPromise(PubSub.unbounded<void>());
  let model = options?.model ?? (await seeded());
  let sequence = 0;
  const state = {
    online: true,
    stopsLand: true,
    confirmation: { confirmed: true } as ProviderStopConfirmation,
    quiesceCalls: 0,
    starts: 0,
    cancels: 0,
    /** Commands the queue sent that recorded nothing (the real engine refuses them). */
    emptyCommands: 0,
    /** Runs right before a start, as if a provider turn slipped in. */
    beforeStart: null as null | (() => Promise<void>),
    /** Runs right before the queue's quiesce lands, as if the user acted first. */
    beforeQuiesce: null as null | (() => Effect.Effect<void, ThreadMoveError>),
    /** Runs right before a Cancel lands, as if the start won the race. */
    beforeUnqueue: null as null | (() => Effect.Effect<void, ThreadMoveError>),
    /** What the target takes (docs/design/fleet.md, Part 3e): everything, unless a test says. */
    takes: { threadState: true, generalChats: true } as ThreadMoveTakes,
    /** What the target answers before the stop, asked whether it takes what the thread carries. */
    carryAnswer: { kind: "ok" } as Effect.Success<ReturnType<ThreadMovesShape["checkCarry"]>>,
    carryChecks: 0,
    /** How long checking a child that moves with its parent takes (a target that answers slowly). */
    childCheckMs: 0,
    /** Runs once after a look read the threads, before it gets them (something changed meanwhile). */
    duringContextRead: null as null | (() => Effect.Effect<void, ThreadMoveError>),
  };

  const dispatch = (command: OrchestrationCommand): Effect.Effect<void, ThreadMoveError> =>
    Effect.gen(function* () {
      if (command.type === "thread.move.quiesce" && state.beforeQuiesce !== null) {
        const first = state.beforeQuiesce;
        state.beforeQuiesce = null;
        yield* first();
      }
      if (command.type === "thread.move.unqueue" && state.beforeUnqueue !== null) {
        const first = state.beforeUnqueue;
        state.beforeUnqueue = null;
        yield* first();
      }
      const decided = yield* decideOrchestrationCommand({ command, readModel: model }).pipe(
        Effect.mapError((error) => new ThreadMoveError({ detail: error.message })),
      );
      const planned = Array.isArray(decided) ? decided : [decided];
      // As the real engine: a command that records nothing is refused.
      if (planned.length === 0) {
        state.emptyCommands += 1;
        return yield* new ThreadMoveError({ detail: "Command produced no events." });
      }
      for (const next of planned) {
        sequence += 1;
        const event = { ...next, sequence } as OrchestrationEvent;
        model = yield* projectEvent(model, event).pipe(Effect.orDie);
        yield* PubSub.publish(events, event);
        if (event.type === "thread.session-stop-requested" && state.stopsLand) {
          yield* setSession("stopped");
        }
      }
    });
  const setSession = (
    status: OrchestrationSession["status"],
    extra?: Partial<OrchestrationSession>,
  ) =>
    dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(),
      threadId: THREAD,
      session: {
        threadId: THREAD,
        status,
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
        ...extra,
      },
      createdAt: now,
    } as OrchestrationCommand);

  const thread = () => model.threads.find((entry) => entry.id === THREAD)!;
  const batchRows = new Map<string, ThreadMoveBatchRow>();

  const startQueued = (input: {
    readonly threadId: ThreadId;
    readonly requestId: ThreadMoveRequestId;
  }): Effect.Effect<QueuedMoveStart> =>
    Effect.gen(function* () {
      if (state.beforeStart !== null) {
        const run = state.beforeStart;
        state.beforeStart = null;
        yield* Effect.promise(run);
      }
      if (!state.online) {
        return { kind: "unreachable", words: "Waiting for Mac mini to connect." } as const;
      }
      const transferId = ThreadMoveId.make(`transfer-${(state.starts += 1)}`);
      const started = yield* dispatch({
        type: "thread.move.start",
        commandId: nextCommandId(),
        threadId: input.threadId,
        transferId,
        target: { environmentId: MAC_MINI, label: "Mac mini" },
        agent,
        queuedRequestId: input.requestId,
        targetTakes: state.takes,
        createdAt: now,
      }).pipe(Effect.result);
      return started._tag === "Success"
        ? ({ kind: "started", transferId } as const)
        : ({ kind: "busy", words: started.failure.detail } as const);
    });

  const queue: MoveQueueShape = await Effect.runPromise(
    makeMoveQueue({
      dispatch,
      subscribeEvents: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
      linkChanges: Stream.fromPubSub(linkChanges),
      readThread: (threadId) =>
        Effect.sync(() => model.threads.find((entry) => entry.id === threadId) ?? null),
      readContext: (threadId) =>
        Effect.gen(function* () {
          const view = model;
          const meanwhile = state.duringContextRead;
          if (meanwhile !== null) {
            state.duringContextRead = null;
            yield* meanwhile().pipe(Effect.orDie);
            // The reactor takes the event in before this look gets its read.
            yield* Effect.sleep(Duration.millis(30));
          }
          const thread = view.threads.find((entry) => entry.id === threadId);
          return thread === undefined ? null : { thread, view };
        }),
      pendingThreadIds: Effect.sync(() =>
        model.threads.filter((thread) => (thread.pendingMove ?? null) !== null).map((t) => t.id),
      ),
      quiesce: () =>
        Effect.sync(() => {
          state.quiesceCalls += 1;
          return state.confirmation;
        }),
      restoreOwedThreadIds: Effect.sync(() =>
        model.threads
          .filter((thread) => (thread.moveRestoreOwed ?? null) !== null)
          .map((thread) => thread.id),
      ),
      setsCheckBacks: () => Effect.succeed(true),
      checkQueue: (input) =>
        Effect.sleep(
          Duration.millis(input.family?.parentThreadId !== undefined ? state.childCheckMs : 0),
        ).pipe(Effect.as({ label: "Mac mini", takes: state.takes })),
      checkCarry: () =>
        Effect.sync(() => {
          state.carryChecks += 1;
          return state.carryAnswer;
        }),
      describeTargets: Effect.succeed([]),
      startQueued,
      batches: {
        upsert: (row) =>
          Effect.sync(() => {
            batchRows.set(row.batchId, row);
          }),
        get: (batchId) => Effect.sync(() => Option.fromUndefinedOr(batchRows.get(batchId))),
      },
      readMoveState: (threadId) =>
        Effect.sync(() => model.threads.find((entry) => entry.id === threadId) ?? null),
      cancelMove: (threadId) => {
        state.cancels += 1;
        const move = model.threads.find((entry) => entry.id === threadId)?.move ?? null;
        return move === null
          ? Effect.void
          : dispatch({
              type: "thread.move.cancel",
              commandId: nextCommandId(),
              threadId,
              transferId: move.transferId,
              createdAt: now,
            });
      },
      retryDelay: () => Duration.millis(40),
      settleDelay: Duration.millis(5),
    }).pipe(Scope.provide(scope)),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  return {
    state,
    queue,
    thread,
    model: () => model,
    run,
    setSession: (status: OrchestrationSession["status"], extra?: Partial<OrchestrationSession>) =>
      run(setSession(status, extra)),
    dispatch: (command: OrchestrationCommand) => run(dispatch(command)),
    dispatchEffect: dispatch,
    setSessionEffect: setSession,
    /** The turn ends as a provider ends it: completed, then the session idles. */
    endTurn: (turnId: TurnId) =>
      run(
        dispatch({
          type: "thread.turn.complete",
          commandId: nextCommandId(),
          threadId: THREAD,
          turnId,
          state: "completed",
          completedAt: now,
          createdAt: now,
        } as OrchestrationCommand).pipe(Effect.andThen(setSession("ready"))),
      ),
    startReactor: () => run(queue.startReactor().pipe(Scope.provide(scope))),
    linkChanged: () => run(PubSub.publish(linkChanges, undefined)),
    close: () => run(Scope.close(scope, { _tag: "Success", value: undefined } as never)),
    queueMove: (mode: "when-done" | "stop-now" = "when-done") =>
      run(queue.queue({ threadId: THREAD, targetEnvironmentId: MAC_MINI, agent, mode })),
  };
}

async function seeded(): Promise<OrchestrationReadModel> {
  let model = createEmptyReadModel(now);
  let sequence = 0;
  for (const command of [
    {
      type: "project.create",
      commandId: nextCommandId(),
      projectId: PROJECT,
      title: "Threadlines",
      workspaceRoot: "/repo",
      createdAt: now,
    },
    {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: THREAD,
      projectId: PROJECT,
      title: "Fix the flaky test",
      modelSelection: agent,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: "fix/flaky",
      worktreePath: "/worktrees/fix-flaky",
      createdAt: now,
    },
  ] as OrchestrationCommand[]) {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel: model }),
    );
    for (const planned of Array.isArray(decided) ? decided : [decided]) {
      sequence += 1;
      model = await Effect.runPromise(
        projectEvent(model, { ...planned, sequence } as OrchestrationEvent),
      );
    }
  }
  return model;
}

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const TURN = TurnId.make("turn-1");

describe("MoveQueue", () => {
  it("starts the move once the turn completes, not before", async () => {
    const h = await harness();
    await h.startReactor();
    await h.setSession("running", { activeTurnId: TURN });
    await h.queueMove();
    await settle();
    expect(h.thread().pendingMove).toMatchObject({ stage: "waiting" });
    expect(h.thread().pendingMove?.waitsFor?.map((wait) => wait.code)).toEqual(["turn"]);
    expect(h.state.quiesceCalls).toBe(0);

    await h.endTurn(TURN);
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    expect(h.thread().pendingMove ?? null).toBeNull();
    expect(h.thread().move?.queuedRequestId).toBeDefined();
    expect(h.state.quiesceCalls).toBeGreaterThan(0);
    // It never sent a command that would record nothing.
    expect(h.state.emptyCommands).toBe(0);
    await h.close();
  });

  it("waits for background tasks to settle", async () => {
    const h = await harness();
    await h.startReactor();
    await h.setSession("ready", { pendingBackgroundTaskCount: 1, awaitedBackgroundTaskCount: 1 });
    await h.queueMove();
    await settle();
    expect(h.thread().pendingMove?.waitsFor?.map((wait) => wait.code)).toEqual(["background"]);
    expect(h.thread().move ?? null).toBeNull();

    await h.setSession("ready", { pendingBackgroundTaskCount: 0, awaitedBackgroundTaskCount: 0 });
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    await h.close();
  });

  it("ends as blocked when the agent set a check-back during the turn, for a computer that can't take it", async () => {
    const h = await harness();
    // An older computer: check-backs don't travel to it.
    h.state.takes = {};
    await h.startReactor();
    await h.setSession("running", { activeTurnId: TURN });
    await h.queueMove();
    await h.dispatch({
      type: "thread.check-backs.set",
      commandId: nextCommandId(),
      threadId: THREAD,
      participantId: null,
      checkBacks: [
        {
          id: "check-back-1",
          participantId: null,
          scheduledFor: "2026-11-15T12:00:00.000Z",
          exact: true,
          recurring: false,
          durable: false,
        },
      ],
      createdAt: now,
    });
    await waitFor(() => (h.thread().pendingMove ?? null) === null, "the wait to end");
    expect(h.thread().move ?? null).toBeNull();
    expect(h.thread().activities.at(-1)).toMatchObject({
      kind: "thread.move-not-started",
      payload: {
        reason: "blocked",
        words: "This thread's agent set itself a time to come back. Cancel it first.",
      },
    });
    await h.close();
  });

  it("waits while the target is offline, retries on its own, and starts once it connects", async () => {
    const h = await harness();
    h.state.online = false;
    await h.startReactor();
    await h.queueMove();
    await waitFor(
      () => h.thread().pendingMove?.hold?.kind === "target_unreachable",
      "the offline hold",
    );
    expect(h.thread().pendingMove?.hold?.words).toBe("Waiting for Mac mini to connect.");
    const quiescedWhileOffline = h.state.quiesceCalls;
    // A failed describe on a connected link is tried again without any change.
    await waitFor(() => h.state.quiesceCalls > quiescedWhileOffline, "a retry on its own");
    expect(h.thread().move ?? null).toBeNull();

    h.state.online = true;
    await h.linkChanged();
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start on reconnect");
    // Retrying the same hold sent nothing the engine would refuse.
    expect(h.state.emptyCommands).toBe(0);
    await h.close();
  });

  it("never moves while a stop can't be proven, and says why", async () => {
    const h = await harness();
    h.state.confirmation = { confirmed: false, reason: "its process 4242 didn't exit" };
    await h.startReactor();
    await h.queueMove();
    await waitFor(() => h.thread().pendingMove?.hold?.kind === "stop_unconfirmed", "the hold");
    expect(h.thread().pendingMove?.hold?.words).toBe(
      "Couldn't confirm the agent stopped: its process 4242 didn't exit.",
    );
    expect(h.thread().pendingMove?.stage).toBe("quiescing");
    await settle();
    expect(h.thread().move ?? null).toBeNull();

    h.state.confirmation = { confirmed: true };
    await h.run(h.queue.retry({ threadId: THREAD, requestId: h.thread().pendingMove!.requestId }));
    await waitFor(() => (h.thread().move ?? null) !== null, "the move after Try again");
    await h.close();
  });

  it("picks up a pending move the last process left", async () => {
    const first = await harness();
    await first.setSession("running", { activeTurnId: TURN });
    await first.queueMove();
    const left = first.model();
    await first.close();

    const restarted = await harness({ model: left });
    await restarted.startReactor();
    await restarted.endTurn(TURN);
    await waitFor(() => (restarted.thread().move ?? null) !== null, "the move after a restart");
    await restarted.close();
  });

  it("goes back to waiting when a provider turn slipped in after the thread looked free", async () => {
    const h = await harness();
    // The turn the provider started on its own lands just before the start.
    h.state.beforeStart = () => h.setSession("running", { activeTurnId: TurnId.make("turn-own") });
    await h.startReactor();
    await h.queueMove();
    await settle();
    expect(h.thread().move ?? null).toBeNull();
    expect(h.thread().pendingMove?.waitsFor?.map((wait) => wait.code)).toEqual(["turn"]);

    await h.endTurn(TurnId.make("turn-own"));
    await waitFor(() => (h.thread().move ?? null) !== null, "the move after that turn");
    await h.close();
  });

  it("a look begun before a Cancel never stops the work the user started after it", async () => {
    const h = await harness();
    await h.startReactor();
    // The user cancels, and sends a new message, while the look is on its way to the quiesce.
    h.state.beforeQuiesce = () =>
      Effect.gen(function* () {
        yield* h.dispatchEffect({
          type: "thread.move.unqueue",
          commandId: nextCommandId(),
          threadId: THREAD,
          requestId: h.thread().pendingMove!.requestId,
          createdAt: now,
        });
        yield* h.setSessionEffect("running", { activeTurnId: TurnId.make("turn-new") });
      });
    await h.queueMove();
    await waitFor(() => (h.thread().pendingMove ?? null) === null, "the cancel");
    await settle();
    expect(h.state.quiesceCalls).toBe(0);
    expect(h.thread().session?.status).toBe("running");
    expect(h.thread().move ?? null).toBeNull();
    await h.close();
  });

  it("a Cancel the start beats between its read and its landing cancels the transfer", async () => {
    const h = await harness();
    // Offline: the move is quiesced and held, ready to start.
    h.state.online = false;
    await h.startReactor();
    const { requestId } = await h.queueMove();
    await waitFor(() => h.thread().pendingMove?.hold?.kind === "target_unreachable", "the hold");
    h.state.beforeUnqueue = () =>
      h.dispatchEffect({
        type: "thread.move.start",
        commandId: nextCommandId(),
        threadId: THREAD,
        transferId: ThreadMoveId.make("transfer-raced"),
        target: { environmentId: MAC_MINI, label: "Mac mini" },
        agent,
        queuedRequestId: requestId,
        createdAt: now,
      });
    await h.run(h.queue.unqueue({ threadId: THREAD, requestId }));
    expect(h.state.cancels).toBe(1);
    expect(h.thread().move).toMatchObject({ transferId: "transfer-raced", cancelRequested: true });
    await h.close();
  });

  it("a Cancel that lost the race to the start cancels the transfer instead", async () => {
    const h = await harness();
    await h.startReactor();
    const { requestId } = await h.queueMove();
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    // The user's Cancel names the queued move it showed.
    await h.run(h.queue.unqueue({ threadId: THREAD, requestId }));
    expect(h.state.cancels).toBe(1);
    expect(h.thread().move?.cancelRequested).toBe(true);
    await h.close();
  });
});

describe("MoveQueue, another thread working in the same folder", () => {
  const OTHER = ThreadId.make("thread-same-folder");
  const RUN = CommandRunId.make("run-in-folder");

  /** A second thread in the moving thread's folder, with a command still running in its terminal. */
  async function sharingWithRunningCommand() {
    let model = await seeded();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: nextCommandId(),
          threadId: OTHER,
          projectId: PROJECT,
          title: "Update the docs",
          modelSelection: agent,
          runtimeMode: "auto",
          interactionMode: "default",
          branch: "fix/flaky",
          worktreePath: "/worktrees/fix-flaky",
          createdAt: now,
        } as OrchestrationCommand,
        readModel: model,
      }),
    );
    for (const [index, planned] of (Array.isArray(decided) ? decided : [decided]).entries()) {
      model = await Effect.runPromise(
        projectEvent(model, { ...planned, sequence: 100 + index } as OrchestrationEvent),
      );
    }
    return {
      ...model,
      threads: model.threads.map((thread) =>
        thread.id === OTHER
          ? {
              ...thread,
              commandRuns: [
                {
                  runId: RUN,
                  terminalId: "terminal-docs",
                  mode: "run",
                  dialect: "posix",
                  command: "pnpm docs:build",
                  source: { kind: "message", messageId: MessageId.make("m-docs") },
                  turnId: TURN,
                  participantId: null,
                  cwd: "/worktrees/fix-flaky",
                  autoSend: false,
                  status: "running",
                  startedAt: now,
                  finishedAt: null,
                  exitCode: null,
                  error: null,
                  hasOutput: false,
                  heldReason: null,
                  outputSentAt: null,
                  outputMessageId: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }
          : thread,
      ),
    } as OrchestrationReadModel;
  }

  it("moves once the other thread's command ends, even when nothing else happens there", async () => {
    const h = await harness({ model: await sharingWithRunningCommand() });
    await h.startReactor();
    await h.queueMove();
    await waitFor(
      () => h.thread().pendingMove?.waitsFor?.some((w) => w.code === "shared_checkout") === true,
      "the shared folder wait",
    );
    await settle();
    expect(h.thread().move ?? null).toBeNull();

    // Interrupted: no turn starts there, and no session changes, to wake the move.
    await h.dispatch({
      type: "thread.command-run.update",
      commandId: nextCommandId(),
      threadId: OTHER,
      progress: { runId: RUN, status: "interrupted", finishedAt: now },
      createdAt: now,
    });
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    await h.close();
  });

  it("after a restart, an end that lands while a look reads the folder still wakes the move", async () => {
    const first = await harness({ model: await sharingWithRunningCommand() });
    await first.startReactor();
    await first.queueMove();
    await waitFor(
      () =>
        first.thread().pendingMove?.waitsFor?.some((w) => w.code === "shared_checkout") === true,
      "the shared folder wait",
    );
    const left = first.model();
    await first.close();

    // The wait is already on record, so the look that finds it again reports nothing new.
    const restarted = await harness({ model: left });
    // The command ends after the look read the threads, before it knows whom it waits on.
    restarted.state.duringContextRead = () =>
      restarted.dispatchEffect({
        type: "thread.command-run.update",
        commandId: nextCommandId(),
        threadId: OTHER,
        progress: { runId: RUN, status: "interrupted", finishedAt: now },
        createdAt: now,
      });
    await restarted.startReactor();
    await waitFor(() => (restarted.thread().move ?? null) !== null, "the move to start");
    await restarted.close();
  });
});

describe("MoveQueue, several threads at once", () => {
  const OTHER = ThreadId.make("thread-2");
  /** A second thread, in its own checkout, with pull request auto-fix on: it can't move. */
  const addBlockedThread = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.dispatch({
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: OTHER,
      projectId: PROJECT,
      title: "Ship the release",
      modelSelection: agent,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: "release",
      worktreePath: "/worktrees/release",
      createdAt: now,
    } as OrchestrationCommand);
    await h.dispatch({
      type: "thread.pull-request-automation.set",
      commandId: nextCommandId(),
      threadId: OTHER,
      pullRequestNumber: 294,
      pullRequestUrl: "https://github.com/acme/widgets/pull/294",
      autoFix: true,
    } as OrchestrationCommand);
  };

  it("decides each thread on its own and answers for every one of them", async () => {
    const h = await harness();
    // An older computer: pull request switches don't travel to it.
    h.state.takes = {};
    await h.startReactor();
    await addBlockedThread(h);
    await h.setSession("running", { activeTurnId: TURN });
    const result = await h.run(
      h.queue.queueMany({
        threadIds: [OTHER, THREAD],
        targetEnvironmentId: MAC_MINI,
        mode: "when-done",
      }),
    );
    // The refused one didn't stop the other.
    expect(result.refused).toEqual([
      { threadId: OTHER, words: expect.stringContaining("auto-fix") },
    ]);
    expect(result.queued.map((entry) => entry.threadId)).toEqual([THREAD]);
    expect(h.thread().pendingMove?.batchId).toBe(result.batchId);

    const status = () => h.run(h.queue.batchStatus(result.batchId));
    const first = await status();
    expect(first).toMatchObject({
      target: { environmentId: MAC_MINI },
      final: false,
      members: [
        { threadId: OTHER, state: "not_moved", final: true },
        { threadId: THREAD, state: "waiting", final: false, waitsFor: [{ code: "turn" }] },
      ],
    });
    // Only a queued move is named; the refused one never had one.
    expect(first.members[0]?.requestId).toBeUndefined();
    expect(first.members[1]?.requestId).toBe(result.queued[0]?.requestId);

    await h.endTurn(TURN);
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    expect((await status()).members[1]).toMatchObject({ state: "moving", phase: "exporting" });
    // The other computer has every byte and waits for its user: final, for quitting.
    await h.dispatch({
      type: "thread.move.progress",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: h.thread().move!.transferId,
      phase: "awaiting_approval",
      sentBytes: 64,
      totalBytes: 64,
      staged: true,
      createdAt: now,
    });
    expect(await status()).toMatchObject({
      final: true,
      members: [{ state: "not_moved" }, { state: "awaiting_approval", final: true }],
    });
    await h.close();
  });

  it("stop the agents and move now switches only the waiting move it names", async () => {
    const h = await harness();
    await h.startReactor();
    await h.setSession("running", { activeTurnId: TURN });
    const { requestId } = await h.queueMove();
    await settle();
    // An older request is left alone.
    await h.run(
      h.queue.setMode({
        threadId: THREAD,
        requestId: "request-old" as ThreadMoveRequestId,
        mode: "stop-now",
      }),
    );
    expect(h.thread().pendingMove).toMatchObject({ mode: "when-done", stage: "waiting" });
    await h.run(h.queue.setMode({ threadId: THREAD, requestId, mode: "stop-now" }));
    // Its agent is stopped, and the move goes without waiting for the turn.
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    expect(h.thread().move?.queuedRequestId).toBe(requestId);
    // Once started, it's no longer a waiting move to switch.
    await h.run(h.queue.setMode({ threadId: THREAD, requestId, mode: "stop-now" }));
    await h.close();
  });
});

describe("MoveQueue, what a thread had going (Part 3e)", () => {
  const GOAL = {
    threadId: THREAD,
    objective: "Make the suite pass",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
  /** The seeded thread with `patch` applied: what it has going when the test starts. */
  const seededWith = async (patch: Partial<OrchestrationThread>) => {
    const model = await seeded();
    return {
      ...model,
      threads: model.threads.map((thread) =>
        thread.id === THREAD ? ({ ...thread, ...patch } as OrchestrationThread) : thread,
      ),
    };
  };
  const queuedMessage = (id: string) =>
    ({
      messageId: MessageId.make(id),
      text: "and then this",
      attachments: [],
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
    }) as OrchestrationQueuedFollowUp;

  it("a target that doesn't take what the thread carries ends the move before anything is stopped", async () => {
    const h = await harness({ model: await seededWith({ goal: GOAL }) });
    h.state.carryAnswer = {
      kind: "blocked",
      words: "Update Threadlines on Mac mini to move this thread: it has a goal.",
    };
    await h.startReactor();
    await h.setSession("ready");
    await h.queueMove();
    await waitFor(() => (h.thread().pendingMove ?? null) === null, "the wait to end");
    expect(h.state.quiesceCalls).toBe(0);
    expect(h.thread().session?.status).toBe("ready");
    expect(h.thread().lastMoveOutcome).toMatchObject({
      result: "not_moved",
      reason: "blocked",
      words: "Update Threadlines on Mac mini to move this thread: it has a goal.",
    });
    // Nothing was stopped, so nothing is owed back.
    expect(h.thread().moveRestoreOwed ?? null).toBeNull();
    await h.close();
  });

  it("a target that can't be reached holds the move with its agent still at work", async () => {
    const h = await harness({ model: await seededWith({ goal: GOAL }) });
    h.state.carryAnswer = { kind: "unreachable", words: "Waiting for Mac mini to connect." };
    await h.startReactor();
    await h.setSession("ready");
    await h.queueMove();
    await waitFor(
      () => h.thread().pendingMove?.hold?.kind === "target_unreachable",
      "the move to be held",
    );
    expect(h.state.quiesceCalls).toBe(0);
    expect(h.thread().pendingMove?.stage).toBe("waiting");
    h.state.carryAnswer = { kind: "ok" };
    await h.linkChanged();
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    expect(h.thread().move?.interrupted).toMatchObject({ goalActive: true });
    await h.close();
  });

  it("a cancel puts back the goal and the check-backs its stop took, the agent told ahead of the queue", async () => {
    const h = await harness({
      model: await seededWith({
        goal: GOAL,
        checkBacks: [
          {
            id: "check-back-1",
            participantId: null,
            scheduledFor: "2026-11-15T12:00:00.000Z",
            exact: true,
            recurring: false,
            prompt: "Look at CI on #212",
            durable: false,
          },
        ],
        queuedFollowUps: [queuedMessage("q-1")],
      }),
    });
    h.state.online = false;
    await h.startReactor();
    await h.setSession("ready");
    const { requestId } = await h.queueMove("stop-now");
    await waitFor(
      () => h.thread().pendingMove?.hold?.kind === "target_unreachable",
      "the move to be held",
    );
    // The stop ended the check-back, as Claude's runtime reports it.
    await h.dispatch({
      type: "thread.check-backs.set",
      commandId: nextCommandId(),
      threadId: THREAD,
      participantId: null,
      checkBacks: [],
      createdAt: now,
    });
    await h.run(h.queue.unqueue({ threadId: THREAD, requestId }));
    await waitFor(
      () => h.thread().queuedFollowUps?.[0]?.afterMove === true,
      "the agent to be told",
    );
    const [told, mine] = h.thread().queuedFollowUps ?? [];
    expect(told?.text).toContain("The move to Mac mini didn't happen");
    expect(told?.text).toContain("Your goal is still on: Make the suite pass. Carry on with it.");
    expect(told?.text).toContain("Look at CI on #212");
    expect(mine?.messageId).toBe("q-1");
    // Only the goal's hand-over to the provider is left (the reactor's, after the message).
    expect(h.thread().moveRestoreOwed).toMatchObject({ goalOwed: true });
    await h.close();
  });

  it("a cancel sends the queue that waited for the move", async () => {
    const h = await harness({
      model: await seededWith({ queuedFollowUps: [queuedMessage("q-1")] }),
    });
    h.state.online = false;
    await h.startReactor();
    await h.setSession("ready");
    const { requestId } = await h.queueMove();
    await waitFor(
      () => h.thread().pendingMove?.hold?.kind === "target_unreachable",
      "the move to be held",
    );
    await h.run(h.queue.unqueue({ threadId: THREAD, requestId }));
    await waitFor(() => (h.thread().queuedFollowUps ?? []).length === 0, "the queue to be sent");
    // Sent as its turn: the message is the thread's now.
    expect(h.thread().messages.map((message) => message.id)).toContain("q-1");
    expect(h.thread().moveRestoreOwed ?? null).toBeNull();
    await h.close();
  });

  it("a dropped move puts back what its stop took", async () => {
    const h = await harness({ model: await seededWith({ goal: GOAL }) });
    await h.startReactor();
    await h.setSession("ready");
    await h.queueMove("stop-now");
    await waitFor(() => (h.thread().move ?? null) !== null, "the move to start");
    const transferId = h.thread().move!.transferId;
    await h.dispatch({
      type: "thread.move.abort",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId,
      reason: "Mac mini didn't allow the move.",
      code: "denied",
      createdAt: now,
    });
    await waitFor(
      () => h.thread().queuedFollowUps?.[0]?.afterMove === true,
      "the agent to be told",
    );
    expect(h.thread().queuedFollowUps?.[0]?.text).toContain("Your goal is still on");
    await h.close();
  });

  it("what a move owes back is still paid after a restart", async () => {
    const first = await harness({ model: await seededWith({ goal: GOAL }) });
    first.state.online = false;
    await first.setSession("ready");
    const { requestId } = await first.queueMove("stop-now");
    // The last process recorded the cancel, and stopped before it paid.
    await first.dispatch({
      type: "thread.move.unqueue",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId,
      createdAt: now,
    });
    expect(first.thread().moveRestoreOwed?.interrupted).toMatchObject({ goalActive: true });
    await first.close();

    const restarted = await harness({ model: first.model() });
    await restarted.startReactor();
    await waitFor(
      () => restarted.thread().queuedFollowUps?.[0]?.afterMove === true,
      "the agent to be told",
    );
    expect(restarted.thread().moveRestoreOwed).toMatchObject({ goalOwed: true });
    await restarted.close();
  });
});

describe("MoveQueue, a put-back a restart cut short (Part 3e)", () => {
  const at = "2026-11-15T09:00:00.000Z";
  const target = { environmentId: MAC_MINI, label: "Mac mini" };
  const withRecord = async (patch: Partial<OrchestrationThread>) => {
    const model = await seeded();
    return {
      ...model,
      threads: model.threads.map((thread) =>
        thread.id === THREAD ? ({ ...thread, ...patch } as OrchestrationThread) : thread,
      ),
    };
  };

  it("sends the message it wrote, still queued when the last process stopped", async () => {
    const told = MessageId.make("m-told");
    const h = await harness({
      model: await withRecord({
        moveRestoreOwed: { target, told, goalOwed: true, at },
        queuedFollowUps: [
          {
            messageId: told,
            text: "The move to Mac mini didn't happen.",
            attachments: [],
            afterMove: true,
            runtimeMode: "auto",
            interactionMode: "default",
            createdAt: at,
          },
        ],
      }),
    });
    await h.startReactor();
    await waitFor(() => h.thread().messages.some((message) => message.id === told), "sent");
    expect(h.thread().messages.find((message) => message.id === told)?.afterMove).toBe(true);
    // The goal still waits for that turn to end (the reactor's to give).
    expect(h.thread().moveRestoreOwed).toMatchObject({ goalOwed: true });
    await h.close();
  });

  it("gives the goal back once everything else went, and the record clears", async () => {
    const h = await harness({
      model: await withRecord({
        moveRestoreOwed: { target, goalOwed: true, at },
        goal: {
          threadId: THREAD,
          objective: "Make the suite pass",
          status: "paused",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: at,
          updatedAt: at,
        },
      }),
    });
    await h.startReactor();
    await waitFor(() => (h.thread().moveRestoreOwed ?? null) === null, "the record to clear");
    await h.close();
  });
});

describe("MoveQueue, a family (Part 3f, (g))", () => {
  const CHILD = ThreadId.make("thread-child");
  const OTHER = ThreadId.make("thread-other-child");
  const addWorkingChild = async (h: Awaited<ReturnType<typeof harness>>, id: ThreadId) => {
    await h.dispatch({
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: id,
      projectId: PROJECT,
      title: id === CHILD ? "Fix tests" : "Review",
      modelSelection: agent,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: `/worktrees/${id}`,
      parentThreadId: THREAD,
      attachedToParent: true,
      createdAt: now,
    } as OrchestrationCommand);
    // At work, so its own queued move waits rather than starting at once.
    await h.dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(),
      threadId: id,
      session: {
        threadId: id,
        status: "running",
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: TurnId.make(`turn-${id}`),
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    } as OrchestrationCommand);
  };
  const family = async () => {
    const h = await harness();
    h.state.takes = { threadState: true, families: true };
    await h.startReactor();
    await addWorkingChild(h, CHILD);
    await addWorkingChild(h, OTHER);
    await h.setSession("running", { activeTurnId: TURN });
    const of = (id: ThreadId) => h.model().threads.find((entry) => entry.id === id)!;
    return { h, of };
  };

  it("an older app's move takes the whole family; a parent's move that ends ends its children's", async () => {
    const { h, of } = await family();
    const { requestId } = await h.queueMove();
    const id = h.thread().pendingMove?.family?.id;
    expect(h.thread().pendingMove?.family).toEqual({ id });
    for (const child of [CHILD, OTHER]) {
      expect(of(child).pendingMove?.family).toEqual({ id, parentThreadId: THREAD });
    }
    await h.run(h.queue.unqueue({ threadId: THREAD, requestId }));
    await waitFor(
      () => [CHILD, OTHER].every((child) => (of(child).pendingMove ?? null) === null),
      "its children's moves to end",
    );
    expect(of(CHILD).lastMoveOutcome).toMatchObject({
      result: "not_moved",
      words: "Its parent thread didn't move.",
    });
    // Its parent didn't move: it stays its child.
    expect(of(CHILD).attachedToParent).toBe(true);
    await h.close();
  });

  it("a current app moves exactly the threads it lists, each parent before its children", async () => {
    const { h, of } = await family();
    await h.run(
      h.queue.queue({
        threadId: THREAD,
        targetEnvironmentId: MAC_MINI,
        agent,
        mode: "when-done",
        familySelection: "explicit",
        children: [CHILD],
      }),
    );
    expect(of(CHILD).pendingMove?.family?.parentThreadId).toBe(THREAD);
    expect(of(OTHER).pendingMove ?? null).toBeNull();
    await h.run(
      h.queue.unqueue({ threadId: THREAD, requestId: h.thread().pendingMove!.requestId }),
    );
    await waitFor(() => (of(CHILD).pendingMove ?? null) === null, "the child's move to end");

    const result = await h.run(
      h.queue.queueMany({
        threadIds: [OTHER, THREAD],
        targetEnvironmentId: MAC_MINI,
        mode: "when-done",
        familySelection: "explicit",
      }),
    );
    expect(result.queued.map((entry) => entry.threadId)).toEqual([THREAD, OTHER]);
    expect(of(OTHER).pendingMove?.family?.parentThreadId).toBe(THREAD);
    expect(of(CHILD).pendingMove ?? null).toBeNull();
    // A child listed without its parent moves on its own: not yet.
    await h.run(
      h.queue.queueMany({
        threadIds: [CHILD],
        targetEnvironmentId: MAC_MINI,
        mode: "when-done",
        familySelection: "explicit",
      }),
    );
    expect(of(CHILD).pendingMove ?? null).toBeNull();
    await h.close();
  });

  it("queues a family in one go: no member starts before every member is queued", async () => {
    const h = await harness();
    h.state.takes = { threadState: true, families: true };
    // Its children are checked slowly; everyone is idle, so a move starts at once.
    h.state.childCheckMs = 200;
    await h.startReactor();
    for (const id of [CHILD, OTHER]) {
      await h.dispatch({
        type: "thread.create",
        commandId: nextCommandId(),
        threadId: id,
        projectId: PROJECT,
        title: id,
        modelSelection: agent,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: null,
        worktreePath: `/worktrees/${id}`,
        parentThreadId: THREAD,
        attachedToParent: true,
        createdAt: now,
      } as OrchestrationCommand);
    }
    const of = (id: ThreadId) => h.model().threads.find((entry) => entry.id === id)!;
    let queuedAtFirstStart: boolean | null = null;
    h.state.beforeStart = async () => {
      queuedAtFirstStart = [THREAD, CHILD, OTHER].every(
        (id) => (of(id).pendingMove ?? null) !== null || (of(id).move ?? null) !== null,
      );
    };
    await h.queueMove();
    await waitFor(() => queuedAtFirstStart !== null, "a move to start");
    expect(queuedAtFirstStart).toBe(true);
    await h.close();
  });
});
