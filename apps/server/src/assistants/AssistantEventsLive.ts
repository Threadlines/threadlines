/**
 * Keeps the assistants' event record (AssistantEvents.ts): one loop reads the
 * event log from the record's cursor while an assistant connection exists,
 * another makes settling rows final as they come due, and the scheduled
 * tasks' changes add and resolve `schedule:` rows. The live event stream and
 * connection changes only ring a bell; everything is read from storage, so a
 * restart neither loses an event nor records one twice.
 */
import type { ScheduledTasksSnapshot } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryLive,
} from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import { type AlertSubject, makeAlertChecks } from "../pushAlerts/alertChecks.ts";
import { scheduleRequestAlertId } from "../pushAlerts/pushAlertRules.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import {
  AssistantEventRepository,
  AssistantEventRepositoryLive,
  type SettlingAssistantEventRow,
} from "./AssistantEventRepository.ts";
import {
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
  const assistants = yield* Effect.serviceOption(Assistants);
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
  const checks = yield* makeAlertChecks;
  const discoveryBell = yield* Queue.sliding<void>(1);
  const settleBell = yield* Queue.sliding<void>(1);
  const recorded = yield* PubSub.sliding<void>(1);
  /** Agents' scheduled-task changes waiting for the user, from the latest snapshot. */
  let waitingScheduleRequests: ReadonlySet<string> = new Set();
  let scheduleSnapshotSeen = false;

  // ----- reading the event log -------------------------------------------------

  /** One pass through the event log; true when more is waiting. */
  const discoverOnce = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const state = yield* repo.getState;
    if ((yield* connections.countLive("assistant")) === 0) {
      // Off: nobody to keep it for. Whatever happens until it turns on again is never read.
      if (state.cursor !== null) yield* repo.stop;
      return false;
    }
    if (state.cursor === null) {
      // On, from now: history is never recorded.
      yield* repo.begin({ cursor: yield* repo.latestEventSequence, startedAt: iso(now) });
      return false;
    }
    const events = yield* engine
      .readEvents(state.cursor)
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

  const settleOne = (row: SettlingAssistantEventRow, now: number) =>
    Effect.gen(function* () {
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
        case "send":
          return verdict.planId !== null && row.subjectKey.startsWith("turn:")
            ? yield* repo.recordPlan({
                fromSubjectKey: row.subjectKey,
                planSubjectKey: planEventKey(verdict.planId),
                threadId: row.threadId,
                projectId: verdict.thread.projectId,
                occurredAt: row.occurredAt,
                now: iso(now),
              })
            : yield* repo.record({
                subjectKey: row.subjectKey,
                name: assistantEventNameOf(verdict.kind),
                reason: verdict.reason,
                projectId: verdict.thread.projectId,
                now: iso(now),
              });
      }
    });

  /** One pass over the settling rows that are due; true when more are waiting. */
  const settleDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* repo.dueSettling(iso(now), SETTLE_BATCH);
    let any = false;
    for (const row of rows) {
      if (yield* settleOne(row, now)) any = true;
    }
    if (any) yield* PubSub.publish(recorded, undefined);
    return rows.length === SETTLE_BATCH;
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
    changes: Stream.fromPubSub(recorded),
    start,
  });
});

/** The record over the storage it is given (tests give their own connections). */
export const AssistantEventsLayer = Layer.effect(AssistantEvents, make);

export const AssistantEventsLive = AssistantEventsLayer.pipe(
  Layer.provide(Layer.mergeAll(AssistantEventRepositoryLive, OutsideAgentConnectionRepositoryLive)),
);
