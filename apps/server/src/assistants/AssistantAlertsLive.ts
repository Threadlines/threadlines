/**
 * Sends assistants' alerts to web addresses (AssistantAlerts.ts). One loop
 * wakes when the record records an event, when a target changes and when a
 * retry comes due. For each target that's on, under the target's lock (which
 * Edit, Turn off and Remove take too):
 *
 * 1. Every recorded event of its kinds and projects past where it looked
 *    gets a pending delivery row.
 * 2. Due rows go out oldest first, one at a time. Right before each, the
 *    event is read again: a needs-you that no longer needs the user (judged
 *    live, as phones are), or any event on a thread someone is looking at
 *    (with "Skip threads I'm looking at"), is dropped. The attempt is
 *    written before the call, so one cut off by a crash is never repeated.
 * 3. The answer settles the row, and the target's watermark moves with it.
 *
 * Tried again (`retryDelayMs`, `Retry-After` honored, at most 6 attempts and
 * 24 hours from when it was queued): a call that plainly never arrived, and
 * answers 401, 403, 408, 425, 429 and 5xx. 410 turns the target off for good
 * (`gone`). Anything else, and a call that may have arrived, ends it.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { randomBytes, randomUUID } from "node:crypto";

import {
  type AssistantAlertKind,
  type AssistantAlertTarget,
  AssistantAlertTargetId,
  type AssistantAlertTargetTestResult,
  OutsideAgentError,
  type ProjectId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  type OutboundAddressError,
  type OutboundResult,
  postOutbound,
  resolveOutbound,
} from "../net/outboundHttps.ts";
import { READ_RETRY_MS } from "../pushAlerts/alertChecks.ts";
import { PushAlerts } from "../pushAlerts/PushAlerts.ts";
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from "../pushAlerts/pushAlertRules.ts";
import {
  type AlertDeliveryRow,
  AssistantAlertRepository,
  AssistantAlertRepositoryLive,
  type AlertTargetRow,
  type DeliveryOutcome,
  type TargetNote,
} from "./AssistantAlertRepository.ts";
import { AssistantAlerts, type AssistantAlertsShape } from "./AssistantAlerts.ts";
import {
  type AssistantEvent,
  type AssistantEventName,
  assistantEventNameOf,
  AssistantEvents,
  encodeEventCursor,
} from "./AssistantEvents.ts";
import { hostedAppOrigin, hostedThreadLink } from "./hostedAppLinks.ts";
import { formatWebhookSecret, WEBHOOK_SECRET_BYTES, webhookHeaders } from "./webhookSigning.ts";

/** How alerts leave the computer: the network rules (outboundHttps.ts); tests give their own. */
export interface AlertTransport {
  /** Checks an address as it is saved: its form, and that it resolves to public addresses. */
  readonly check: (url: string) => Effect.Effect<URL, OutboundAddressError>;
  readonly post: (input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }) => Effect.Effect<OutboundResult>;
}

export const outboundTransport: AlertTransport = {
  check: (url) => resolveOutbound(url).pipe(Effect.map((resolved) => resolved.url)),
  post: postOutbound,
};

/** Addresses per computer. */
const MAX_TARGETS = 10;
/** A delivery is tried for this long after it was queued. */
const DELIVERY_LIFETIME_MS = 24 * 60 * 60_000;
/** Final deliveries are forgotten after this (the record keeps events as long). */
const KEEP_DELIVERIES_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
/** Events queued per read of the record. */
const QUEUE_PAGE = 100;
/** Deliveries looked at per read. */
const SEND_BATCH = 20;
/** Targets sent to at once. */
const TARGET_CONCURRENCY = 4;
const IDLE_WAKE_MS = 30_000;
const AUTHORIZATION_MAX_LENGTH = 4096;

