/**
 * Event tasks' pipeline (docs/design/event-tasks.md, "The pipeline"): events
 * from the relay, from this computer's own port, from "Send a test event"
 * and from "Run with this event" are each stored first (`received`), then
 * processed one task at a time, in the order they arrived, through the
 * checks: the task's state, the signature, the age, who started it, the
 * filters, duplicates and the daily limit. One that passes them all claims a
 * run (ScheduledTaskRepository.claimEventRun) and launches it like any
 * scheduled run, or waits for room. Every event ends logged with a plain
 * reason.
 *
 * A task's queue is drained when an event is stored, when any scheduled run
 * ends, and on every scheduler tick (which also covers a restart), so nothing
 * strands. Made once by ScheduledTasks, which hands it its launch.
 */
import * as Crypto from "node:crypto";

import {
  type ScheduledTaskId,
  type ScheduledTaskListWebhookEventsInput,
  type ScheduledTaskListWebhookEventsResult,
  type ScheduledTaskTestWebhookInput,
  type ScheduledTaskWebhookCadence,
  type ScheduledTaskWebhookEventInput,
  type ThreadId,
  type WebhookEventDetail,
  type WebhookEventRecord,
  type WebhookEventSource,
  type WebhookEventStatus,
  RELAY_HOOK_MAX_BODY_BYTES,
} from "@threadlines/contracts";
import { compileCadence, SCHEDULED_TASK_RUN_CAP } from "@threadlines/shared/scheduledTasks";
import {
  describeWebhookFilter,
  firstFailingFilter,
  GITHUB_WEBHOOK_SIGNATURE,
  githubEventName,
  githubEventSummary,
  githubSender,
  githubSenderVerdict,
  githubSubject,
  isNeverKeptHeader,
  newEventDataTag,
  parseWebhookBody,
  parseWebhookQuery,
  redactCredentials,
  redactHeaders,
  renderWebhookRunMessage,
  sampleGitHubEvent,
  verifyWebhookSignature,
  WEBHOOK_ALWAYS_KEPT_HEADERS,
  webhookDedupeKey,
  type WebhookEventInput,
  webhookTaskFilters,
} from "@threadlines/shared/webhookTasks";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import { type RelayHookOpened, RelayHooks } from "../relay/RelayHooks.ts";
import type { EventTaskHooks } from "./EventTaskHooks.ts";
import {
  EVENT_TASK_RUN_CAP,
  isWorkingRun,
  type ScheduledRunLaunch,
  type ScheduledRunRow,
  ScheduledTaskRepository,
  type ScheduledTaskRepositoryShape,
  type ScheduledTaskRow,
} from "./ScheduledTaskRepository.ts";
import {
  type TaskWebhookRow,
  WEBHOOK_BODY_KEEP_MS,
  WEBHOOK_SEEN_KEEP_MS,
  type WebhookEventRow,
  WebhookTaskRepository,
} from "./WebhookTaskRepository.ts";

/** At most this many of a task's events wait for room; more are skipped. */
export const WEBHOOK_MAX_WAITING = 20;
/** Requests one task takes on this computer's own port in a minute. */
export const LOCAL_HOOK_RATE_PER_MINUTE = 60;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_EVENT_PAGE = 50;
/** Retention runs at most this often (on the scheduler's tick). */
const PRUNE_EVERY_MS = 10 * 60_000;
/** How much of a body the event's detail shows. */
const DETAIL_BODY_CHARS = 16_000;

export const REASON_PAUSED = "The task is paused.";
export const REASON_NOT_EVENT_TASK = "This task doesn't start on events any more.";
export const REASON_GITHUB_CONNECTED = "GitHub connected";
export const REASON_TOO_MANY_WAITING = "Too many events were waiting.";
export const REASON_DRY_RUN = "Test only: nothing was started.";

/** Why a task's runs can't start now, while the event waits. */
const BUSY_REASON = {
  task: `Waiting: ${EVENT_TASK_RUN_CAP} of this task's runs are still working.`,
  computer: `Waiting: ${SCHEDULED_TASK_RUN_CAP} scheduled runs are already working on this computer.`,
} as const;

/** A span of time in words: "3 hours", "1 minute", "2 days". */
export const formatSpan = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
};

/** When today began in `timeZone` (the daily limit's day), as epoch millis. */
const startOfDay = (now: number, timeZone: string): number => {
  const compiled = compileCadence({ kind: "daily", time: { hour: 0, minute: 0 } }, timeZone);
  if (Result.isFailure(compiled) || compiled.success === null) return now - DAY_MS;
  const schedule = compiled.success;
  let start = now - DAY_MS;
  let cursor = new Date(now - DAY_MS - 2 * 60 * 60_000);
  for (let step = 0; step < 4; step += 1) {
    const next = schedule.next(cursor);
    if (Result.isFailure(next) || next.success === null || next.success.getTime() > now) break;
    start = next.success.getTime();
    cursor = next.success;
  }
  return start;
};

