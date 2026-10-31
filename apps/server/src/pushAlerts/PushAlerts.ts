// @effect-diagnostics nodeBuiltinImport:off
/**
 * Phone alerts (docs/design/push-alerts.md): which paired phones want alerts
 * from this computer, what is worth one, and getting it there.
 *
 * Alerts are found by reading the orchestration event log from a saved
 * position (pushAlertRules decides what each event means), so a restart
 * neither loses one nor sends one twice. An alert is checked again right
 * before it goes out, against the thread as it is then: an answered approval,
 * a turn that led to more work, or a thread someone is looking at sends
 * nothing. Each phone's alert is sealed for that phone (RFC 8291) and handed
 * to the relay, which holds the phone's address and decides whether that
 * phone still wants it.
 */
import { createHash } from "node:crypto";

import {
  type AuthSessionId,
  PushAlertsError,
  type PushAlertKind,
  type PushRegisterInput,
  type PushSendTestResult,
  type RelayDeviceAlertResult,
  type ScheduledTasksSnapshot,
  type ThreadId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { RelayHost } from "../relay/RelayHost.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import { type AlertVerdict, makeAlertChecks } from "./alertChecks.ts";
import {
  type PushAlertRow,
  PushAlertRepository,
  PushAlertRepositoryLive,
  type PushRegistrationRow,
} from "./PushAlertRepository.ts";
import {
  ALERT_EVENT_MAX_AGE_MS,
  alertPayload,
  type PushAlertAction,
  pushAlertActionsForEvent,
  retryDelayMs,
  scheduleRequestAlertId,
  testAlertPayload,
} from "./pushAlertRules.ts";
import { makePushPresence } from "./pushPresence.ts";
import { encryptWebPushPayload } from "./webPushEncryption.ts";

export interface PushAlertsShape {
  /** Keeps the calling phone's sealing keys (`push.register`). */
  readonly register: (
    sessionId: AuthSessionId,
    input: PushRegisterInput,
  ) => Effect.Effect<void, PushAlertsError>;
  /** Forgets them (`push.unregister`). */
  readonly unregister: (sessionId: AuthSessionId) => Effect.Effect<void, PushAlertsError>;
  /** Sends the calling phone a test alert now (`push.sendTest`). */
  readonly sendTest: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<PushSendTestResult, PushAlertsError>;
  /** This connection shows `threadId` now, or no thread (`presence.setViewing`). */
  readonly setViewing: (viewerId: string, threadId: ThreadId | null) => Effect.Effect<void>;
  /** The connection closed. */
  readonly releaseViewer: (viewerId: string) => Effect.Effect<void>;
  /** Looks for alerts and sends them until the scope closes. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class PushAlerts extends Context.Service<PushAlerts, PushAlertsShape>()(
  "threadlines/pushAlerts/PushAlerts",
) {}

/** Events read per pass through the log. */
const EVENT_BATCH = 500;
/** Alerts handled per pass. */
const ALERT_BATCH = 20;
/** Attempts per phone before an alert gives up on it. */
const MAX_DELIVERY_ATTEMPTS = 6;
/** Finished alerts are forgotten after this. */
const KEEP_FINISHED_ALERTS_MS = 2 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
const IDLE_WAKE_MS = 30_000;

const iso = (ms: number) => new Date(ms).toISOString();
const fromBase64Url = (text: string) => Buffer.from(text, "base64url");

/** Names an alert to the relay without saying what it is about, so a retry is never sent twice. */
const alertKey = (alertId: string) =>
  createHash("sha256").update(alertId).digest("base64url").slice(0, 32);

/** Alerts for one thread replace each other while undelivered (RFC 8030 Topic). */
const alertTopic = (threadId: string) =>
  createHash("sha256").update(threadId).digest("base64url").slice(0, 22);

/** The phone's app origin, when it is one alerts may open: https, or http on this machine. */
function checkedAppOrigin(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return url.origin;
    }
    return null;
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const repo = yield* PushAlertRepository;
  const relayHost = yield* RelayHost;
  const engine = yield* OrchestrationEngineService;
  const environment = yield* ServerEnvironment;
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
  const checks = yield* makeAlertChecks;
  const presence = makePushPresence();
  const senderBell = yield* Queue.sliding<void>(1);
  const discoveryBell = yield* Queue.sliding<void>(1);
  /** Agents' scheduled-task changes waiting for the user, from the latest snapshot. */
  let waitingScheduleRequests = new Set<string>();
  /** Until the scheduler's first snapshot, a schedule alert can't be judged: it waits. */
  let scheduleSnapshotSeen = false;

  const failWith = (code: PushAlertsError["code"], detail: string) =>
    Effect.fail(new PushAlertsError({ code, detail }));

  const callingDevice = (sessionId: AuthSessionId) =>
    relayHost
      .activeClientDeviceForSession(sessionId)
      .pipe(
        Effect.flatMap((deviceId) =>
          deviceId === null
            ? failWith(
                "not-a-paired-phone",
                "Only a device paired with Connect a device gets alerts.",
              )
            : Effect.succeed(deviceId),
        ),
      );

  const storageFailed = () =>
    new PushAlertsError({ code: "invalid", detail: "This computer couldn't save that." });

  // ----- registrations ---------------------------------------------------------

  const register: PushAlertsShape["register"] = (sessionId, input) =>
    Effect.gen(function* () {
      const deviceId = yield* callingDevice(sessionId);
      const p256dh = fromBase64Url(input.p256dh);
      const auth = fromBase64Url(input.auth);
      const appOrigin = checkedAppOrigin(input.appOrigin);
      if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16 || !appOrigin) {
        return yield* failWith("invalid", "That push subscription isn't one alerts can use.");
      }
      yield* repo
        .saveRegistration({
          deviceId,
          registrationId: input.registrationId,
          p256dh: input.p256dh,
          auth: input.auth,
          keyId: input.keyId,
          appOrigin,
          now: iso(yield* Clock.currentTimeMillis),
        })
        .pipe(Effect.mapError(storageFailed));
    });

  const unregister: PushAlertsShape["unregister"] = (sessionId) =>
    Effect.gen(function* () {
      const deviceId = yield* callingDevice(sessionId);
      yield* repo.deleteRegistration(deviceId).pipe(Effect.mapError(storageFailed));
    });

  /** Registrations of phones that still have access; the others are forgotten on the way. */
  const activeRegistrations = Effect.gen(function* () {
    const rows = yield* repo.listRegistrations;
    const active: PushRegistrationRow[] = [];
    for (const row of rows) {
      if (yield* relayHost.isActiveClientDevice(row.deviceId)) active.push(row);
      else yield* repo.deleteRegistration(row.deviceId, row.registrationId);
    }
    return active;
  });

  const computerLabel = environment.getDescriptor.pipe(
    Effect.map((descriptor) => descriptor.label),
  );

  /** Seals `text` for one phone and asks the relay to send it. */
  const sealAndSend = (
    registration: PushRegistrationRow,
    text: string,
    message: {
      readonly kind: PushAlertKind | "test";
      readonly ttlSeconds: number;
      readonly urgency: "normal" | "high";
      readonly topic?: string;
      readonly alertKey?: string;
    },
  ) =>
    Effect.gen(function* () {
      const sealed = encryptWebPushPayload(
        { p256dh: fromBase64Url(registration.p256dh), auth: fromBase64Url(registration.auth) },
        new TextEncoder().encode(text),
      );
      const result = yield* relayHost.sendDeviceAlert(registration.deviceId, {
        registrationId: registration.registrationId,
        kind: message.kind,
        payload: Buffer.from(sealed).toString("base64url"),
        ttlSeconds: message.ttlSeconds,
        urgency: message.urgency,
        ...(message.topic !== undefined ? { topic: message.topic } : {}),
        ...(message.alertKey !== undefined ? { alertKey: message.alertKey } : {}),
      });
      if (result.outcome === "gone" || result.outcome === "stale") {
        yield* repo
          .deleteRegistration(registration.deviceId, registration.registrationId)
          .pipe(Effect.ignore);
      }
      return result;
    });

  const sendTest: PushAlertsShape["sendTest"] = (sessionId) =>
    Effect.gen(function* () {
      const deviceId = yield* callingDevice(sessionId);
      const registration = yield* repo
        .getRegistration(deviceId)
        .pipe(Effect.mapError(storageFailed));
      if (Option.isNone(registration)) {
        return yield* failWith("not-registered", "Turn alerts on first.");
      }
      const text = testAlertPayload({
        computerLabel: yield* computerLabel,
        navigate: `${registration.value.appOrigin}/settings/general`,
      });
      const result = yield* sealAndSend(registration.value, text, {
        kind: "test",
        ttlSeconds: 60,
        urgency: "normal",
      }).pipe(
        Effect.mapError(
          (error) =>
            new PushAlertsError({
              code: "relay-unavailable",
              detail: error.detail || "Couldn't reach the relay.",
            }),
        ),
      );
      return { outcome: result.outcome };
    });

  // ----- finding alerts ----------------------------------------------------------

  /** One pass through the event log; true when more is waiting. */
  const discoverOnce = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cursor = yield* repo.getCursor;
    if (Option.isNone(cursor)) {
      // First run: history never alerts.
      yield* repo.applyActions({ actions: [], cursor: yield* repo.latestEventSequence, now });
      return false;
    }
    const events = yield* engine
      .readEvents(cursor.value)
      .pipe(Stream.take(EVENT_BATCH), Stream.runCollect);
    const last = events.at(-1);
    if (!last) return false;
    const anyPhone = (yield* repo.listRegistrations).length > 0;
    const actions: PushAlertAction[] = [];
    for (const event of events) {
      const fresh = now - Date.parse(event.occurredAt) <= ALERT_EVENT_MAX_AGE_MS;
      for (const action of pushAlertActionsForEvent(event)) {
        // Cancels always apply; a new alert only for a recent event, with a phone to tell.
        if (action.type !== "add" || (fresh && anyPhone)) actions.push(action);
      }
    }
    yield* repo.applyActions({ actions, cursor: last.sequence, now });
    if (actions.some((action) => action.type === "add")) yield* Queue.offer(senderBell, undefined);
    return events.length === EVENT_BATCH;
  });

  const onScheduleSnapshot = (snapshot: ScheduledTasksSnapshot) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const current = new Set(snapshot.requests.map((request) => request.requestId));
      const anyPhone = (yield* repo.listRegistrations).length > 0;
      const actions: PushAlertAction[] = [];
      for (const request of snapshot.requests) {
        if (waitingScheduleRequests.has(request.requestId) || !anyPhone) continue;
        if (now - Date.parse(request.createdAt) > ALERT_EVENT_MAX_AGE_MS) continue;
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
      for (const requestId of waitingScheduleRequests) {
        if (!current.has(requestId)) {
          actions.push({ type: "cancel", alertId: scheduleRequestAlertId(requestId) });
        }
      }
      // Remembered only once saved: a failed save is tried again with the next snapshot.
      if (actions.length > 0) yield* repo.applyActions({ actions, now });
      waitingScheduleRequests = current;
      scheduleSnapshotSeen = true;
      if (actions.length > 0) yield* Queue.offer(senderBell, undefined);
    });

  // ----- sending them ----------------------------------------------------------

  /** Whether the alert still holds, as the thread is now (alertChecks), with nobody looking at it. */
  const evaluate = (alert: PushAlertRow, now: number): Effect.Effect<AlertVerdict> =>
    presence.isViewed(alert.threadId, now)
      ? Effect.succeed({ type: "drop" })
      : checks.judge(alert, now, {
          available: Option.isSome(scheduledTasks),
          seen: scheduleSnapshotSeen,
          waiting: waitingScheduleRequests,
        });

  const handleAlert = (
    alert: PushAlertRow,
    registrations: ReadonlyArray<PushRegistrationRow>,
    label: string,
    now: number,
  ) =>
    Effect.gen(function* () {
      if (registrations.length === 0) return yield* repo.finishAlert(alert.alertId, "dropped");
      // Read in a batch: the alert may have been cancelled since (an answer, a visit).
      if (!(yield* repo.isPending(alert.alertId))) return;
      const verdict = yield* evaluate(alert, now);
      if (verdict.type === "drop") return yield* repo.finishAlert(alert.alertId, "dropped");
      if (verdict.type === "defer")
        return yield* repo.deferAlert(alert.alertId, iso(verdict.untilMs));
      if (verdict.kind !== alert.kind || verdict.reason !== alert.reason) {
        yield* repo.retypeAlert(alert.alertId, verdict.kind, verdict.reason);
      }
      const environmentId = yield* environment.getEnvironmentId;
      const expiresAt = Date.parse(alert.expiresAt);
      const deliveries = yield* repo.ensureDeliveries({
        alertId: alert.alertId,
        registrations,
        now: iso(now),
      });
      let nextTry: number | null = null;
      for (const delivery of deliveries) {
        if (delivery.state !== "pending") continue;
        const dueAt = Date.parse(delivery.nextAttemptAt);
        if (dueAt > now) {
          nextTry = Math.min(nextTry ?? dueAt, dueAt);
          continue;
        }
        const registration = registrations.find((row) => row.deviceId === delivery.deviceId);
        const settle = (state: "sent" | "dropped", attempts = delivery.attempts + 1) =>
          repo.updateDelivery({
            alertId: alert.alertId,
            deviceId: delivery.deviceId,
            state,
            attempts,
            nextAttemptAt: iso(now),
          });
        if (!registration || registration.registrationId !== delivery.registrationId) {
          yield* settle("dropped", delivery.attempts);
          continue;
        }
        // Checked again right before each send: cancelled, or opened, meanwhile.
        if (!(yield* repo.isPending(alert.alertId))) return;
        if (presence.isViewed(alert.threadId, now)) {
          return yield* repo.finishAlert(alert.alertId, "dropped");
        }
        const text = alertPayload({
          threadTitle: verdict.thread.title,
          reason: verdict.reason,
          detail: alert.detail,
          computerLabel: label,
          navigate: `${registration.appOrigin}/${environmentId}/${alert.threadId}`,
        });
        const outcome: RelayDeviceAlertResult = yield* sealAndSend(registration, text, {
          kind: verdict.kind,
          ttlSeconds: Math.max(0, Math.min(3600, Math.floor((expiresAt - now) / 1000))),
          urgency: verdict.kind === "needs_you" ? "high" : "normal",
          topic: alertTopic(alert.threadId),
          alertKey: alertKey(alert.alertId),
        }).pipe(Effect.orElseSucceed(() => ({ outcome: "retry" as const })));
        if (outcome.outcome === "retry") {
          const attempts = delivery.attempts + 1;
          const retryAt = now + retryDelayMs(attempts, outcome.retryAfterSeconds);
          if (attempts >= MAX_DELIVERY_ATTEMPTS || retryAt >= expiresAt) {
            yield* settle("dropped", attempts);
          } else {
            yield* repo.updateDelivery({
              alertId: alert.alertId,
              deviceId: delivery.deviceId,
              state: "pending",
              attempts,
              nextAttemptAt: iso(retryAt),
            });
            nextTry = Math.min(nextTry ?? retryAt, retryAt);
          }
          continue;
        }
        yield* settle(outcome.outcome === "sent" ? "sent" : "dropped");
      }
      if (nextTry !== null) yield* repo.deferAlert(alert.alertId, iso(nextTry));
      else yield* repo.finishAlert(alert.alertId, "delivered");
    });

  /** One pass over the alerts that are due; true when more are waiting. */
  const sendDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const alerts = yield* repo.dueAlerts(now, ALERT_BATCH);
    if (alerts.length === 0) return false;
    const registrations = yield* activeRegistrations;
    const label = yield* computerLabel;
    for (const alert of alerts) {
      yield* handleAlert(alert, registrations, label, now);
    }
    return alerts.length === ALERT_BATCH;
  });

  const logged =
    (what: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(`push alerts: ${what} failed`, { cause: Cause.pretty(cause) }).pipe(
                Effect.as(false),
              ),
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
        yield* repo.prune(iso(now - KEEP_FINISHED_ALERTS_MS)).pipe(logged("pruning"));
      }
      yield* waitFor(discoveryBell, IDLE_WAKE_MS);
    }
  });

  const senderLoop = Effect.gen(function* () {
    for (;;) {
      const more = yield* sendDue.pipe(logged("sending"));
      if (more) continue;
      const now = yield* Clock.currentTimeMillis;
      const next = yield* repo.nextWakeAt.pipe(Effect.orElseSucceed(() => Option.none<string>()));
      const waitMs = Option.match(next, {
        onNone: () => IDLE_WAKE_MS,
        onSome: (at) => Math.max(250, Math.min(IDLE_WAKE_MS, Date.parse(at) - now)),
      });
      yield* waitFor(senderBell, waitMs);
    }
  });

  const start: PushAlertsShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(engine.streamDomainEvents, () => Queue.offer(discoveryBell, undefined)),
      );
      if (Option.isSome(scheduledTasks)) {
        yield* Effect.forkScoped(
          Stream.runForEach(scheduledTasks.value.changes, onScheduleSnapshot).pipe(
            logged("watching scheduled tasks"),
            Effect.repeat(Schedule.spaced(Duration.seconds(30))),
          ),
        );
      }
      yield* Effect.forkScoped(discoveryLoop);
      yield* Effect.forkScoped(senderLoop);
    });

  return PushAlerts.of({
    register,
    unregister,
    sendTest,
    setViewing: (viewerId, threadId) =>
      Clock.currentTimeMillis.pipe(Effect.map((now) => presence.set(viewerId, threadId, now))),
    releaseViewer: (viewerId) => Effect.sync(() => presence.release(viewerId)),
    start,
  });
});

export const PushAlertsLive = Layer.effect(PushAlerts, make).pipe(
  Layer.provide(PushAlertRepositoryLive),
);
