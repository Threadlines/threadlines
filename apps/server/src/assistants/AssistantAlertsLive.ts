/**
 * Sends assistants' alerts to web addresses (AssistantAlerts.ts). One loop
 * wakes when the record records an event, when a target changes and when a
 * retry comes due. For each target that's on, taking the target's lock for
 * each step (Edit, Turn off, Remove, subscribe and unsubscribe take it too,
 * so they wait at most one call):
 *
 * 1. Every recorded event of its kinds and projects past where it looked
 *    gets a pending delivery row.
 * 2. Due rows go out oldest first, one at a time. Right before each, the
 *    event is read again: a needs-you that no longer needs the user (judged
 *    live, as phones are), an event the target no longer takes (Edit changed
 *    its kinds or projects), an event in General Chats (no assistant's alerts
 *    cover them, as `inbox` doesn't), or any event on a thread someone is
 *    looking at (with "Skip threads I'm looking at"), is dropped. The attempt
 *    is written before the call, so one cut off by a crash is never repeated.
 * 3. The answer settles the row, and the target's watermark moves with it.
 *
 * Tried again (`retryDelayMs`, `Retry-After` honored, at most 6 attempts and
 * 24 hours from when it was queued): a call that plainly never arrived, and
 * answers 401, 403, 408, 425, 429 and 5xx. 410 turns the target off for good
 * (`gone`). Anything else, and a call that may have arrived, ends it.
 *
 * A subscription (an assistant's, through MCP Events) differs in that past
 * its expiry nothing is queued or sent until it's refreshed; before each send
 * its connection is read again, and a removed one ends it, while events out
 * of a narrowed grant are dropped; a 410 ends only that delivery.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type AssistantAlertKind,
  type AssistantAlertTarget,
  AssistantAlertTargetId,
  type AssistantAlertTargetTestResult,
  type OutsideAgentConnectionId,
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
import { connectionNameOf } from "../outsideAgents/connectionShapes.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryLive,
} from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import {
  type AlertDeliveryRow,
  AssistantAlertRepository,
  AssistantAlertRepositoryLive,
  type AlertTargetRow,
  type DeliveryOutcome,
  type TargetNote,
} from "./AssistantAlertRepository.ts";
import {
  AssistantAlerts,
  type AssistantAlertsShape,
  AssistantSubscriptionError,
  type AssistantSubscribeInput,
  type AssistantSubscriptionKey,
  type CallbackRefusal,
  SUBSCRIBE_ERROR,
} from "./AssistantAlerts.ts";
import {
  type AssistantEvent,
  type AssistantEventName,
  assistantEventNameOf,
  AssistantEvents,
  decodeEventCursor,
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

/** Subscriptions per connection, and in all. */
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 20;
const MAX_SUBSCRIPTIONS = 50;
const MIN_SUBSCRIPTION_TTL_MS = 60 * 60_000;
const MAX_SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60_000;
/** A subscription past its expiry stays this long, to be refreshed, before it's removed. */
const KEEP_EXPIRED_MS = 7 * 24 * 60 * 60_000;
/** A key a refresh replaced keeps signing alongside the new one for this long. */
const PREVIOUS_KEY_MS = 60 * 60_000;
/** A resume reaches back at most this far and this many events: each may start a paid run. */
const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const REPLAY_LIMIT = 100;
/** Callback checks per connection per hour, and how long a passed check counts. */
const CHECKS_PER_HOUR = 10;
const CHECK_VALID_MS = 24 * 60 * 60_000;
const CHECK_CACHE_SIZE = 200;
/**
 * A subscribe's waits, which with the 10 s of the check itself stay within 20
 * s (the relay gives up at 30): for another check by this caller, for the
 * address's lookup, and for the target's lock.
 */
const CHECK_SLOT_WAIT_MS = 2_000;
const CHECK_LOOKUP_WAIT_MS = 3_000;
const LOCK_WAIT_MS = 5_000;

const KIND_ORDER: ReadonlyArray<AssistantAlertKind> = ["needs_you", "finished", "failed"];
const KIND_OF_NAME: Record<AssistantEventName, AssistantAlertKind> = {
  "thread.needs_you": "needs_you",
  "thread.finished": "finished",
  "thread.failed": "failed",
};

const SECRET_PREFIX = "assistant-alert-";
const signingSecretName = (targetId: string) => `${SECRET_PREFIX}${targetId}-signing`;
/** A subscription's key: a new entry per key, which the row names (AssistantAlertRepository). */
const newSubscriptionKeyName = (targetId: string) =>
  `${SECRET_PREFIX}${targetId}-signing-${randomUUID().slice(0, 8)}`;
