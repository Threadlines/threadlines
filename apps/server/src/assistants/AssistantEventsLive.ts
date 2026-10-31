/**
 * Keeps the assistants' event record (AssistantEvents.ts): one loop reads the
 * event log from the record's cursor while an assistant connection or an
 * alert target that's on exists,
 * another makes settling rows final as they come due, and the scheduled
 * tasks' changes add and resolve `schedule:` rows. The live event stream and
 * connection changes only ring a bell; everything is read from storage, so a
 * restart neither loses an event nor records one twice.
 */
import type { ScheduledTasksSnapshot, ThreadId } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryLive,
} from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import { type AlertSubject, makeAlertChecks } from "../pushAlerts/alertChecks.ts";
import { scheduleRequestAlertId } from "../pushAlerts/pushAlertRules.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import {
  AssistantAlertRepository,
  AssistantAlertRepositoryLive,
} from "./AssistantAlertRepository.ts";
import {
  AssistantEventRepository,
  AssistantEventRepositoryLive,
  type SettlingAssistantEventRow,
} from "./AssistantEventRepository.ts";
import {
  type AssistantEvent,
  type AssistantEventAction,
  assistantEventActionsForEvent,
  assistantEventNameOf,
  AssistantEvents,
  type AssistantEventsShape,
  planEventKey,
} from "./AssistantEvents.ts";
import { Assistants } from "./Assistants.ts";

/** Events read per pass through the log. */
const EVENT_BATCH = 500;
/** Settling rows judged per pass. */
const SETTLE_BATCH = 20;
/** Recorded events are kept this long. */
export const ASSISTANT_EVENTS_KEPT_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
const IDLE_WAKE_MS = 30_000;
/** A row deferred again and again (work still going) is looked at less often, up to this. */
const MAX_RECHECK_MS = 5 * 60_000;
/** A row whose thread moved while it was judged goes behind the other due rows for this long. */
const STALE_RETRY_MS = 250;

const iso = (ms: number) => new Date(ms).toISOString();

const KIND_OF_NAME = {
  "thread.needs_you": "needs_you",
  "thread.finished": "finished",
  "thread.failed": "failed",
} as const;

/** A settling row as the shared checks read it. */
const subjectOf = (row: SettlingAssistantEventRow): AlertSubject => ({
  alertId: row.subjectKey,
  threadId: row.threadId,
  kind: KIND_OF_NAME[row.name],
  reason: row.reason,
  subjectId: row.subjectKey.slice(row.subjectKey.indexOf(":") + 1),
  occurredAt: row.occurredAt,
});