const KIND_ORDER: ReadonlyArray<AssistantAlertKind> = ["needs_you", "finished", "failed"];
const KIND_OF_NAME: Record<AssistantEventName, AssistantAlertKind> = {
  "thread.needs_you": "needs_you",
  "thread.finished": "finished",
  "thread.failed": "failed",
};

const signingSecretName = (targetId: string) => `assistant-alert-${targetId}-signing`;
const authorizationName = (targetId: string) => `assistant-alert-${targetId}-authorization`;

const iso = (ms: number) => new Date(ms).toISOString();
const failure = (detail: string) => new OutsideAgentError({ detail });
const NO_NOTE: TargetNote = { type: "none" };

/** What an answer from the receiver means for the delivery. */
type AnswerVerdict =
  | { readonly type: "sent" }
  | { readonly type: "gone" }
  | { readonly type: "retry"; readonly detail: string; readonly refused: boolean }
  | { readonly type: "failed"; readonly detail: string };

export const answerVerdict = (status: number): AnswerVerdict => {
  if (status >= 200 && status < 300) return { type: "sent" };
  if (status === 410) return { type: "gone" };
  if (status === 401 || status === 403) {
    return {
      type: "retry",
      detail: `The receiver refused the alert (${status}). Check the Authorization header.`,
      refused: true,
    };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { type: "retry", detail: `The receiver answered ${status}.`, refused: false };
  }
  if (status === 413) {
    return { type: "failed", detail: "The receiver said the alert is too large (413)." };
  }
  if (status >= 300 && status < 400) {
    return {
      type: "failed",
      detail: `The receiver answered with a redirect (${status}). Threadlines doesn't follow redirects: use the address it points to.`,
    };
  }
  return { type: "failed", detail: `The receiver turned the alert down (${status}).` };
};

/** An Authorization value that can go in a header as typed. */
const checkAuthorization = (value: string) =>
  value.length > AUTHORIZATION_MAX_LENGTH
    ? Effect.fail(failure("That Authorization value is too long."))
    : /[^\t\x20-\x7e]/u.test(value)
      ? Effect.fail(
          failure("The Authorization value can only have plain letters, numbers and symbols."),
        )
      : Effect.succeed(value);

const toContract = (row: AlertTargetRow): AssistantAlertTarget | null =>
  row.state === "deleting"
    ? null
    : {
        targetId: row.targetId,
        url: row.url,
        kinds: row.names.map((name) => KIND_OF_NAME[name]),
        projectIds: row.projectIds,
        skipViewed: row.skipViewed,
        state: row.state,
        hasAuthorization: row.hasAuthorization,
        refusedSince: row.refusedSince,
        lastSentAt: row.lastSentAt,
        lastError: row.lastError?.trim() || null,
        retrying: row.retrying,
        createdAt: row.createdAt,
      };