/** A new entry for every value: the row names the one in use (AssistantAlertRepository). */
const newAuthorizationName = (targetId: string) =>
  `${SECRET_PREFIX}${targetId}-authorization-${randomUUID().slice(0, 8)}`;

const iso = (ms: number) => new Date(ms).toISOString();
const failure = (detail: string) => new OutsideAgentError({ detail });
const NO_NOTE: TargetNote = { type: "none" };

const subscribeFailure = (code: number, message: string, reason?: CallbackRefusal) =>
  new AssistantSubscriptionError({ code, message, ...(reason !== undefined ? { reason } : {}) });
const subscribeBusy = () =>
  subscribeFailure(SUBSCRIBE_ERROR.internal, "Threadlines is busy with that one. Try again.");
/** A failure in storage reads as one to retry; a refusal keeps its own words. */
const subscribeStored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof AssistantSubscriptionError
        ? error
        : subscribeFailure(SUBSCRIBE_ERROR.internal, "Threadlines couldn't save that. Try again."),
    ),
  );

/** `sub_` and 32 characters of a hash of what identifies it: a repeat finds the same one. */
export const subscriptionIdOf = (key: AssistantSubscriptionKey) =>
  `sub_${createHash("sha256")
    .update(JSON.stringify([key.connectionId, key.url, key.name, key.argumentsJson]))
    .digest("base64url")
    .slice(0, 32)}`;

/** Whether an answer to a callback check gives the same challenge back. */
const answersChallenge = (body: string, challenge: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const given =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { readonly challenge?: unknown }).challenge
      : undefined;
  if (typeof given !== "string") return false;
  const [a, b] = [Buffer.from(given), Buffer.from(challenge)];
  return a.length === b.length && timingSafeEqual(a, b);
};

const isExpired = (row: AlertTargetRow, nowIso: string) =>
  row.expiresAt !== null && row.expiresAt <= nowIso;

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

/**
 * What goes in the Authorization header for what the user pasted. Grok shows a
 * routine's key as a whole header line, "Authorization: Bearer crsr_…", so a
 * leading "Authorization:" is dropped, and a bare `crsr_` key gets the Bearer
 * Grok needs. Used when a value is saved and again when one is sent, so values
 * saved before this also work.
 */
const authorizationHeaderValue = (typed: string) => {
  const value = typed.replace(/^\s*authorization\s*:\s*/iu, "").trim();
  return value.startsWith("crsr_") ? `Bearer ${value}` : value;
};

/** An Authorization value that can go in a header, as it will be sent. */
const checkAuthorization = (typed: string) => {
  const value = authorizationHeaderValue(typed);
  return value === ""
    ? Effect.fail(failure("That's only the header name. Paste its value too, like Bearer crsr_…."))
    : value.length > AUTHORIZATION_MAX_LENGTH
      ? Effect.fail(failure("That Authorization value is too long."))
      : /[^\t\x20-\x7e]/u.test(value)
        ? Effect.fail(
            failure("The Authorization value can only have plain letters, numbers and symbols."),
          )
        : Effect.succeed(value);
};

const toContract = (
  row: AlertTargetRow,
  nameOfConnection: (connectionId: OutsideAgentConnectionId) => string,
): AssistantAlertTarget | null =>
  row.state === "deleting"
    ? null
    : {
        targetId: row.targetId,
        url: row.url,
        kinds: row.names.map((name) => KIND_OF_NAME[name]),
        projectIds: row.projectIds,
        skipViewed: row.skipViewed,
        state: row.state,
        hasAuthorization: row.authorizationSecret !== null,
        refusedSince: row.refusedSince,
        lastSentAt: row.lastSentAt,
        lastError: row.lastError?.trim() || null,
        retrying: row.retrying,
        createdAt: row.createdAt,
        addedBy:
          row.connectionId === null
            ? null
            : { connectionId: row.connectionId, name: nameOfConnection(row.connectionId) },
        expiresAt: row.expiresAt,
      };