const make = Effect.gen(function* () {
  const repo = yield* AssistantEventRepository;
  const engine = yield* OrchestrationEngineService;
  const connections = yield* OutsideAgentConnectionRepository;
  const alertTargets = yield* AssistantAlertRepository;
  const projections = yield* ProjectionSnapshotQuery;
  const assistants = yield* Effect.serviceOption(Assistants);
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
  const checks = yield* makeAlertChecks;
  const discoveryBell = yield* Queue.sliding<void>(1);
  const settleBell = yield* Queue.sliding<void>(1);
  const recorded = yield* PubSub.sliding<void>(1);
  /** Turning on and off, against `keep`: a target saved inside it keeps the record on. */
  const onOff = yield* Semaphore.make(1);
  /** Agents' scheduled-task changes waiting for the user, from the latest snapshot. */
  let waitingScheduleRequests: ReadonlySet<string> = new Set();
  let scheduleSnapshotSeen = false;
  /** The latest snapshot, applied again when the record turns on. */
  let latestScheduleSnapshot: ScheduledTasksSnapshot | null = null;

  // ----- reading the event log -------------------------------------------------

  /** On, from now: history is never recorded. Scheduled-task changes answered while it was off resolve their rows now. */
  const begin = (now: number) =>
    Effect.gen(function* () {
      yield* repo.begin({ cursor: yield* repo.latestEventSequence, startedAt: iso(now) });
      if (latestScheduleSnapshot !== null) yield* onScheduleSnapshot(latestScheduleSnapshot);
    });

  /** Whether anything keeps the record: an assistant connection, or a target that's on. */
  const wanted = Effect.gen(function* () {
    if ((yield* connections.countLive("assistant")) > 0) return true;
    return (yield* alertTargets.countOn.pipe(Effect.orElseSucceed(() => 1))) > 0;
  });

  /** Turns the record on or off as it should be; the cursor to read from, or null while off. */
  const turnOnOrOff = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const state = yield* repo.getState;
    if (!(yield* wanted)) {
      // Off: nobody to keep it for. Whatever happens until it turns on again
      // is never read, and what was still settling is dropped.
      if (state.cursor !== null) yield* repo.stop(iso(now));
      return null;
    }
    if (state.cursor === null) {
      yield* begin(now);
      return null;
    }
    return state.cursor;
  }).pipe(onOff.withPermits(1));

  /** One pass through the event log; true when more is waiting. */
  const discoverOnce = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cursor = yield* turnOnOrOff;
    if (cursor === null) return false;
    const events = yield* engine
      .readEvents(cursor)
      .pipe(Stream.take(EVENT_BATCH), Stream.runCollect);
    const last = events.at(-1);
    if (!last) return false;
    const actions = events.flatMap((event) => assistantEventActionsForEvent(event));
    yield* repo.applyActions({ actions, cursor: last.sequence, now });
    if (actions.some((action) => action.type === "add")) yield* Queue.offer(settleBell, undefined);
    return events.length === EVENT_BATCH;
  });

  const onScheduleSnapshot = (snapshot: ScheduledTasksSnapshot) =>
    Effect.gen(function* () {
      const current = new Set(snapshot.requests.map((request) => request.requestId));
      waitingScheduleRequests = current;
      scheduleSnapshotSeen = true;
      latestScheduleSnapshot = snapshot;
      const state = yield* repo.getState;
      if (state.cursor === null) return;
      const actions: AssistantEventAction[] = [];
      for (const request of snapshot.requests) {
        // Waiting since before the record turned on: history.
        if (state.startedAt !== null && request.createdAt < state.startedAt) continue;
        actions.push({
          type: "add",
          intent: {
            alertId: scheduleRequestAlertId(request.requestId),
            threadId: request.threadId,
            kind: "needs_you",
            reason: "schedule",
            subjectId: request.requestId,
            detail: null,
            holdMs: 0,
            occurredAt: request.createdAt,
          },
        });
      }
      // Answered while this computer was off counts too: whatever isn't waiting now is over.
      for (const key of yield* repo.standingScheduleKeys) {
        if (!current.has(key.slice("schedule:".length))) {
          actions.push({ type: "cancel", subjectKey: key, why: "answered" });
        }
      }
      if (actions.length === 0) return;
      yield* repo.applyActions({ actions, now: yield* Clock.currentTimeMillis });
      yield* Queue.offer(settleBell, undefined);
    });

  // ----- making rows final -----------------------------------------------------

  /** Judges one due row at the cursor as it is now; true when it became final. */
  const settleOne = (row: SettlingAssistantEventRow, now: number) =>
    Effect.gen(function* () {
      const { cursor } = yield* repo.getState;
      if (cursor === null) return false;
      const verdict = yield* checks.judge(subjectOf(row), now, {
        available: Option.isSome(scheduledTasks),
        seen: scheduleSnapshotSeen,
        waiting: waitingScheduleRequests,
      });
      switch (verdict.type) {
        case "drop":
          yield* repo.drop({ subjectKey: row.subjectKey, why: "superseded", now: iso(now) });
          return false;
        case "defer": {
          // Work that keeps going is looked at less often the longer it settles.
          const waited = Math.max(0, now - Date.parse(row.addedAt));
          const backoff = now + Math.min(MAX_RECHECK_MS, waited / 10);
          yield* repo.defer(row.subjectKey, iso(Math.max(verdict.untilMs, backoff)));
          return false;
        }
        case "send": {
          const outcome =
            verdict.planId !== null && row.subjectKey.startsWith("turn:")
              ? yield* repo.recordPlan({
                  fromSubjectKey: row.subjectKey,
                  planSubjectKey: planEventKey(verdict.planId),
                  threadId: row.threadId,
                  projectId: verdict.thread.projectId,
                  occurredAt: row.occurredAt,
                  now: iso(now),
                  judgedAt: cursor,
                })
              : yield* repo.record({
                  subjectKey: row.subjectKey,
                  threadId: row.threadId,
                  name: assistantEventNameOf(verdict.kind),
                  reason: verdict.reason,
                  projectId: verdict.thread.projectId,
                  now: iso(now),
                  judgedAt: cursor,
                });
          // Stale: its thread moved after the cursor. It is judged again once
          // the record read what happened, behind the rows due before it.
          if (outcome === "stale") {
            yield* repo.defer(row.subjectKey, iso(now + STALE_RETRY_MS));
          }
          return outcome === "recorded";
        }
      }
    });

  /**
   * One pass over the settling rows that are due, while the record is on;
   * true when more are waiting. An interrupt or an answer about a row's
   * thread that the record hasn't read yet (after a restart, say) keeps it
   * settling (`record`'s rule).
   */
  const settleDue = Effect.gen(function* () {
    const state = yield* repo.getState;
    if (state.cursor === null) return false;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* repo.dueSettling(iso(now), SETTLE_BATCH);
    let any = false;
    for (const row of rows) {
      if (yield* settleOne(row, now)) any = true;
    }
    if (any) yield* PubSub.publish(recorded, undefined);
    return rows.length === SETTLE_BATCH && any;
  });

  // ----- loops -----------------------------------------------------------------

  const logged =
    (what: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(`assistant events: ${what} failed`, {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

  const waitFor = (bell: Queue.Queue<void>, ms: number) =>
    Queue.take(bell).pipe(Effect.timeoutOption(Duration.millis(ms)), Effect.asVoid);

  const discoveryLoop = Effect.gen(function* () {
    let lastPrune = 0;
    for (;;) {
      const more = yield* discoverOnce.pipe(logged("reading the event log"));
      if (more) continue;
      const now = yield* Clock.currentTimeMillis;
      if (now - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = now;
        yield* repo.prune(iso(now - ASSISTANT_EVENTS_KEPT_MS)).pipe(logged("pruning"));
      }
      yield* waitFor(discoveryBell, IDLE_WAKE_MS);
    }
  });

  const settleLoop = Effect.gen(function* () {
    for (;;) {
      const more = yield* settleDue.pipe(logged("settling"));
      if (more) continue;
      const now = yield* Clock.currentTimeMillis;
      const next = yield* repo.nextSettleAt.pipe(Effect.orElseSucceed(() => Option.none<string>()));
      const waitMs = Option.match(next, {
        onNone: () => IDLE_WAKE_MS,
        onSome: (at) => Math.max(250, Math.min(IDLE_WAKE_MS, Date.parse(at) - now)),
      });
      yield* waitFor(settleBell, waitMs);
    }
  });

  const start: AssistantEventsShape["start"] = () =>
    Effect.gen(function* () {
      const ring = () => Queue.offer(discoveryBell, undefined);
      yield* Effect.forkScoped(Stream.runForEach(engine.streamDomainEvents, ring));
      if (Option.isSome(assistants)) {
        // A connection made or removed turns the record on or off.
        yield* Effect.forkScoped(Stream.runForEach(assistants.value.changes, ring));
      }
      if (Option.isSome(scheduledTasks)) {
        yield* Effect.forkScoped(
          Stream.runForEach(scheduledTasks.value.changes, onScheduleSnapshot).pipe(
            logged("watching scheduled tasks"),
            Effect.repeat(Schedule.spaced(Duration.seconds(30))),
          ),
        );
      }
      yield* Effect.forkScoped(discoveryLoop);
      yield* Effect.forkScoped(settleLoop);
    });

  const keep: AssistantEventsShape["keep"] = (use) =>
    Effect.gen(function* () {
      const state = yield* repo.getState;
      if (state.cursor === null) yield* begin(yield* Clock.currentTimeMillis);
      return yield* use(yield* position);
    }).pipe(onOff.withPermits(1));

  /** Whether a plan the record holds as needing the user still does: open, on the thread's latest turn. */
  const planStands = (threadId: ThreadId, planId: string) =>
    projections.getThreadDetailById(threadId).pipe(
      Effect.map((found) => {
        if (Option.isNone(found)) return false;
        const thread = found.value;
        const plan = thread.proposedPlans.find((entry) => entry.id === planId);
        return (
          plan !== undefined &&
          plan.implementedAt === null &&
          plan.dismissedAt === null &&
          thread.latestTurn?.turnId === plan.turnId
        );
      }),
      Effect.orElseSucceed(() => "unknown" as const),
    );

  const current: AssistantEventsShape["current"] = (seq) =>
    Effect.gen(function* () {
      const found = yield* repo.recorded(seq);
      if (Option.isNone(found)) return null;
      const { subjectKey, ...event } = found.value;
      const project = yield* projections.getProjectShellById(event.projectId).pipe(
        Effect.map((shell) => (Option.isSome(shell) ? shell.value.title : null)),
        Effect.orElseSucceed(() => null),
      );
      return { event, project, stands: yield* standsNow(event, subjectKey) };
    });

  /** Whether a recorded event still holds (`current`). */
  const standsNow = (event: AssistantEvent, subjectKey: string) =>
    Effect.gen(function* () {
      if (event.name !== "thread.needs_you") return true;
      if (event.resolvedAt !== null) return false;
      if (subjectKey.startsWith("plan:")) {
        return yield* planStands(event.threadId, subjectKey.slice("plan:".length));
      }
      const now = yield* Clock.currentTimeMillis;
      const verdict = yield* checks.judge(
        {
          alertId: subjectKey,
          threadId: event.threadId,
          kind: "needs_you",
          reason: event.reason,
          subjectId: subjectKey.slice(subjectKey.indexOf(":") + 1),
          occurredAt: event.occurredAt,
        },
        now,
        {
          available: Option.isSome(scheduledTasks),
          seen: scheduleSnapshotSeen,
          waiting: waitingScheduleRequests,
        },
      );
      return verdict.type === "send"
        ? verdict.kind === "needs_you"
        : verdict.type === "drop"
          ? false
          : ("unknown" as const);
    });

  const position: AssistantEventsShape["position"] = repo.getState.pipe(
    Effect.map((state) => ({
      recordId: state.recordId,
      running: state.cursor !== null,
      lastSeq: state.lastSeq,
      prunedThroughSeq: state.prunedThroughSeq,
    })),
  );

  const since: AssistantEventsShape["since"] = (input) =>
    Effect.gen(function* () {
      const { lastSeq } = yield* repo.getState;
      const limit = Math.max(1, Math.floor(input.limit));
      const rows = yield* repo.since({
        after: input.after,
        upTo: lastSeq,
        limit: limit + 1,
        ...(input.names !== undefined ? { names: input.names } : {}),
        ...(input.projectIds !== undefined ? { projectIds: input.projectIds } : {}),
      });
      const more = rows.length > limit;
      const events = more ? rows.slice(0, limit) : rows;
      return {
        events,
        more,
        upTo: more ? events.at(-1)!.seq : Math.max(lastSeq, input.after),
      };
    });

  return AssistantEvents.of({
    position,
    since,
    current,
    keep,
    changes: Stream.fromPubSub(recorded),
    start,
  });
});

/** The record over the storage it is given (tests give their own connections). */
export const AssistantEventsLayer = Layer.effect(AssistantEvents, make);

export const AssistantEventsLive = AssistantEventsLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AssistantEventRepositoryLive,
      OutsideAgentConnectionRepositoryLive,
      AssistantAlertRepositoryLive,
    ),
  ),
);
