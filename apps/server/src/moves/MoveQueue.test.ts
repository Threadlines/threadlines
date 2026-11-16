import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveError,
  ThreadMoveId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ThreadMoveRequestId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import type { ProviderStopConfirmation } from "../provider/Services/ProviderAdapter.ts";
import { makeMoveQueue, type MoveQueueShape } from "./MoveQueue.ts";
import type { QueuedMoveStart } from "./ThreadMoves.ts";

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
    /** Runs right before a start, as if a provider turn slipped in. */
    beforeStart: null as null | (() => Promise<void>),
  };

  const dispatch = (command: OrchestrationCommand): Effect.Effect<void, ThreadMoveError> =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({ command, readModel: model }).pipe(
        Effect.mapError((error) => new ThreadMoveError({ detail: error.message })),
      );
      for (const planned of Array.isArray(decided) ? decided : [decided]) {
        sequence += 1;
        const event = { ...planned, sequence } as OrchestrationEvent;
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
      readModel: Effect.sync(() => model),
      quiesce: () =>
        Effect.sync(() => {
          state.quiesceCalls += 1;
          return state.confirmation;
        }),
      checkQueue: () => Effect.succeed({ label: "Mac mini" }),
      startQueued,
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

  it("ends as blocked when the agent set a check-back during the turn", async () => {
    const h = await harness();
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
