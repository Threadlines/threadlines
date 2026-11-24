import { randomUUID } from "node:crypto";

import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
} from "@threadlines/contracts";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";
import { goalWaitOf, goalWaitStep, turnAboutToStart } from "@threadlines/shared/goalWaitPause";
import { sessionSlotParticipantId } from "@threadlines/shared/threadParticipants";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ScheduledTasks } from "../../scheduled/ScheduledTasks.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { GoalWaitReactor, type GoalWaitReactorShape } from "../Services/GoalWaitReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Events that can change what a thread waits on, or its goal: its cards (the
 * threads, settings, invites and commands its agent asked for), the threads
 * it started, its queue and session (a turn about to start or running) and
 * its goal.
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
  "thread.follow-up-",
  "thread.session-set",
  // A revert can take a waiting command card or its run away.
  "thread.reverted",
  // An agent leaving takes its invite and its requests with it.
  "thread.participant-",
  "thread.goal-state-set",
] as const;

const changesWait = (event: OrchestrationEvent): boolean =>
  event.aggregateKind === "thread" &&
  WAIT_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix));

/**
 * The user acted on the goal: paused, resumed, edited or cleared it, or
 * pressed Stop. The decider sees most of these itself; a thread whose only
 * wait is a scheduled-task card it can't see, so this says so.
 */
const userActedOnGoal = (event: OrchestrationEvent): boolean =>
  (event.type === "thread.goal-set-requested" && event.payload.origin !== "automatic") ||
  event.type === "thread.goal-clear-requested" ||
  event.type === "thread.turn-interrupt-requested" ||
  event.type === "thread.session-stop-requested";

/** What a look at a thread carries besides its state. */
interface SyncFlags {
  readonly userActed: boolean;
  readonly retryResume: boolean;
}

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
  const analytics = yield* Effect.serviceOption(AnalyticsService);

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

  const syncThread = Effect.fn("GoalWaitReactor.syncThread")(function* (
    threadId: ThreadId,
    flags: SyncFlags,
  ) {
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
      turnStarting: turnAboutToStart(thread),
      userActed: flags.userActed,
      retryResume: flags.retryResume,
    });
    // Forgetting a mark sends the provider nothing; a pause or resume needs
    // a provider that has one.
    if (step === null || (step.send !== null && !(yield* canPauseGoal(thread)))) return;
    const dispatched = yield* orchestrationEngine
      .dispatch({
        type: "thread.goal.wait.sync",
        commandId: CommandId.make(`goal-wait-sync:${threadId}:${randomUUID()}`),
        threadId,
        scheduleAnswerWaiting,
        ...(flags.userActed ? { userActed: true } : {}),
        ...(flags.retryResume ? { retryResume: true } : {}),
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("goal wait sync failed", { threadId, cause: Cause.pretty(cause) }).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (dispatched && step.send !== null && Option.isSome(analytics)) {
      yield* analytics.value.record("provider.goal.wait_sync", {
        action: step.send,
      });
    }
  });

  // A thread already queued is looked at once, read as it stands then; the
  // flags of every request for it in between add up.
  const queued = new Map<ThreadId, SyncFlags>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.suspend(() => {
      const flags = queued.get(threadId) ?? { userActed: false, retryResume: false };
      queued.delete(threadId);
      return syncThread(threadId, flags);
    }),
  );
  const enqueue = (threadId: ThreadId, flags: Partial<SyncFlags> = {}) =>
    Effect.suspend(() => {
      const pending = queued.get(threadId);
      const next = {
        userActed: (pending?.userActed ?? false) || flags.userActed === true,
        retryResume: (pending?.retryResume ?? false) || flags.retryResume === true,
      };
      queued.set(threadId, next);
      return pending === undefined ? worker.enqueue(threadId) : Effect.void;
    });

  const start: GoalWaitReactorShape["start"] = Effect.fn("start")(function* () {
    const events = yield* orchestrationEngine.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        userActedOnGoal(event)
          ? enqueue(event.aggregateId as ThreadId, { userActed: true })
          : changesWait(event)
            ? enqueue(event.aggregateId as ThreadId)
            : Effect.void,
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
            yield* Effect.forEach(changed, (threadId) => enqueue(threadId), { discard: true });
          }),
        ),
      );
    }
    // Cards answered or threads finished while the server was down, and a
    // resume a restart cut off before the provider confirmed it.
    const snapshot = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.orElseSucceed(() => ({ threads: [] as const })));
    yield* Effect.forEach(
      snapshot.threads.filter((thread) => thread.goal !== null),
      (thread) => enqueue(thread.id, { retryResume: true }),
      { discard: true },
    );
  });

  return { start, drain: worker.drain } satisfies GoalWaitReactorShape;
});

export const GoalWaitReactorLive = Layer.effect(GoalWaitReactor, make);
