import { randomUUID } from "node:crypto";

import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
} from "@threadlines/contracts";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";
import { goalWaitOf, goalWaitStep } from "@threadlines/shared/goalWaitPause";
import { sessionSlotParticipantId } from "@threadlines/shared/threadParticipants";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ScheduledTasks } from "../../scheduled/ScheduledTasks.ts";
import { GoalWaitReactor, type GoalWaitReactorShape } from "../Services/GoalWaitReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Events that can change what a thread waits on, or its goal: its cards (the
 * threads, settings, invites and commands its agent asked for), the threads
 * it started, its session (a turn about to start or running) and its goal.
 * Everything else (streamed text, tool calls) leaves both alone.
 */
const WAIT_EVENT_PREFIXES = [
  "thread.child-request",
  "thread.child-requests-reset",
  "thread.child-deliveries-cancelled",
  "thread.remote-child-updated",
  "thread.settings-change-",
  "thread.agent-request",
  "thread.command-request",
  "thread.command-run-",
  "thread.session-set",
  "thread.goal-state-set",
] as const;

const changesWait = (event: OrchestrationEvent): boolean =>
  event.aggregateKind === "thread" &&
  WAIT_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix));

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);

  const scheduleWaiting = Option.isSome(scheduledTasks)
    ? scheduledTasks.value.waitingThreadIds
    : Effect.succeed(new Set<ThreadId>() as ReadonlySet<ThreadId>);

  /**
   * Only a provider that can pause a goal gets one paused (Codex). Claude's
   * goal is a hook inside one turn with no pause; the others have no goals.
   */
  const canPauseGoal = (thread: OrchestrationThread) => {
    const holderId = sessionSlotParticipantId(thread.session);
    const instanceId =
      thread.session?.providerInstanceId ??
      thread.participants.find((entry) => entry.id === holderId)?.modelSelection.instanceId ??
      thread.modelSelection.instanceId;
    return providerService.getCapabilities(instanceId).pipe(
      Effect.map(
        (capabilities) =>
          capabilities.threadGoals === "supported" &&
          capabilities.threadGoalPause !== "unsupported",
      ),
      Effect.orElseSucceed(() => false),
    );
  };

  const syncThread = Effect.fn("GoalWaitReactor.syncThread")(function* (threadId: ThreadId) {
    const thread = yield* projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (thread === undefined || thread.goal === null || thread.deletedAt !== null) return;
    const scheduleAnswerWaiting = (yield* scheduleWaiting).has(threadId);
    // The decider decides again, from the thread as it stands then; this
    // only spares it a command when nothing would change.
    const step = goalWaitStep({
      goal: thread.goal,
      waiting: goalWaitOf(thread, scheduleAnswerWaiting) !== null,
      turnStarting: thread.session?.status === "starting",
    });
    if (step === null || !(yield* canPauseGoal(thread))) return;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.goal.wait.sync",
        commandId: CommandId.make(`goal-wait-sync:${threadId}:${randomUUID()}`),
        threadId,
        scheduleAnswerWaiting,
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("goal wait sync failed", { threadId, cause: Cause.pretty(cause) }),
        ),
      );
  });

  // A thread already queued is looked at once: it is read as it stands then.
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(Effect.andThen(syncThread(threadId))),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    });

  const start: GoalWaitReactorShape["start"] = Effect.fn("start")(function* () {
    const events = yield* orchestrationEngine.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        changesWait(event) ? enqueue(event.aggregateId as ThreadId) : Effect.void,
      ),
    );
    // A scheduled-task card shown or answered changes no thread event.
    if (Option.isSome(scheduledTasks)) {
      let previous: ReadonlySet<ThreadId> = yield* scheduleWaiting;
      yield* Effect.forkScoped(
        Stream.runForEach(scheduledTasks.value.changes.pipe(Stream.ignoreCause), () =>
          Effect.gen(function* () {
            const current = yield* scheduleWaiting;
            const changed = [...current, ...previous].filter(
              (threadId) => current.has(threadId) !== previous.has(threadId),
            );
            previous = current;
            yield* Effect.forEach(changed, enqueue, { discard: true });
          }),
        ),
      );
    }
    // Cards answered or threads finished while the server was down.
    const snapshot = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.orElseSucceed(() => ({ threads: [] as const })));
    yield* Effect.forEach(
      snapshot.threads.filter((thread) => thread.goal !== null),
      (thread) => enqueue(thread.id),
      { discard: true },
    );
  });

  return { start, drain: worker.drain } satisfies GoalWaitReactorShape;
});

export const GoalWaitReactorLive = Layer.effect(GoalWaitReactor, make);