const sha256 = (value: string) => Crypto.createHash("sha256").update(value).digest("hex");

const hmac = (secret: string, body: Uint8Array, encoding: "hex" | "base64") =>
  Crypto.createHmac("sha256", secret).update(body).digest(encoding);

/** The headers an event keeps: the always-kept ones and the task's own, never a credential. */
export const keptHeadersOf = (
  headers: Readonly<Record<string, string | undefined>>,
  taskKept: ReadonlyArray<string>,
): Record<string, string> => {
  const wanted = new Set([...WEBHOOK_ALWAYS_KEPT_HEADERS, ...taskKept]);
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || !wanted.has(name) || isNeverKeptHeader(name)) continue;
    out[name] = value.slice(0, 4_096);
  }
  return out;
};

/** An event as the checks read it. */
const eventInput = (event: Pick<WebhookEventRow, "headers" | "query" | "body">) => {
  const parsed = parseWebhookBody(event.headers["content-type"], event.body);
  return {
    headers: event.headers,
    query: parseWebhookQuery(event.query),
    body: parsed.body,
    rawBody: parsed.rawBody,
  } satisfies WebhookEventInput;
};

/** What the log shows about an event before it is processed. */
const describeEvent = (event: Pick<WebhookEventRow, "headers" | "query" | "body">) => {
  const input = eventInput(event);
  const fromGitHub = event.headers["x-github-event"] !== undefined;
  const eventName = fromGitHub ? githubEventName(event.headers, input.body) : null;
  return {
    eventName,
    sender: fromGitHub ? githubSender(input.body).login : null,
    subject: fromGitHub ? (githubSubject(eventName, input.body)?.key ?? null) : null,
    summary: fromGitHub ? githubEventSummary(eventName, input.body) : null,
  };
};

const signatureOf = (cadence: ScheduledTaskWebhookCadence) =>
  cadence.source === "github" ? GITHUB_WEBHOOK_SIGNATURE : (cadence.signature ?? null);

/** Shown as the body in an event's detail: JSON with credentials hidden, or the text. */
const displayBody = (event: WebhookEventRow) => {
  const input = eventInput(event);
  const text =
    typeof input.body === "string"
      ? input.body
      : JSON.stringify(redactCredentials(input.body), null, 2);
  const cut = text.length > DETAIL_BODY_CHARS;
  return {
    body: cut ? text.slice(0, DETAIL_BODY_CHARS) : text,
    bodyTruncated: cut || event.bodyTruncated,
  };
};

class ClaimRaced extends Data.TaggedError("ClaimRaced")<{}> {}

export interface WebhookPipelineDeps {
  readonly hooks: EventTaskHooks;
  /** Launches (or resumes) a claimed run in the background. */
  readonly launchRun: (run: ScheduledRunRow) => Effect.Effect<void>;
  /** What a run of the task launches with, as the task is now. */
  readonly launchOf: (task: ScheduledTaskRow, projectRoot: string | null) => ScheduledRunLaunch;
  readonly takesFinishTool: (launch: ScheduledRunLaunch) => Effect.Effect<boolean>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<
    | {
        readonly projectId: string;
        readonly archivedAt: string | null;
        readonly deletedAt: string | null;
      }
    | undefined
  >;
  readonly projectRoot: (task: ScheduledTaskRow) => Effect.Effect<string | null>;
  /** After a write the clients' snapshot shows. */
  readonly changed: Effect.Effect<void>;
}

/** Where one check left an event. */
type Verdict =
  | {
      readonly kind: "skip";
      readonly reason: string;
      readonly verified?: boolean;
    }
  | {
      readonly kind: "wait";
      readonly reason: string;
      readonly verified: boolean;
      readonly message: string;
      readonly missingFields: ReadonlyArray<string>;
    }
  | {
      readonly kind: "go";
      readonly verified: boolean;
      readonly launch: ScheduledRunLaunch;
      readonly subject: Parameters<ScheduledTaskRepositoryShape["claimEventRun"]>[0]["subject"];
      readonly dedupeHash: string | null;
      readonly missingFields: ReadonlyArray<string>;
    };

type GoVerdict = Extract<Verdict, { readonly kind: "go" }>;

const skip = (reason: string, verified?: boolean): Verdict =>
  verified === undefined ? { kind: "skip", reason } : { kind: "skip", reason, verified };
const go = (verdict: Omit<GoVerdict, "kind">): Verdict => ({ kind: "go", ...verdict });
const waitFor = (verdict: Omit<Extract<Verdict, { readonly kind: "wait" }>, "kind">): Verdict => ({
  kind: "wait",
  ...verdict,
});