const make = (transport: AlertTransport) =>
  Effect.gen(function* () {
    const repo = yield* AssistantAlertRepository;
    const record = yield* AssistantEvents;
    const pushAlerts = yield* Effect.serviceOption(PushAlerts);
    const secrets = yield* ServerSecretStore;
    const environment = yield* ServerEnvironment;
    const appOrigin = hostedAppOrigin(packageJson.version);
    const changed = yield* PubSub.sliding<void>(1);
    const bell = yield* Queue.sliding<void>(1);
    /** One per target: sends, Edit, Turn off and Remove take it. */
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (targetId: string) => {
      const existing = locks.get(targetId);
      if (existing !== undefined) return existing;
      const made = Semaphore.makeUnsafe(1);
      locks.set(targetId, made);
      return made;
    };

    const notify = PubSub.publish(changed, undefined).pipe(
      Effect.andThen(Queue.offer(bell, undefined)),
      Effect.asVoid,
    );
    const stored =
      (what: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.mapError(() => failure(`Threadlines couldn't ${what}. Try again.`)));

    const isViewed = (threadId: AssistantEvent["threadId"]) =>
      Option.isSome(pushAlerts) ? pushAlerts.value.isViewed(threadId) : Effect.succeed(false);

    const removeSecrets = (targetId: string) =>
      Effect.all([
        secrets.remove(signingSecretName(targetId)),
        secrets.remove(authorizationName(targetId)),
      ]).pipe(Effect.asVoid);

    // ----- the list Settings shows ----------------------------------------------

    const list = repo.list.pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const target = toContract(row);
          return target === null ? [] : [target];
        }),
      ),
      stored("read the alert addresses"),
    );

    // Subscribes before the first read, so a change can't fall between the two.
    const targets: AssistantAlertsShape["targets"] = Stream.unwrap(
      Effect.map(PubSub.subscribe(changed), (subscription) =>
        Stream.concat(Stream.make(undefined), Stream.fromSubscription(subscription)).pipe(
          Stream.mapEffect(() => list),
        ),
      ),
    );

    // ----- managing targets -------------------------------------------------------

    /** The fields Add and Edit share, checked; the address must resolve to public addresses. */
    const checkFields = (input: {
      readonly url: string;
      readonly kinds: ReadonlyArray<AssistantAlertKind>;
      readonly projectIds: ReadonlyArray<ProjectId> | null;
    }) =>
      Effect.gen(function* () {
        const kinds = KIND_ORDER.filter((kind) => input.kinds.includes(kind));
        if (kinds.length === 0)
          return yield* Effect.fail(failure("Pick at least one kind of alert."));
        if (input.projectIds !== null && input.projectIds.length === 0) {
          return yield* Effect.fail(failure("Pick at least one project, or every project."));
        }
        const url = yield* transport
          .check(input.url)
          .pipe(Effect.mapError((error) => failure(error.message)));
        return {
          url: url.href,
          names: kinds.map(assistantEventNameOf),
          projectIds: input.projectIds === null ? null : [...new Set(input.projectIds)],
        };
      });

    /** Runs `use` with the target under its lock; refused once it's gone. */
    const withTarget = <A>(
      targetId: AssistantAlertTargetId,
      use: (row: AlertTargetRow) => Effect.Effect<A, OutsideAgentError>,
    ) =>
      Effect.gen(function* () {
        const found = yield* repo.get(targetId).pipe(stored("read the address"));
        if (Option.isNone(found) || found.value.state === "deleting") {
          return yield* Effect.fail(failure("That address was removed."));
        }
        return yield* use(found.value);
      }).pipe(lockOf(targetId).withPermits(1));

    const create: AssistantAlertsShape["create"] = (input) =>
      Effect.gen(function* () {
        const fields = yield* checkFields(input);
        const authorization =
          input.authorization === null ? null : yield* checkAuthorization(input.authorization);
        const existing = yield* repo.list.pipe(stored("read the alert addresses"));
        if (existing.filter((row) => row.state !== "deleting").length >= MAX_TARGETS) {
          return yield* Effect.fail(
            failure(`Threadlines sends alerts to at most ${MAX_TARGETS} addresses.`),
          );
        }
        const targetId = AssistantAlertTargetId.make(randomUUID());
        const now = iso(yield* Clock.currentTimeMillis);
        // Secrets first: a target never stands without its signing secret.
        yield* Effect.gen(function* () {
          yield* secrets.set(signingSecretName(targetId), randomBytes(WEBHOOK_SECRET_BYTES));
          if (authorization !== null) {
            yield* secrets.set(authorizationName(targetId), Buffer.from(authorization, "utf8"));
          }
          // On from now: the record starts if it was off, and the target's
          // watermark is its last `seq`, so no history is sent.
          yield* record.keep((position) =>
            repo.insert({
              targetId,
              ...fields,
              skipViewed: input.skipViewed,
              hasAuthorization: authorization !== null,
              startSeq: position.lastSeq,
              now,
            }),
          );
        }).pipe(
          Effect.onError(() => removeSecrets(targetId).pipe(Effect.ignore)),
          stored("save the address"),
        );
        yield* notify;
        return { targetId };
      });

    const update: AssistantAlertsShape["update"] = (input) =>
      Effect.gen(function* () {
        const fields = yield* checkFields(input);
        const authorization =
          input.authorization.kind === "set"
            ? yield* checkAuthorization(input.authorization.value)
            : null;
        yield* withTarget(input.targetId, (row) =>
          Effect.gen(function* () {
            const now = iso(yield* Clock.currentTimeMillis);
            if (input.authorization.kind === "set" && authorization !== null) {
              yield* secrets
                .set(authorizationName(row.targetId), Buffer.from(authorization, "utf8"))
                .pipe(stored("save the Authorization value"));
            } else if (input.authorization.kind === "clear") {
              yield* secrets
                .remove(authorizationName(row.targetId))
                .pipe(stored("clear the Authorization value"));
            }
            const credentialsChanged = input.authorization.kind !== "keep";
            yield* repo
              .update({
                targetId: row.targetId,
                ...fields,
                skipViewed: input.skipViewed,
                ...(credentialsChanged
                  ? { hasAuthorization: input.authorization.kind === "set" }
                  : {}),
                newCredentials: credentialsChanged || fields.url !== row.url,
                now,
              })
              .pipe(stored("save the address"));
          }),
        );
        yield* notify;
      });

    const setOn: AssistantAlertsShape["setOn"] = (input) =>
      withTarget(input.targetId, (row) =>
        Effect.gen(function* () {
          const now = iso(yield* Clock.currentTimeMillis);
          if (input.on) {
            if (row.state === "on") return;
            // From now: what it missed while off is never sent.
            yield* record.keep((position) =>
              repo.setState({
                targetId: row.targetId,
                state: "on",
                startSeq: position.lastSeq,
                now,
              }),
            );
          } else if (row.state !== "off") {
            yield* repo.setState({ targetId: row.targetId, state: "off", now });
          }
        }).pipe(stored(input.on ? "turn the address on" : "turn the address off")),
      ).pipe(Effect.andThen(notify));

    /** Remove's steps, in an order a restart can finish: marked, secrets gone, rows gone. */
    const finishRemoving = (targetId: AssistantAlertTargetId) =>
      Effect.gen(function* () {
        const now = iso(yield* Clock.currentTimeMillis);
        yield* repo.setState({ targetId, state: "deleting", now });
        yield* removeSecrets(targetId);
        yield* repo.delete(targetId);
      });

    const remove: AssistantAlertsShape["remove"] = (input) =>
      withTarget(input.targetId, (row) =>
        finishRemoving(row.targetId).pipe(stored("remove the address")),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            locks.delete(input.targetId);
          }),
        ),
        Effect.andThen(notify),
      );

    const secret: AssistantAlertsShape["secret"] = (input) =>
      Effect.gen(function* () {
        const found = yield* repo.get(input.targetId).pipe(stored("read the address"));
        if (Option.isNone(found) || found.value.state === "deleting") {
          return yield* Effect.fail(failure("That address was removed."));
        }
        const bytes = yield* secrets
          .get(signingSecretName(input.targetId))
          .pipe(stored("read the signing secret"));
        if (bytes === null) {
          return yield* Effect.fail(
            failure("This address's signing secret is missing. Remove it and add it again."),
          );
        }
        return { secret: formatWebhookSecret(bytes) };
      });

    // ----- what goes out ----------------------------------------------------------

    const cursorAt = (watermark: number) =>
      record.position.pipe(
        Effect.map((position) => encodeEventCursor(position.recordId, watermark)),
      );

    const computerLabel = environment.getDescriptor.pipe(
      Effect.map((descriptor) => descriptor.label),
    );

    /**
     * An event as it goes out: `{ eventId, name, timestamp, data, cursor }`.
     * `data` carries only what Threadlines or the user wrote (no title and
     * no agent text: the body is the receiver's run input). `cursor` is the
     * target's watermark, so `inbox(since: cursor)` catches up.
     */
    const envelopeOf = (event: AssistantEvent, project: string | null, watermark: number) =>
      Effect.gen(function* () {
        const environmentId = yield* environment.getEnvironmentId;
        return {
          eventId: event.eventId,
          name: event.name,
          timestamp: event.recordedAt,
          data: {
            kind: KIND_OF_NAME[event.name],
            reason: event.reason,
            threadId: event.threadId,
            projectId: event.projectId,
            project,
            computer: yield* computerLabel,
            link: hostedThreadLink({ origin: appOrigin, environmentId, threadId: event.threadId }),
            at: event.occurredAt,
          },
          cursor: yield* cursorAt(watermark),
        };
      });

    /** The headers for one call: signed now, plus the Authorization the user set. */
    const headersFor = (row: AlertTargetRow, id: string, body: string) =>
      Effect.gen(function* () {
        const signing = yield* secrets.get(signingSecretName(row.targetId));
        if (signing === null) return null;
        const authorization = row.hasAuthorization
          ? yield* secrets.get(authorizationName(row.targetId))
          : null;
        if (row.hasAuthorization && authorization === null) return null;
        const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        return {
          ...webhookHeaders({ secret: signing, id, timestamp, body }),
          ...(authorization !== null
            ? { authorization: Buffer.from(authorization).toString("utf8") }
            : {}),
        };
      });

    const LOST_ANSWER =
      "Threadlines lost track of how an alert went. It may have arrived, so it wasn't sent again.";
    const MISSING_SECRETS =
      "This address's signing secret or Authorization value is missing, so nothing is sent. Remove it and add it again.";

    // ----- sending ----------------------------------------------------------------

    /** Queues every matching event past where the target looked. */
    const queueFor = (row: AlertTargetRow) =>
      Effect.gen(function* () {
        let after = row.scannedSeq;
        for (;;) {
          const page = yield* record.since({
            after,
            limit: QUEUE_PAGE,
            names: row.names,
            ...(row.projectIds !== null ? { projectIds: row.projectIds } : {}),
          });
          if (page.upTo === after && page.events.length === 0) return;
          yield* repo.queue({
            targetId: row.targetId,
            events: page.events.map((event) => ({ seq: event.seq, eventId: event.eventId })),
            scannedSeq: page.upTo,
            now: iso(yield* Clock.currentTimeMillis),
          });
          if (!page.more) return;
          after = page.upTo;
        }
      });

    /** One delivery, start to answer; "gone" when the receiver turned the target off. */
    const deliver = (row: AlertTargetRow, delivery: AlertDeliveryRow) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const settle = (outcome: DeliveryOutcome, note: TargetNote = NO_NOTE) =>
          repo.settle({ targetId: row.targetId, seq: delivery.seq, outcome, note });
        const error = (detail: string, refused = false): TargetNote => ({
          type: "error",
          detail,
          refused,
          at: iso(now),
        });
        const expiresAt = Date.parse(delivery.queuedAt) + DELIVERY_LIFETIME_MS;
        if (now >= expiresAt) {
          yield* settle(
            { state: "failed" },
            error("An alert couldn't get through for 24 hours, so Threadlines stopped trying."),
          );
          return "done" as const;
        }
        const current = yield* record.current(delivery.seq);
        // Pruned, or no longer needs the user: nothing to say.
        if (current === null || current.stands === false) {
          yield* settle({ state: "dropped" });
          return "done" as const;
        }
        // Its thread couldn't be read: look again soon, without spending an attempt.
        if (current.stands === "unknown") {
          yield* settle({ state: "pending", nextAttemptAt: iso(now + READ_RETRY_MS) });
          return "done" as const;
        }
        if (row.skipViewed && (yield* isViewed(current.event.threadId))) {
          yield* settle({ state: "dropped" });
          return "done" as const;
        }
        const body = JSON.stringify(
          yield* envelopeOf(current.event, current.project, row.watermark),
        );
        const headers = yield* headersFor(row, current.event.eventId, body);
        if (headers === null) {
          yield* settle({ state: "failed" }, error(MISSING_SECRETS));
          return "done" as const;
        }
        yield* repo.beginAttempt({ targetId: row.targetId, seq: delivery.seq, now: iso(now) });
        const result = yield* transport.post({ url: row.url, headers, body });
        const answeredAt = yield* Clock.currentTimeMillis;
        const attempts = delivery.attempts + 1;
        const retry = (note: TargetNote, retryAfterSeconds?: number) => {
          const retryAt = answeredAt + retryDelayMs(attempts, retryAfterSeconds);
          return attempts >= MAX_DELIVERY_ATTEMPTS || retryAt >= expiresAt
            ? settle({ state: "failed" }, note)
            : settle({ state: "pending", nextAttemptAt: iso(retryAt) }, note);
        };
        switch (result.type) {
          case "not_sent":
            yield* retry(error(result.detail));
            return "done" as const;
          case "unknown":
            yield* settle(
              { state: "failed" },
              error(`${result.detail} It may have arrived, so Threadlines didn't send it again.`),
            );
            return "done" as const;
          case "answered": {
            const verdict = answerVerdict(result.status);
            switch (verdict.type) {
              case "sent":
                yield* settle({ state: "sent" }, { type: "sent", at: iso(answeredAt) });
                return "done" as const;
              case "gone":
                yield* settle({ state: "dropped" });
                yield* repo.setState({
                  targetId: row.targetId,
                  state: "gone",
                  now: iso(answeredAt),
                });
                return "gone" as const;
              case "retry":
                yield* retry(error(verdict.detail, verdict.refused), result.retryAfterSeconds);
                return "done" as const;
              case "failed":
                yield* settle({ state: "failed" }, error(verdict.detail));
                return "done" as const;
            }
          }
        }
      });

    /** Queues and sends for one target under its lock; true when anything moved. */
    const handleTarget = (targetId: AssistantAlertTargetId) =>
      Effect.gen(function* () {
        const before = yield* repo.get(targetId);
        if (Option.isNone(before) || before.value.state !== "on") return false;
        // Under the lock nothing is mid-call: a row still in flight lost its answer (a failed write).
        yield* repo.failInFlight({
          targetId,
          detail: LOST_ANSWER,
          now: iso(yield* Clock.currentTimeMillis),
        });
        yield* queueFor(before.value);
        let moved = false;
        for (;;) {
          const found = yield* repo.get(targetId);
          if (Option.isNone(found) || found.value.state !== "on") return moved;
          const now = yield* Clock.currentTimeMillis;
          const due = yield* repo.due({ targetId, now: iso(now), limit: SEND_BATCH });
          for (const delivery of due) {
            moved = true;
            if ((yield* deliver(found.value, delivery)) === "gone") return true;
          }
          if (due.length < SEND_BATCH) return moved;
        }
      }).pipe(lockOf(targetId).withPermits(1));

    const logged =
      (what: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning(`assistant alerts: ${what} failed`, {
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
          ),
        );

    const sendPass = Effect.gen(function* () {
      const rows = yield* repo.list;
      const moved = yield* Effect.forEach(
        rows.filter((row) => row.state === "on"),
        (row) => handleTarget(row.targetId).pipe(logged("sending")),
        { concurrency: TARGET_CONCURRENCY },
      );
      if (moved.some(Boolean)) yield* PubSub.publish(changed, undefined);
    });

    const loop = Effect.gen(function* () {
      let lastPrune = 0;
      for (;;) {
        yield* sendPass.pipe(logged("a pass"));
        const now = yield* Clock.currentTimeMillis;
        if (now - lastPrune >= PRUNE_EVERY_MS) {
          lastPrune = now;
          yield* repo.prune(iso(now - KEEP_DELIVERIES_MS)).pipe(logged("pruning"));
        }
        const next = yield* repo.nextDueAt.pipe(Effect.orElseSucceed(() => Option.none<string>()));
        const waitMs = Option.match(next, {
          onNone: () => IDLE_WAKE_MS,
          onSome: (at) => Math.max(250, Math.min(IDLE_WAKE_MS, Date.parse(at) - now)),
        });
        yield* Queue.take(bell).pipe(Effect.timeoutOption(Duration.millis(waitMs)));
      }
    });

    // ----- a test send ------------------------------------------------------------

    const test: AssistantAlertsShape["test"] = (input) =>
      withTarget(input.targetId, (row) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const id = `test_${randomUUID()}`;
          const body = JSON.stringify({
            eventId: id,
            name: "threadlines.test",
            timestamp: iso(now),
            data: { computer: yield* computerLabel, at: iso(now) },
            cursor: yield* cursorAt(row.watermark).pipe(stored("read the event record")),
          });
          const headers = yield* headersFor(row, id, body).pipe(
            stored("read the address's secrets"),
          );
          if (headers === null) {
            return { outcome: "failed", status: null, detail: MISSING_SECRETS } as const;
          }
          const result = yield* transport.post({ url: row.url, headers, body });
          const answeredAt = iso(yield* Clock.currentTimeMillis);
          if (result.type !== "answered") {
            return { outcome: "failed", status: null, detail: result.detail } as const;
          }
          const verdict = answerVerdict(result.status);
          const outcome: AssistantAlertTargetTestResult =
            verdict.type === "sent"
              ? {
                  outcome: "sent",
                  status: result.status,
                  detail: `The receiver answered ${result.status}.`,
                }
              : verdict.type === "retry" && verdict.refused
                ? { outcome: "refused", status: result.status, detail: verdict.detail }
                : verdict.type === "gone"
                  ? {
                      outcome: "failed",
                      status: result.status,
                      detail:
                        "The receiver answered 410: it no longer takes alerts at this address.",
                    }
                  : { outcome: "failed", status: result.status, detail: verdict.detail };
          // A test that got through clears the receiver's refusals and the last problem.
          if (verdict.type === "sent") {
            yield* repo.note(row.targetId, { type: "sent", at: answeredAt }).pipe(Effect.ignore);
          }
          return outcome;
        }),
      ).pipe(Effect.tap(() => notify));

    // ----- starting ---------------------------------------------------------------

    const start: AssistantAlertsShape["start"] = () =>
      Effect.gen(function* () {
        const now = iso(yield* Clock.currentTimeMillis);
        // A Remove a restart cut short finishes now.
        yield* repo.list.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows.filter((row) => row.state === "deleting"),
              (row) => finishRemoving(row.targetId),
              { discard: true },
            ),
          ),
          logged("finishing removals"),
        );
        // A call a restart cut off may have arrived: never sent again.
        yield* repo
          .failInFlight({
            detail:
              "An alert was being sent when Threadlines stopped. It may have arrived, so it wasn't sent again.",
            now,
          })
          .pipe(logged("closing interrupted sends"));
        yield* Effect.forkScoped(
          Stream.runForEach(record.changes, () => Queue.offer(bell, undefined)),
        );
        yield* Effect.forkScoped(loop);
      });

    return AssistantAlerts.of({
      targets,
      create,
      update,
      setOn,
      remove,
      test,
      secret,
      start,
    });
  });

/** The sender over a transport (tests give their own) and the storage it is given. */
export const makeAssistantAlertsLayer = (transport: AlertTransport) =>
  Layer.effect(AssistantAlerts, make(transport));

export const AssistantAlertsLive = makeAssistantAlertsLayer(outboundTransport).pipe(
  Layer.provide(AssistantAlertRepositoryLive),
);