const make = (transport: AlertTransport) =>
  Effect.gen(function* () {
    const repo = yield* AssistantAlertRepository;
    const connections = yield* OutsideAgentConnectionRepository;
    const record = yield* AssistantEvents;
    const pushAlerts = yield* Effect.serviceOption(PushAlerts);
    const secrets = yield* ServerSecretStore;
    const environment = yield* ServerEnvironment;
    const appOrigin = hostedAppOrigin(packageJson.version);
    const changed = yield* PubSub.sliding<void>(1);
    const bell = yield* Queue.sliding<void>(1);
    /**
     * One lock per key, there only while someone holds it or waits for it, so
     * no two can ever have different locks for one key. Per target: sends,
     * Edit, Turn off, Remove, subscribe and unsubscribe. Per connection: a
     * callback check.
     */
    const locks = new Map<string, { readonly permit: Semaphore.Semaphore; users: number }>();
    const usingLock = <A, E, R>(
      key: string,
      use: (permit: Semaphore.Semaphore) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(key) ?? { permit: Semaphore.makeUnsafe(1), users: 0 };
          entry.users += 1;
          locks.set(key, entry);
          return entry;
        }),
        (entry) => use(entry.permit),
        (entry) =>
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0) locks.delete(key);
          }),
      );
    const locked =
      (targetId: string) =>
      <A, E, R>(use: Effect.Effect<A, E, R>) =>
        usingLock(targetId, (permit) => permit.withPermits(1)(use));
    /** Holds `lock` while `use` runs, or `onBusy` when it isn't free within `waitMs`. */
    const withinWait = <A, E, R, B>(
      lock: Semaphore.Semaphore,
      waitMs: number,
      onBusy: () => B,
      use: Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const got = yield* lock.takeScoped(1).pipe(Effect.timeoutOption(Duration.millis(waitMs)));
          if (Option.isNone(got)) return yield* Effect.fail(onBusy());
          return yield* use;
        }),
      );
    /** The target's lock for a subscribe or unsubscribe, which can't wait long. */
    const lockedWithin = <A, E, R>(targetId: string, use: Effect.Effect<A, E, R>) =>
      usingLock(targetId, (permit) => withinWait(permit, LOCK_WAIT_MS, subscribeBusy, use));
    /** Targets whose secret entries are being written, by how many at once: the sweep leaves them alone. */
    const writingSecrets = new Map<string, number>();
    const whileWritingSecrets = <A, E, R>(targetId: string, use: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          writingSecrets.set(targetId, (writingSecrets.get(targetId) ?? 0) + 1);
        }),
        () => use,
        () =>
          Effect.sync(() => {
            const left = (writingSecrets.get(targetId) ?? 1) - 1;
            if (left === 0) writingSecrets.delete(targetId);
            else writingSecrets.set(targetId, left);
          }),
      );

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

    /** Every secret entry a target's row names. */
    const secretEntriesOf = (row: AlertTargetRow) =>
      [
        signingSecretName(row.targetId),
        row.signingSecret,
        row.previousSigningSecret,
        row.authorizationSecret,
      ].filter((name) => name !== null);

    const removeSecrets = (names: ReadonlyArray<string>) =>
      Effect.forEach(names, (name) => secrets.remove(name), { discard: true });

    // ----- the list Settings shows ----------------------------------------------

    const list = Effect.gen(function* () {
      const rows = yield* repo.list;
      const names = new Map<string, string>();
      // Only subscriptions name a connection: most of the time there's no read to do.
      if (rows.some((row) => row.connectionId !== null)) {
        for (const connection of yield* connections.listLive) {
          names.set(connection.connectionId, connectionNameOf(connection));
        }
      }
      return rows.flatMap((row) => {
        const target = toContract(row, (id) => names.get(id) ?? "An assistant");
        return target === null ? [] : [target];
      });
    }).pipe(stored("read the alert addresses"));

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
      }).pipe(locked(targetId));

    /** A subscription's only action is Remove: the rest are its assistant's. */
    const refuseSubscription = (row: AlertTargetRow) =>
      row.kind === "subscription"
        ? Effect.fail(failure("An assistant's subscription can only be removed."))
        : Effect.void;

    const create: AssistantAlertsShape["create"] = (input) =>
      Effect.gen(function* () {
        const fields = yield* checkFields(input);
        const authorization =
          input.authorization === null ? null : yield* checkAuthorization(input.authorization);
        const existing = yield* repo.list.pipe(stored("read the alert addresses"));
        if (
          existing.filter((row) => row.kind === "webhook" && row.state !== "deleting").length >=
          MAX_TARGETS
        ) {
          return yield* Effect.fail(
            failure(`Threadlines sends alerts to at most ${MAX_TARGETS} addresses.`),
          );
        }
        const targetId = AssistantAlertTargetId.make(randomUUID());
        const authorizationSecret = authorization === null ? null : newAuthorizationName(targetId);
        const now = iso(yield* Clock.currentTimeMillis);
        // Secrets first: a target never stands without its signing secret.
        const created = Effect.gen(function* () {
          yield* secrets.set(signingSecretName(targetId), randomBytes(WEBHOOK_SECRET_BYTES));
          if (authorization !== null && authorizationSecret !== null) {
            yield* secrets.set(authorizationSecret, Buffer.from(authorization, "utf8"));
          }
          // On from now: the record starts if it was off, and the target's
          // watermark is its last `seq`, so no history is sent.
          yield* record.keep((position) =>
            repo.insert({
              targetId,
              ...fields,
              skipViewed: input.skipViewed,
              authorizationSecret,
              startSeq: position.lastSeq,
              now,
            }),
          );
        }).pipe(
          Effect.onError(() =>
            removeSecrets([
              signingSecretName(targetId),
              ...(authorizationSecret !== null ? [authorizationSecret] : []),
            ]).pipe(Effect.ignore),
          ),
          stored("save the address"),
        );
        yield* whileWritingSecrets(targetId, created);
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
            yield* refuseSubscription(row);
            const now = iso(yield* Clock.currentTimeMillis);
            // A new value goes in a new entry, which the row's one write
            // switches to with the address: a failure on the way leaves the
            // old address with the old credential, never mixed.
            const nextSecret =
              input.authorization.kind === "set"
                ? newAuthorizationName(row.targetId)
                : input.authorization.kind === "clear"
                  ? null
                  : row.authorizationSecret;
            if (
              nextSecret !== null &&
              nextSecret !== row.authorizationSecret &&
              authorization !== null
            ) {
              yield* secrets
                .set(nextSecret, Buffer.from(authorization, "utf8"))
                .pipe(stored("save the Authorization value"));
            }
            const credentialsChanged = input.authorization.kind !== "keep";
            yield* repo
              .update({
                targetId: row.targetId,
                ...fields,
                skipViewed: input.skipViewed,
                ...(credentialsChanged ? { authorizationSecret: nextSecret } : {}),
                newCredentials: credentialsChanged || fields.url !== row.url,
                now,
              })
              .pipe(
                Effect.tapError(() =>
                  nextSecret !== row.authorizationSecret && nextSecret !== null
                    ? secrets.remove(nextSecret).pipe(Effect.ignore)
                    : Effect.void,
                ),
                stored("save the address"),
              );
            // The old value goes once nothing names it.
            if (credentialsChanged && row.authorizationSecret !== null) {
              yield* secrets.remove(row.authorizationSecret).pipe(Effect.ignore);
            }
          }).pipe((edit) => whileWritingSecrets(input.targetId, edit)),
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
        }).pipe(stored(input.on ? "turn the address on" : "turn the address off"), (change) =>
          Effect.andThen(refuseSubscription(row), change),
        ),
      ).pipe(Effect.andThen(notify));

    /** Remove's steps, in an order a restart can finish: marked, secrets gone, rows gone. */
    const finishRemoving = (row: AlertTargetRow) =>
      Effect.gen(function* () {
        const now = iso(yield* Clock.currentTimeMillis);
        yield* repo.setState({ targetId: row.targetId, state: "deleting", now });
        yield* removeSecrets(secretEntriesOf(row));
        yield* repo.delete(row.targetId);
      });

    const remove: AssistantAlertsShape["remove"] = (input) =>
      withTarget(input.targetId, (row) =>
        finishRemoving(row).pipe(stored("remove the address")),
      ).pipe(Effect.andThen(notify));

    const secret: AssistantAlertsShape["secret"] = (input) =>
      Effect.gen(function* () {
        const found = yield* repo.get(input.targetId).pipe(stored("read the address"));
        if (Option.isNone(found) || found.value.state === "deleting") {
          return yield* Effect.fail(failure("That address was removed."));
        }
        yield* refuseSubscription(found.value);
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
          timestamp: event.occurredAt,
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

    /**
     * The headers for one call: signed now, plus the Authorization the user
     * set, or a subscription's id. A key being replaced signs too, until its
     * hour is over.
     */
    const headersFor = (row: AlertTargetRow, id: string, body: string) =>
      Effect.gen(function* () {
        const signing = yield* secrets.get(row.signingSecret ?? signingSecretName(row.targetId));
        if (signing === null) return null;
        const authorization =
          row.authorizationSecret !== null ? yield* secrets.get(row.authorizationSecret) : null;
        if (row.authorizationSecret !== null && authorization === null) return null;
        const now = yield* Clock.currentTimeMillis;
        const previous =
          row.previousSigningSecret !== null &&
          row.previousSigningUntil !== null &&
          row.previousSigningUntil > iso(now)
            ? yield* secrets.get(row.previousSigningSecret)
            : null;
        return {
          ...webhookHeaders({
            secret: signing,
            previousSecret: previous,
            id,
            timestamp: Math.floor(now / 1000),
            body,
          }),
          ...(authorization !== null
            ? {
                authorization: authorizationHeaderValue(
                  Buffer.from(authorization).toString("utf8"),
                ),
              }
            : {}),
          ...(row.subscriptionId !== null ? { "x-mcp-subscription-id": row.subscriptionId } : {}),
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

    /** A subscription's connection as it is now; "unknown" when it couldn't be read. */
    const connectionOf = (row: AlertTargetRow) =>
      row.connectionId === null
        ? Effect.succeed("removed" as const)
        : connections.get(row.connectionId).pipe(
            Effect.map((found) =>
              Option.isSome(found) && found.value.removedAt === null
                ? found.value
                : ("removed" as const),
            ),
            Effect.orElseSucceed(() => "unknown" as const),
          );

    /** One delivery, start to answer; "gone" when the target ended with it. */
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
        if (row.kind === "subscription") {
          const connection = yield* connectionOf(row);
          // It couldn't be read, which doesn't mean it's gone: look again soon.
          if (connection === "unknown") {
            yield* settle({ state: "pending", nextAttemptAt: iso(now + READ_RETRY_MS) });
            return "done" as const;
          }
          if (connection === "removed") {
            yield* finishRemoving(row);
            return "gone" as const;
          }
          // The grant was narrowed since it was queued.
          if (
            connection.projectIds !== null &&
            !connection.projectIds.includes(current.event.projectId)
          ) {
            yield* settle({ state: "dropped" });
            return "done" as const;
          }
        }
        // Edited since it was queued (other kinds or projects), General Chats,
        // or a thread someone is looking at: not for this address now.
        const wanted =
          !current.generalChat &&
          row.names.includes(current.event.name) &&
          (row.projectIds === null || row.projectIds.includes(current.event.projectId));
        if (!wanted || (row.skipViewed && (yield* isViewed(current.event.threadId)))) {
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
                // A subscription's 410 is about that one event.
                if (row.kind === "subscription") return "done" as const;
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

    /**
     * What a pass does first, before anything goes out: closes a call that
     * lost its answer, retires a replaced key whose hour is over, ends a
     * subscription whose connection is gone or that has been expired too
     * long, and queues new events. Says whether to go on sending.
     */
    const prepareTarget = (targetId: AssistantAlertTargetId) =>
      Effect.gen(function* () {
        const before = yield* repo.get(targetId);
        if (Option.isNone(before) || before.value.state !== "on") {
          return { send: false, moved: false };
        }
        const row = before.value;
        const now = yield* Clock.currentTimeMillis;
        // Under the lock nothing is mid-call: a row still in flight lost its answer (a failed write).
        yield* repo.failInFlight({ targetId, detail: LOST_ANSWER, now: iso(now) });
        if (
          row.previousSigningSecret !== null &&
          (row.previousSigningUntil === null || row.previousSigningUntil <= iso(now))
        ) {
          // The row first: what's left if this stops here is an entry no row names, which a start sweeps.
          yield* repo.clearPreviousSigning(targetId);
          yield* secrets.remove(row.previousSigningSecret).pipe(Effect.ignore);
        }
        if (row.kind === "subscription") {
          if ((yield* connectionOf(row)) === "removed") {
            yield* finishRemoving(row);
            return { send: false, moved: true };
          }
          if (isExpired(row, iso(now))) {
            if (Date.parse(row.expiresAt ?? "") + KEEP_EXPIRED_MS <= now) {
              yield* finishRemoving(row);
              return { send: false, moved: true };
            }
            return { send: false, moved: false };
          }
        }
        yield* queueFor(row);
        return { send: true, moved: false };
      }).pipe(locked(targetId));

    /**
     * One delivery in the target's lock, read again under it: Edit, Remove,
     * or a refresh may have changed the target or ended the delivery while
     * it waited.
     */
    const deliverTurn = (targetId: AssistantAlertTargetId, seq: number) =>
      Effect.gen(function* () {
        const found = yield* repo.get(targetId);
        if (Option.isNone(found) || found.value.state !== "on") return "gone" as const;
        if (isExpired(found.value, iso(yield* Clock.currentTimeMillis))) return "gone" as const;
        const delivery = yield* repo.pending({ targetId, seq });
        if (Option.isNone(delivery)) return "done" as const;
        return yield* deliver(found.value, delivery.value);
      }).pipe(locked(targetId));

    /** Queues and sends for one target; true when anything moved. */
    const handleTarget = (targetId: AssistantAlertTargetId) =>
      Effect.gen(function* () {
        const prepared = yield* prepareTarget(targetId);
        if (!prepared.send) return prepared.moved;
        let moved = false;
        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          const due = yield* repo.due({ targetId, now: iso(now), limit: SEND_BATCH });
          for (const delivery of due) {
            moved = true;
            if ((yield* deliverTurn(targetId, delivery.seq)) === "gone") return true;
          }
          if (due.length < SEND_BATCH) return moved;
        }
      });

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
        const next = yield* repo
          .nextDueAt(iso(now))
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
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
          yield* refuseSubscription(row);
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

    // ----- an assistant's subscriptions -------------------------------------------

    /** Passed callback checks by (caller, address), oldest first. */
    const checkedCallbacks = new Map<string, number>();
    /** Each connection's recent checks. */
    const recentChecks = new Map<string, ReadonlyArray<number>>();
    /** One new subscription at a time, so the limits hold. */
    const newSubscriptions = Semaphore.makeUnsafe(1);

    const exhausted = (message: string) =>
      subscribeFailure(SUBSCRIBE_ERROR.resourceExhausted, message);
    const refused = (reason: CallbackRefusal, message: string) =>
      subscribeFailure(SUBSCRIBE_ERROR.callbackEndpoint, message, reason);

    /** The limits on subscriptions, for one that doesn't exist yet. */
    const checkSubscriptionRoom = (connectionId: OutsideAgentConnectionId) =>
      Effect.gen(function* () {
        const subscriptions = (yield* repo.list.pipe(subscribeStored)).filter(
          (row) => row.kind === "subscription" && row.state !== "deleting",
        );
        if (
          subscriptions.filter((row) => row.connectionId === connectionId).length >=
          MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          return yield* Effect.fail(
            exhausted(
              `An assistant can have at most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions.`,
            ),
          );
        }
        if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
          return yield* Effect.fail(
            exhausted(`This computer takes at most ${MAX_SUBSCRIPTIONS} subscriptions.`),
          );
        }
      });

    /** The address's lookup, under the network rules, within its wait. */
    const lookUpCallback = (url: string) =>
      transport.check(url).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(CHECK_LOOKUP_WAIT_MS),
          orElse: () => Effect.fail(refused("timeout", "Looking up the callback took too long.")),
        }),
        Effect.mapError((error) =>
          error instanceof AssistantSubscriptionError
            ? error
            : error.reason === "unreachable"
              ? refused("unreachable", "The callback's host couldn't be found.")
              : refused(
                  "blocked_address",
                  "Threadlines doesn't send to that address: it needs https and a public host.",
                ),
        ),
      );

    /** The verification POST: signed with the new key, and the challenge must come back. */
    const challengeCallback = (input: AssistantSubscribeInput, subscriptionId: string) =>
      Effect.gen(function* () {
        const challenge = randomBytes(32).toString("base64url");
        const body = JSON.stringify({ type: "verification", challenge });
        const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const result = yield* transport.post({
          url: input.url,
          headers: {
            ...webhookHeaders({
              secret: input.secret,
              id: `verify_${randomUUID()}`,
              timestamp,
              body,
            }),
            "x-mcp-subscription-id": subscriptionId,
          },
          body,
        });
        switch (result.type) {
          case "not_sent":
            return yield* Effect.fail(refused("unreachable", "The callback couldn't be reached."));
          case "unknown":
            return yield* Effect.fail(refused("timeout", "The callback didn't answer in time."));
          case "answered":
            if (result.status < 200 || result.status >= 300) {
              return yield* Effect.fail(
                refused("bad_status", `The callback answered ${result.status}.`),
              );
            }
            if (!answersChallenge(result.body, challenge)) {
              return yield* Effect.fail(
                refused("challenge_failed", "The callback didn't give the challenge back."),
              );
            }
        }
      });

    /** The callback is checked unless this caller passed a check on it lately. */
    const checkCallback = (input: AssistantSubscribeInput, subscriptionId: string) =>
      Effect.gen(function* () {
        const key = `${input.connectionId} ${input.url}`;
        const passedLately = (now: number) => {
          const at = checkedCallbacks.get(key);
          return at !== undefined && now - at < CHECK_VALID_MS;
        };
        if (passedLately(yield* Clock.currentTimeMillis)) {
          yield* lookUpCallback(input.url);
          return;
        }
        const busy = () =>
          exhausted("Another callback check from this assistant is under way. Try again shortly.");
        const check = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // An identical subscribe may have just done it.
          if (passedLately(now)) {
            yield* lookUpCallback(input.url);
            return;
          }
          const recent = (recentChecks.get(input.connectionId) ?? []).filter(
            (at) => now - at < 60 * 60_000,
          );
          if (recent.length >= CHECKS_PER_HOUR) {
            return yield* Effect.fail(
              exhausted("Too many callback checks from this assistant. Try again later."),
            );
          }
          recentChecks.set(input.connectionId, [...recent, now]);
          yield* lookUpCallback(input.url);
          yield* challengeCallback(input, subscriptionId);
          checkedCallbacks.delete(key);
          checkedCallbacks.set(key, yield* Clock.currentTimeMillis);
          // The oldest goes: at worst that one is checked again.
          if (checkedCallbacks.size > CHECK_CACHE_SIZE) {
            for (const oldest of checkedCallbacks.keys()) {
              checkedCallbacks.delete(oldest);
              break;
            }
          }
        });
        yield* usingLock(`check ${input.connectionId}`, (slot) =>
          withinWait(slot, CHECK_SLOT_WAIT_MS, busy, check),
        );
      });

    /** Makes it, or refreshes it; run under the target's lock, with the record on. */
    const saveSubscription = (
      input: AssistantSubscribeInput,
      subscriptionId: string,
      recordId: string,
    ) =>
      Effect.gen(function* () {
        const targetId = AssistantAlertTargetId.make(subscriptionId);
        const now = yield* Clock.currentTimeMillis;
        const ttl =
          input.ttlMs === null || input.ttlMs === undefined
            ? MAX_SUBSCRIPTION_TTL_MS
            : Math.min(MAX_SUBSCRIPTION_TTL_MS, Math.max(MIN_SUBSCRIPTION_TTL_MS, input.ttlMs));
        const expiresAt = iso(now + ttl);
        const decoded = input.cursor === null ? null : decodeEventCursor(input.cursor);
        const asked =
          input.cursor === null
            ? null
            : decoded !== null && decoded.recordId === recordId
              ? decoded.seq
              : ("foreign" as const);
        const resumeFilter = {
          notBefore: iso(now - Math.min(REPLAY_WINDOW_MS, input.maxAgeMs ?? REPLAY_WINDOW_MS)),
          limit: REPLAY_LIMIT,
          names: [input.name],
          projectIds: input.projectIds ?? input.reachableProjectIds,
        };

        // A Remove cut short by a restart that a start hasn't finished yet.
        const found = yield* repo.findSubscription(subscriptionId);
        if (Option.isSome(found) && found.value.state === "deleting") {
          yield* finishRemoving(found.value);
        }
        if (Option.isNone(found) || found.value.state === "deleting") {
          const resume = yield* record.resumeAfter({ after: asked, ...resumeFilter });
          const signingSecret = newSubscriptionKeyName(subscriptionId);
          yield* secrets.set(signingSecret, input.secret);
          yield* Effect.gen(function* () {
            yield* checkSubscriptionRoom(input.connectionId);
            yield* repo.insertSubscription({
              targetId,
              subscriptionId,
              connectionId: input.connectionId,
              url: input.url,
              name: input.name,
              argumentsJson: input.argumentsJson,
              projectIds: input.projectIds,
              signingSecret,
              startSeq: resume.start,
              expiresAt,
              now: iso(now),
            });
          }).pipe(
            newSubscriptions.withPermits(1),
            Effect.onError(() => secrets.remove(signingSecret).pipe(Effect.ignore)),
          );
          return {
            id: subscriptionId,
            refreshBefore: expiresAt,
            cursor: encodeEventCursor(recordId, resume.start),
            truncated: resume.truncated,
          };
        }

        const row = found.value;
        // The later of the two: what's at or below its watermark was acknowledged, judged
        // no longer relevant, or may have arrived, and must not go out again.
        const after = typeof asked === "number" ? Math.max(asked, row.watermark) : row.watermark;
        const resume = yield* record.resumeAfter({
          after,
          ownWatermark: after === row.watermark,
          ...resumeFilter,
        });
        // Past its expiry, what waited is queued fresh, so expiry doesn't use up its retries.
        const restartAt =
          isExpired(row, iso(now)) || resume.start > row.watermark ? resume.start : null;
        const currentKey =
          row.signingSecret === null ? null : yield* secrets.get(row.signingSecret);
        const keyChanged =
          currentKey === null ||
          currentKey.length !== input.secret.length ||
          !timingSafeEqual(currentKey, input.secret);
        const nextKeyName = keyChanged ? newSubscriptionKeyName(subscriptionId) : null;
        if (nextKeyName !== null) {
          // A second change within the hour: only the newest old key keeps signing.
          if (row.previousSigningSecret !== null) {
            yield* secrets.remove(row.previousSigningSecret).pipe(Effect.ignore);
          }
          yield* secrets.set(nextKeyName, input.secret);
        }
        yield* repo
          .refreshSubscription({
            targetId,
            projectIds: input.projectIds,
            expiresAt,
            ...(nextKeyName !== null
              ? {
                  signing: {
                    secret: nextKeyName,
                    previousSecret: row.signingSecret ?? signingSecretName(targetId),
                    previousUntil: iso(now + PREVIOUS_KEY_MS),
                  },
                }
              : {}),
            restartAt,
            now: iso(now),
          })
          .pipe(
            Effect.tapError(() =>
              nextKeyName !== null ? secrets.remove(nextKeyName).pipe(Effect.ignore) : Effect.void,
            ),
          );
        return {
          id: subscriptionId,
          refreshBefore: expiresAt,
          cursor: encodeEventCursor(recordId, restartAt ?? row.watermark),
          truncated: resume.truncated,
        };
      });

    const subscribe: AssistantAlertsShape["subscribe"] = (input) =>
      Effect.gen(function* () {
        const subscriptionId = subscriptionIdOf(input);
        // The limits come before any lookup or call.
        const existing = yield* repo.findSubscription(subscriptionId).pipe(subscribeStored);
        if (Option.isNone(existing)) yield* checkSubscriptionRoom(input.connectionId);
        yield* checkCallback(input, subscriptionId);
        const saved = yield* whileWritingSecrets(
          subscriptionId,
          lockedWithin(
            subscriptionId,
            record
              .keep((position) => saveSubscription(input, subscriptionId, position.recordId))
              .pipe(subscribeStored),
          ),
        );
        yield* notify;
        return saved;
      });

    const unsubscribe: AssistantAlertsShape["unsubscribe"] = (input) =>
      Effect.gen(function* () {
        const subscriptionId = subscriptionIdOf(input);
        yield* lockedWithin(
          subscriptionId,
          Effect.gen(function* () {
            const found = yield* repo.findSubscription(subscriptionId);
            if (Option.isSome(found)) yield* finishRemoving(found.value);
          }).pipe(subscribeStored),
        );
        yield* notify;
      });

    /**
     * Entries no row names: a crash between writing a new key and the row
     * moving to it. Read the entries first, then the rows, so a target made
     * in between is named or being written.
     */
    const sweepSecrets = Effect.gen(function* () {
      const entries = yield* secrets.list(SECRET_PREFIX);
      const rows = yield* repo.list;
      const named = new Set(rows.flatMap(secretEntriesOf));
      yield* Effect.forEach(
        entries.filter(
          (name) =>
            !named.has(name) &&
            ![...writingSecrets.keys()].some((targetId) =>
              name.startsWith(`${SECRET_PREFIX}${targetId}-`),
            ),
        ),
        (name) => secrets.remove(name),
        { discard: true },
      );
    });

    // ----- starting ---------------------------------------------------------------

    const start: AssistantAlertsShape["start"] = () =>
      Effect.gen(function* () {
        const now = iso(yield* Clock.currentTimeMillis);
        // A Remove a restart cut short finishes now.
        yield* repo.list.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows.filter((row) => row.state === "deleting"),
              (row) => finishRemoving(row),
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
        yield* sweepSecrets.pipe(logged("sweeping old secrets"));
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
      subscribe,
      unsubscribe,
      start,
    });
  });

/** The sender over a transport (tests give their own) and the storage it is given. */
export const makeAssistantAlertsLayer = (transport: AlertTransport) =>
  Layer.effect(AssistantAlerts, make(transport));

export const AssistantAlertsLive = makeAssistantAlertsLayer(outboundTransport).pipe(
  Layer.provide(AssistantAlertRepositoryLive),
  Layer.provide(OutsideAgentConnectionRepositoryLive),
);