export const makeWebhookEvents = (deps: WebhookPipelineDeps) =>
  Effect.gen(function* () {
    const repo = yield* ScheduledTaskRepository;
    const webhooks = yield* WebhookTaskRepository;
    const relay = yield* RelayHooks;
    const { hooks } = deps;

    const nowMillis = Clock.currentTimeMillis;
    const nowIso = Effect.map(nowMillis, (millis) => new Date(millis).toISOString());

    // -------------------------------------------------------------------------
    // Storing
    // -------------------------------------------------------------------------

    const storeEvent = (input: {
      readonly eventId: string;
      readonly taskId: ScheduledTaskId;
      readonly source: WebhookEventSource;
      readonly replayOf: string | null;
      readonly method: string;
      readonly query: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly receivedAt: string;
      readonly verified: boolean | null;
    }) =>
      Effect.gen(function* () {
        const described = describeEvent(input);
        const key = input.source === "replay" ? null : webhookDedupeKey(input.headers);
        return yield* webhooks.insertEvent({
          ...input,
          ...described,
          dedupeHash: key === null ? null : sha256(key),
          now: yield* nowIso,
        });
      });

    // -------------------------------------------------------------------------
    // Checking
    // -------------------------------------------------------------------------

    /**
     * The checks, in order, for one event of `task` (docs/design/event-tasks.md
     * steps 1-8), without writing anything: where it would go, and what its
     * run would be.
     */
    const check = (
      event: WebhookEventRow,
      task: ScheduledTaskRow,
      address: TaskWebhookRow | null,
      now: number,
    ) =>
      Effect.gen(function* () {
        const cadence = task.cadence;
        if (cadence.kind !== "webhook" || address === null) {
          return skip(REASON_NOT_EVENT_TASK);
        }
        if (task.status === "paused") return skip(REASON_PAUSED);
        if (task.status !== "active") {
          return skip(task.error !== null ? `The task stopped: ${task.error}` : REASON_PAUSED);
        }
        const github = cadence.source === "github";
        // 2. The signature, over the exact bytes received.
        let verified = event.verified === true;
        if (!verified) {
          const signature = signatureOf(cadence);
          if (signature === null) {
            verified = true;
          } else {
            const secrets = yield* hooks.secretsFor(task.id, event.receivedAt);
            if (secrets.length === 0) {
              return skip(
                "This task has no signing secret yet, so the signature can't be checked.",
                false,
              );
            }
            const headerValue = event.headers[signature.header.toLowerCase()];
            for (const secret of secrets) {
              const ok = yield* Effect.promise(() =>
                verifyWebhookSignature({ body: event.body, headerValue, secret, signature }),
              );
              if (ok) {
                verified = true;
                break;
              }
            }
            if (!verified) {
              return skip(
                github
                  ? "The signature didn't match. Check the secret in GitHub."
                  : "The signature didn't match. Check the secret in the service that sent it.",
                false,
              );
            }
          }
        }
        if (event.headers["x-github-event"] === "ping") {
          return skip(REASON_GITHUB_CONNECTED, verified);
        }
        // 3. Age.
        const limitMs = Math.max(cadence.maxLateMinutes, 1) * 60_000;
        const lateMs = now - Date.parse(event.receivedAt);
        if (lateMs > limitMs) {
          return skip(
            event.status === "waiting"
              ? `Waited ${formatSpan(lateMs)}, past this task's ${formatSpan(limitMs)} limit.`
              : `Arrived ${formatSpan(lateMs)} late, past this task's ${formatSpan(limitMs)} limit.`,
            verified,
          );
        }
        const input = eventInput(event);
        // 4. Who started it.
        if (github && cadence.github) {
          const verdict = githubSenderVerdict(cadence.github, input.body);
          if (!verdict.ok) return skip(verdict.reason, verified);
        }
        // 5. Filters: the trigger's, then the task's own.
        const filters = webhookTaskFilters(cadence);
        const presetCount = filters.length - cadence.filters.length;
        const failing = firstFailingFilter(filters, input);
        if (failing !== null) {
          const described = describeWebhookFilter(filters[failing]!);
          return skip(
            failing < presetCount
              ? `Not an event this task waits for (${described} didn't match).`
              : `Filter ${failing - presetCount + 1} (${described}) didn't match.`,
            verified,
          );
        }
        // 6. Duplicates.
        if (event.source !== "replay" && event.dedupeHash !== null) {
          const duplicate = yield* webhooks.isDuplicate({
            taskId: task.id,
            keyHash: event.dedupeHash,
            except: event.eventId,
            since: new Date(now - WEBHOOK_SEEN_KEEP_MS).toISOString(),
          });
          if (duplicate) {
            return skip(
              github ? "GitHub sent this event again." : "This event was sent again.",
              verified,
            );
          }
        }
        // 7. The daily limit.
        const today = yield* repo.countEventRunsSince({
          taskId: task.id,
          since: new Date(startOfDay(now, task.timeZone)).toISOString(),
        });
        if (today >= cadence.dailyRunLimit) {
          return skip(`This task already ran ${today} times today, its daily limit.`, verified);
        }
        // The run's message, from the event.
        const base = deps.launchOf(task, yield* deps.projectRoot(task));
        const eventName = github ? githubEventName(event.headers, input.body) : null;
        const rendered = renderWebhookRunMessage({
          taskName: task.name,
          instructions: task.prompt,
          event: input,
          source: cadence.source,
          eventName,
          includeEvent: cadence.includeEvent,
          withFinishTool: yield* deps.takesFinishTool(base),
          tag: newEventDataTag(),
        });
        if (!rendered.ok) return skip(rendered.reason, verified);
        const message = rendered.message.trim();
        const eventSummary = {
          eventId: event.eventId,
          summary: event.summary ?? eventName ?? "A webhook event",
        };
        // 8. Its target: the task's own, or the issue's thread.
        const subjectKey =
          github && cadence.github?.onePerSubject === true && task.target.kind === "new_thread"
            ? event.subject
            : null;
        if (subjectKey === null) {
          return go({
            verified,
            launch: { ...base, prompt: message, event: eventSummary },
            subject: null,
            dedupeHash: event.dedupeHash,
            missingFields: rendered.missingFields,
          });
        }
        const found = yield* webhooks.getSubject({ taskId: task.id, subject: subjectKey });
        const row = Option.getOrNull(found);
        const expected =
          row === null
            ? null
            : {
                threadId: row.threadId,
                reservedByRun: row.reservedByRun,
                updatedAt: row.updatedAt,
              };
        const fresh = go({
          verified,
          launch: { ...base, prompt: message, event: eventSummary },
          subject: { key: subjectKey, projectId: task.projectId, expected, reserve: true },
          dedupeHash: event.dedupeHash,
          missingFields: rendered.missingFields,
        });
        if (row === null || row.projectId !== task.projectId) return fresh;
        let threadId = row.threadId;
        if (threadId === null) {
          // Its first run is still starting the thread: this one waits for it,
          // unless that run ended without one. A thread the run made that the
          // subject never heard of (a restart in between) is the thread.
          const reserving =
            row.reservedByRun === null
              ? Option.none()
              : yield* repo.getRun({ taskId: task.id, slotUtc: row.reservedByRun });
          const made = Option.isSome(reserving) ? reserving.value.threadId : null;
          if (made === null) {
            if (Option.isNone(reserving) || !isWorkingRun(reserving.value)) return fresh;
            const pull = githubSubject(event.eventName, input.body)?.pullRequest === true;
            return waitFor({
              reason: `Waiting for this ${pull ? "pull request" : "issue"}'s first run to start its thread.`,
              verified,
              message,
              missingFields: rendered.missingFields,
            });
          }
          threadId = made;
        }
        const thread = yield* deps.readThread(threadId);
        if (
          thread === undefined ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null ||
          thread.projectId !== task.projectId
        ) {
          return fresh;
        }
        return go({
          verified,
          launch: {
            ...base,
            prompt: message,
            event: eventSummary,
            target: { kind: "thread", threadId },
          },
          subject: { key: subjectKey, projectId: task.projectId, expected, reserve: false },
          dedupeHash: event.dedupeHash,
          missingFields: rendered.missingFields,
        });
      });

    // -------------------------------------------------------------------------
    // Processing
    // -------------------------------------------------------------------------

    const finish = (
      event: WebhookEventRow,
      status: WebhookEventStatus,
      reason: string | null,
      extra: { readonly verified?: boolean; readonly missingFields?: ReadonlyArray<string> } = {},
    ) =>
      Effect.gen(function* () {
        yield* webhooks.updateEvent({
          eventId: event.eventId,
          status,
          reason,
          ...(extra.verified !== undefined ? { verified: extra.verified } : {}),
          ...(extra.missingFields !== undefined ? { missingFields: extra.missingFields } : {}),
          now: yield* nowIso,
        });
      });

    /** An event that can't run yet waits, unless too many already do. */
    const wait = (
      event: WebhookEventRow,
      reason: string,
      verified: boolean,
      missingFields: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const waiting = yield* webhooks.countWaiting({
          taskId: event.taskId,
          except: event.eventId,
        });
        if (event.status !== "waiting" && waiting >= WEBHOOK_MAX_WAITING) {
          return yield* finish(event, "skipped", REASON_TOO_MANY_WAITING, { verified });
        }
        yield* finish(event, "waiting", reason, { verified, missingFields });
      });

    /**
     * One queued event through the checks, to its end or to waiting. Its
     * result says when it waits for room, so the events behind it in the
     * same pass wait too: a place that frees up mid-pass never goes to a
     * later event before an earlier one.
     */
    const processOne = (queued: WebhookEventRow, roomBlocked: string | null) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const now = yield* nowMillis;
          // Read again on every try: a try that lost a race sees what won.
          const current = yield* webhooks.getEvent(queued.eventId);
          if (
            Option.isNone(current) ||
            (current.value.status !== "received" && current.value.status !== "waiting")
          ) {
            return null;
          }
          const event = current.value;
          const found = yield* repo.getTask(event.taskId);
          if (Option.isNone(found)) {
            // Its task is gone: so is the event.
            yield* webhooks.deleteEvent(event.eventId);
            return null;
          }
          const task = found.value;
          const address = Option.getOrNull(yield* webhooks.getTaskWebhook(task.id));
          const verdict = yield* check(event, task, address, now);
          if (verdict.verified === true && event.verified !== true) {
            yield* webhooks.touchLastEvent({ taskId: task.id, at: event.receivedAt });
          }
          if (verdict.kind === "skip") {
            yield* finish(
              event,
              "skipped",
              verdict.reason,
              verdict.verified !== undefined ? { verified: verdict.verified } : {},
            );
            return null;
          }
          if (verdict.kind === "wait") {
            yield* wait(event, verdict.reason, verdict.verified, verdict.missingFields);
            return null;
          }
          if (roomBlocked !== null) {
            yield* wait(event, roomBlocked, verdict.verified, verdict.missingFields);
            return roomBlocked;
          }
          const claimed = yield* repo.claimEventRun({
            taskId: task.id,
            expectedRevision: task.revision,
            eventId: event.eventId,
            receivedAt: event.receivedAt,
            launch: verdict.launch,
            subject: verdict.subject,
            dedupeHash: verdict.dedupeHash,
            missingFields: verdict.missingFields,
            verified: verdict.verified,
            now: new Date(now).toISOString(),
          });
          if (claimed.kind === "changed") continue;
          if (claimed.kind === "busy") {
            const reason = BUSY_REASON[claimed.reason];
            yield* wait(event, reason, verdict.verified, verdict.missingFields);
            return reason;
          }
          yield* deps.launchRun(claimed.run);
          return null;
        }
        return yield* new ClaimRaced();
      });

    /** A task's queue, in arrival order. */
    const processQueue = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const queued = yield* webhooks.listQueued(taskId);
        if (queued.length === 0) return;
        let roomBlocked: string | null = null;
        for (const event of queued) {
          roomBlocked = yield* processOne(event, roomBlocked).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("event tasks: an event couldn't be processed", {
                    taskId,
                    eventId: event.eventId,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(roomBlocked)),
            ),
          );
        }
        yield* deps.changed;
      });

    /** One lane per task: its events are processed by one drain at a time. */
    const lanes = new Map<
      ScheduledTaskId,
      { readonly lock: Semaphore.Semaphore; queued: boolean }
    >();
    const laneOf = (taskId: ScheduledTaskId) => {
      let lane = lanes.get(taskId);
      if (lane === undefined) {
        lane = { lock: Semaphore.makeUnsafe(1), queued: false };
        lanes.set(taskId, lane);
      }
      return lane;
    };

    /** Drains the task's queue now, after any drain already running. */
    const drainTask = (taskId: ScheduledTaskId) => {
      const lane = laneOf(taskId);
      return lane.lock.withPermits(1)(
        Effect.suspend(() => {
          lane.queued = false;
          return processQueue(taskId);
        }),
      );
    };

    /** Drains the task's queue in the background; one waiting drain at most. */
    const wake = (taskId: ScheduledTaskId) =>
      Effect.suspend(() => {
        const lane = laneOf(taskId);
        if (lane.queued) return Effect.void;
        lane.queued = true;
        return drainTask(taskId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("event tasks: a task's events couldn't be drained", {
              taskId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.forkDetach,
          Effect.asVoid,
        );
      });

    /** A place freed up (a run ended): every task with an event waiting tries again. */
    const wakeWaiting = webhooks.tasksWithQueued({ waitingOnly: true }).pipe(
      Effect.flatMap((taskIds) => Effect.forEach(taskIds, wake, { discard: true })),
      Effect.catchCause((cause) =>
        Effect.logWarning("event tasks: couldn't look for waiting events", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    /** Every task's queue, in turn (the scheduler's tick, and so every startup). */
    const drainAll = webhooks.tasksWithQueued({ waitingOnly: false }).pipe(
      Effect.flatMap((taskIds) =>
        Effect.forEach(
          taskIds,
          (taskId) =>
            drainTask(taskId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("event tasks: a task's events couldn't be drained", {
                  taskId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("event tasks: couldn't drain the queue", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    let lastPrune = 0;
    /** Retention, at most every 10 minutes. */
    const prune = Effect.gen(function* () {
      const now = yield* nowMillis;
      if (now - lastPrune < PRUNE_EVERY_MS) return;
      lastPrune = now;
      const forgotten = yield* webhooks.prune(now);
      yield* hooks.dropSecrets(forgotten);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("event tasks: couldn't prune the event log", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    // -------------------------------------------------------------------------
    // Receiving
    // -------------------------------------------------------------------------

    /**
     * Stores one relay delivery and wakes its task's queue. True when it can
     * be acknowledged: stored (or stored already), or for a hook this
     * computer doesn't know. False when storing failed: the relay sends it
     * again.
     */
    const receiveDelivery = (opened: RelayHookOpened) =>
      Effect.gen(function* () {
        const taskId = yield* webhooks.hookTask(opened.hookId);
        if (Option.isNone(taskId)) {
          yield* Effect.logInfo("event tasks: a delivery for an unknown hook was dropped", {
            deliveryId: opened.deliveryId,
          });
          return true;
        }
        const address = Option.getOrNull(yield* webhooks.getTaskWebhook(taskId.value));
        yield* storeEvent({
          eventId: opened.deliveryId,
          taskId: taskId.value,
          source: "relay",
          replayOf: null,
          method: opened.payload.method.toUpperCase(),
          query: opened.payload.query,
          headers: keptHeadersOf(opened.payload.headers, address?.keptHeaders ?? []),
          body: opened.payload.body,
          receivedAt: opened.payload.receivedAt,
          verified: null,
        });
        yield* wake(taskId.value);
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event tasks: a delivery couldn't be stored", {
            deliveryId: opened.deliveryId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );

    /** Requests per task in the last minute, for the local route's limit. */
    const recentLocal = new Map<ScheduledTaskId, Array<number>>();

    /**
     * An event sent to this computer's own port (`POST /api/hooks/{task}/{token}`).
     * The token is the only sign-in, compared in constant time before the
     * body is read; a task takes 60 a minute. 404 for an unknown task or a
     * wrong token alike.
     */
    const receiveLocal = (input: {
      readonly taskId: string;
      readonly token: string;
      readonly method: string;
      readonly query: string;
      readonly headers: Readonly<Record<string, string | undefined>>;
      readonly contentLength: number | null;
      readonly readBody: Effect.Effect<Uint8Array, "too_large">;
    }) =>
      Effect.gen(function* () {
        const rows = yield* webhooks.listTaskWebhooks;
        const address = rows.find((row) => row.taskId === input.taskId);
        if (address === undefined || !timingSafeEqualBase64Url(address.localToken, input.token)) {
          return 404 as const;
        }
        const now = yield* nowMillis;
        const recent = (recentLocal.get(address.taskId) ?? []).filter((at) => now - at < 60_000);
        if (recent.length >= LOCAL_HOOK_RATE_PER_MINUTE) {
          recentLocal.set(address.taskId, recent);
          return 429 as const;
        }
        recent.push(now);
        recentLocal.set(address.taskId, recent);
        if (input.contentLength !== null && input.contentLength > RELAY_HOOK_MAX_BODY_BYTES) {
          return 413 as const;
        }
        const body = yield* input.readBody.pipe(Effect.result);
        if (Result.isFailure(body) || body.success.byteLength > RELAY_HOOK_MAX_BODY_BYTES) {
          return 413 as const;
        }
        yield* storeEvent({
          eventId: crypto.randomUUID(),
          taskId: address.taskId,
          source: "local",
          replayOf: null,
          method: input.method.toUpperCase(),
          query: input.query,
          headers: keptHeadersOf(input.headers, address.keptHeaders),
          body: body.success,
          receivedAt: new Date(now).toISOString(),
          verified: null,
        });
        yield* wake(address.taskId);
        return 202 as const;
      });

    // -------------------------------------------------------------------------
    // Reading the log
    // -------------------------------------------------------------------------

    const recordOf = (event: WebhookEventRow, now: number): WebhookEventRecord => ({
      eventId: event.eventId,
      taskId: event.taskId,
      receivedAt: event.receivedAt,
      source: event.source,
      status: event.status,
      reason: event.reason,
      summary: event.summary,
      eventName: event.eventName,
      sender: event.sender,
      threadId: event.threadId,
      canReplay:
        event.verified === true &&
        !event.bodyTruncated &&
        event.status !== "received" &&
        event.status !== "waiting" &&
        event.reason !== REASON_GITHUB_CONNECTED &&
        now - Date.parse(event.receivedAt) < WEBHOOK_BODY_KEEP_MS,
    });

    const listEvents = (input: ScheduledTaskListWebhookEventsInput) =>
      Effect.gen(function* () {
        const limit = Math.min(input.limit ?? DEFAULT_EVENT_PAGE, 200);
        const rows = yield* webhooks.listEvents({
          taskId: input.id,
          before: input.before,
          limit: limit + 1,
        });
        const now = yield* nowMillis;
        return {
          events: rows.slice(0, limit).map((row) => recordOf(row, now)),
          hasMore: rows.length > limit,
        } satisfies ScheduledTaskListWebhookEventsResult;
      });

    /** The message an event's run was sent, while its run is recorded. */
    const runMessage = (event: WebhookEventRow) =>
      event.runSlotUtc === null
        ? Effect.succeed(null)
        : repo
            .getRun({ taskId: event.taskId, slotUtc: event.runSlotUtc })
            .pipe(
              Effect.map((run) =>
                Option.isSome(run) && run.value.launch !== null ? run.value.launch.prompt : null,
              ),
            );

    const detailOf = (event: WebhookEventRow, message: string | null, now: number) =>
      ({
        event: recordOf(event, now),
        headers: redactHeaders(event.headers),
        ...displayBody(event),
        message,
        missingFields: [...event.missingFields],
      }) satisfies WebhookEventDetail;

    const eventDetail = (input: ScheduledTaskWebhookEventInput) =>
      Effect.gen(function* () {
        const found = yield* webhooks.getEvent(input.eventId);
        if (Option.isNone(found) || found.value.taskId !== input.id) return null;
        return detailOf(found.value, yield* runMessage(found.value), yield* nowMillis);
      });

    // -------------------------------------------------------------------------
    // Test events and replays
    // -------------------------------------------------------------------------

    /** A sample event for the task, signed with its newest secret so it passes that check. */
    const sampleEvent = (task: ScheduledTaskRow, cadence: ScheduledTaskWebhookCadence) =>
      Effect.gen(function* () {
        let headers: Record<string, string>;
        let body: Uint8Array;
        if (cadence.source === "github" && cadence.github) {
          const trigger = cadence.github;
          const login =
            (yield* hooks.githubLogin((yield* deps.projectRoot(task)) ?? process.cwd())) ??
            (trigger.from.kind === "people" ? trigger.from.logins[0] : undefined) ??
            "octocat";
          const sample = sampleGitHubEvent(trigger, login);
          headers = sample.headers;
          body = new TextEncoder().encode(JSON.stringify(sample.body));
        } else {
          headers = {
            "content-type": "application/json",
            "idempotency-key": `test-${crypto.randomUUID()}`,
            "user-agent": "Threadlines test event",
          };
          body = new TextEncoder().encode(
            JSON.stringify({ test: true, message: "A test event from Threadlines." }, null, 2),
          );
        }
        const signature = signatureOf(cadence);
        const secret = signature === null ? null : yield* hooks.currentSecret(task.id);
        if (signature !== null && secret !== null) {
          headers[signature.header.toLowerCase()] =
            `${signature.prefix}${hmac(secret.secret, body, signature.encoding)}`;
        }
        return { headers, body };
      });

    /** The event task, or why there is none. */
    const eventTask = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const found = yield* repo.getTask(taskId);
        if (Option.isNone(found)) return { refusal: "That task was deleted." } as const;
        const task = found.value;
        if (task.cadence.kind !== "webhook") {
          return { refusal: "This task doesn't start on events." } as const;
        }
        return { task, cadence: task.cadence } as const;
      });

    /**
     * "Send a test event": a sample through every check. A dry run starts
     * nothing and is not logged: it says where the event would go
     * (`ran`/`joined`/`waiting` with "Test only", or `skipped` with why) and
     * the message the agent would get. With `startRun` it goes through the
     * queue like any event, and may start a run.
     */
    const testEvent = (input: ScheduledTaskTestWebhookInput) =>
      Effect.gen(function* () {
        const found = yield* eventTask(input.id);
        if ("refusal" in found) return { refusal: found.refusal } as const;
        const { task, cadence } = found;
        const sample = yield* sampleEvent(task, cadence);
        const now = yield* nowMillis;
        const receivedAt = new Date(now).toISOString();
        const eventId = crypto.randomUUID();
        if (input.startRun) {
          yield* storeEvent({
            eventId,
            taskId: task.id,
            source: "test",
            replayOf: null,
            method: "POST",
            query: "",
            headers: sample.headers,
            body: sample.body,
            receivedAt,
            verified: null,
          });
          yield* drainTask(task.id);
          const stored = yield* webhooks.getEvent(eventId);
          if (Option.isNone(stored)) return { refusal: "That task was deleted." } as const;
          return {
            detail: detailOf(stored.value, yield* runMessage(stored.value), yield* nowMillis),
          } as const;
        }
        const event: WebhookEventRow = {
          eventId: `test-${eventId}`,
          taskId: task.id,
          receivedAt,
          source: "test",
          replayOf: null,
          method: "POST",
          query: "",
          headers: sample.headers,
          body: sample.body,
          bodyTruncated: false,
          status: "received",
          reason: null,
          verified: null,
          ...describeEvent({ headers: sample.headers, query: "", body: sample.body }),
          dedupeHash: null,
          missingFields: [],
          runSlotUtc: null,
          threadId: null,
          createdAt: receivedAt,
          updatedAt: receivedAt,
        };
        const address = Option.getOrNull(yield* webhooks.getTaskWebhook(task.id));
        const verdict = yield* check(event, task, address, now);
        let status: WebhookEventStatus;
        let reason: string;
        let message: string | null = null;
        let missingFields: ReadonlyArray<string> = [];
        if (verdict.kind === "skip") {
          status = "skipped";
          reason = verdict.reason;
        } else {
          missingFields = verdict.missingFields;
          message = verdict.kind === "go" ? verdict.launch.prompt : verdict.message;
          if (verdict.kind === "wait") {
            status = "waiting";
            reason = `${REASON_DRY_RUN} ${verdict.reason}`;
          } else {
            const working = yield* repo.listWorkingRuns;
            const busy =
              working.filter((run) => run.taskId === task.id).length >= EVENT_TASK_RUN_CAP
                ? BUSY_REASON.task
                : working.length >= SCHEDULED_TASK_RUN_CAP
                  ? BUSY_REASON.computer
                  : null;
            status =
              busy !== null
                ? "waiting"
                : verdict.launch.target.kind === "thread"
                  ? "joined"
                  : "ran";
            reason = busy === null ? REASON_DRY_RUN : `${REASON_DRY_RUN} ${busy}`;
          }
        }
        return {
          detail: detailOf(
            {
              ...event,
              status,
              reason,
              verified: verdict.kind === "skip" ? (verdict.verified ?? null) : verdict.verified,
              missingFields,
            },
            message,
            now,
          ),
        } as const;
      });

    /** "Run with this event": the event again as a new one, past the signature and duplicate checks. */
    const replayEvent = (input: ScheduledTaskWebhookEventInput) =>
      Effect.gen(function* () {
        const found = yield* eventTask(input.id);
        if ("refusal" in found) return { refusal: found.refusal } as const;
        const original = yield* webhooks.getEvent(input.eventId);
        const now = yield* nowMillis;
        if (Option.isNone(original) || original.value.taskId !== input.id) {
          return { refusal: "That event is no longer in the log." } as const;
        }
        if (!recordOf(original.value, now).canReplay) {
          return {
            refusal:
              original.value.verified !== true
                ? "Only an event whose signature passed can be run again."
                : "That event can't be run again any more.",
          } as const;
        }
        const eventId = crypto.randomUUID();
        yield* storeEvent({
          eventId,
          taskId: input.id,
          source: "replay",
          replayOf: original.value.eventId,
          method: original.value.method,
          query: original.value.query,
          headers: original.value.headers,
          body: original.value.body,
          receivedAt: new Date(now).toISOString(),
          verified: true,
        });
        yield* drainTask(input.id);
        const stored = yield* webhooks.getEvent(eventId);
        if (Option.isNone(stored)) return { refusal: "That task was deleted." } as const;
        return { record: recordOf(stored.value, yield* nowMillis) } as const;
      });

    /** Relay deliveries: stored, then acknowledged together at most once a second. */
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.forkScoped(
        relay.deliveries.pipe(
          Stream.mapEffect((opened) =>
            receiveDelivery(opened).pipe(
              Effect.map((stored) => (stored ? [opened.deliveryId] : [])),
            ),
          ),
          Stream.flattenIterable,
          Stream.groupedWithin(100, "1 second"),
          Stream.runForEach((deliveryIds) => relay.ack(deliveryIds)),
        ),
      ).pipe(Effect.asVoid);

    return {
      receiveDelivery,
      receiveLocal,
      wake,
      wakeWaiting,
      drainAll,
      drainTask,
      prune,
      listEvents,
      eventDetail,
      testEvent,
      replayEvent,
      start,
    };
  });

export type WebhookEvents = Effect.Success<ReturnType<typeof makeWebhookEvents>>;
