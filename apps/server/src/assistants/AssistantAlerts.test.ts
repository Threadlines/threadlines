import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AssistantAlertTarget,
  AssistantAlertTargetId,
  OutsideAgentConnectionId,
  ProjectId,
  ThreadId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  checkOutboundUrl,
  type OutboundAddressError,
  type OutboundResult,
} from "../net/outboundHttps.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PushAlerts } from "../pushAlerts/PushAlerts.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryError,
} from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import {
  AssistantAlertRepository,
  AssistantAlertRepositoryLive,
} from "./AssistantAlertRepository.ts";
import {
  AssistantAlerts,
  type AssistantAlertsShape,
  type AssistantSubscribeInput,
} from "./AssistantAlerts.ts";
import {
  type AlertTransport,
  makeAssistantAlertsLayer,
  subscriptionIdOf,
} from "./AssistantAlertsLive.ts";
import {
  type AssistantEvent,
  type AssistantEventName,
  AssistantEvents,
  type AssistantEventsShape,
  encodeEventCursor,
} from "./AssistantEvents.ts";
import { parseWebhookSecret, signWebhook } from "./webhookSigning.ts";

const THREAD = ThreadId.make("thread-1");
const VIEWED_THREAD = ThreadId.make("thread-viewed");
const PROJECT = ProjectId.make("project-app");
const OTHER_PROJECT = ProjectId.make("project-other");
const GENERAL_CHATS = ProjectId.make("project-general");
const URL_TEXT = "https://alerts.example/hook";
const CONNECTION = OutsideAgentConnectionId.make("connection-dot");
const CALLBACK = "https://chatgpt.example/events/abc";
const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);
const KEY_C = new Uint8Array(32).fill(3);
const HOUR_MS = 60 * 60_000;

interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const bodyOf = (call: Call) => JSON.parse(call.body) as Record<string, unknown>;
const isCheck = (call: Call) => bodyOf(call).type === "verification";

/**
 * A computer with the record faked (events the test adds, judged as the test
 * says) and the storage, the sender and its secrets real; the receiver
 * answers from `answers`, then 200. Kept across `boot`s, like a restart.
 */
const makeHarness = Effect.gen(function* () {
  const events: Array<AssistantEvent> = [];
  /** How `current` judges an event; true unless set. */
  const stands = new Map<number, boolean | "unknown">();
  const viewed = new Set<string>([VIEWED_THREAD]);
  const calls: Array<Call> = [];
  const answers: Array<OutboundResult> = [];
  const secrets = new Map<string, Uint8Array>();
  /** How many deliveries had gone out each time a secret was written, in order. */
  const deliveriesAtKeyWrite: Array<number> = [];
  /** Calls wait here while it's closed, as a slow receiver does. */
  const postsFlow = Latch.makeUnsafe(true);
  /** What a callback answers a check with; left out: the challenge back. */
  const checkAnswers: Array<OutboundResult> = [];
  /** Connections by id; a missing one is removed. `null` as the whole value: a read that fails. */
  const connectionRows = new Map<string, { readonly projectIds: ReadonlyArray<ProjectId> | null }>([
    [CONNECTION, { projectIds: null }],
  ]);
  let connectionReadsFail = false;
  /** What the record was asked about resuming. */
  const resumes: Array<Parameters<AssistantEventsShape["resumeAfter"]>[0]> = [];
  /** What the record has pruned: a resume below it is truncated. */
  let prunedThroughSeq = 0;
  const recorded = yield* PubSub.unbounded<void>();
  const storage = yield* Layer.build(SqlitePersistenceMemory);

  const position = Effect.sync(() => ({
    recordId: "record-1",
    running: true,
    lastSeq: events.at(-1)?.seq ?? 0,
    prunedThroughSeq,
  }));
  const record: AssistantEventsShape = {
    position,
    since: (input) =>
      Effect.sync(() => {
        const lastSeq = events.at(-1)?.seq ?? 0;
        const matching = events.filter(
          (event) =>
            event.seq > input.after &&
            (input.names === undefined || input.names.includes(event.name)) &&
            (input.projectIds === undefined || input.projectIds.includes(event.projectId)),
        );
        const page = matching.slice(0, input.limit);
        const more = matching.length > input.limit;
        return {
          events: page,
          more,
          upTo: more ? page.at(-1)!.seq : Math.max(lastSeq, input.after),
        };
      }),
    current: (seq) =>
      Effect.sync(() => {
        const event = events.find((entry) => entry.seq === seq);
        return event === undefined
          ? null
          : {
              event,
              stands: stands.get(seq) ?? true,
              project: "app",
              generalChat: event.projectId === GENERAL_CHATS,
            };
      }),
    // The rules themselves are the record's (AssistantEvents.test.ts).
    resumeAfter: (input) =>
      Effect.sync(() => {
        resumes.push(input);
        const lastSeq = events.at(-1)?.seq ?? 0;
        if (input.after === null) return { start: lastSeq, truncated: false };
        if (input.after === "foreign") return { start: prunedThroughSeq, truncated: true };
        return input.after < prunedThroughSeq
          ? { start: prunedThroughSeq, truncated: true }
          : { start: input.after, truncated: false };
      }),
    keep: (use) => Effect.flatMap(position, use),
    changes: Stream.fromPubSub(recorded),
    start: () => Effect.void,
  };
  const transport: AlertTransport = {
    check: (url) =>
      Effect.try({
        try: () => checkOutboundUrl(url),
        catch: (error) => error as OutboundAddressError,
      }),
    post: (input) =>
      Effect.gen(function* () {
        calls.push(input);
        yield* postsFlow.await;
        const parsed = JSON.parse(input.body) as { type?: string; challenge?: string };
        if (parsed.type === "verification") {
          return (
            checkAnswers.shift() ?? {
              type: "answered",
              status: 200,
              retryAfterSeconds: undefined,
              body: JSON.stringify({ challenge: parsed.challenge }),
            }
          );
        }
        return (
          answers.shift() ?? {
            type: "answered",
            status: 200,
            retryAfterSeconds: undefined,
            body: "",
          }
        );
      }),
  };
  const layer = makeAssistantAlertsLayer(transport).pipe(
    Layer.provideMerge(AssistantAlertRepositoryLive),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AssistantEvents, record),
        Layer.mock(PushAlerts)({ isViewed: (threadId) => Effect.succeed(viewed.has(threadId)) }),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed("environment-1"),
          getDescriptor: Effect.succeed({ label: "Will's MacBook Pro" }),
        } as never),
        Layer.succeed(ServerSecretStore, {
          get: (name) => Effect.sync(() => secrets.get(name) ?? null),
          set: (name, value) =>
            Effect.sync(() => {
              secrets.set(name, value);
              deliveriesAtKeyWrite.push(calls.filter((call) => !isCheck(call)).length);
            }),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
          list: (prefix) =>
            Effect.sync(() => [...secrets.keys()].filter((name) => name.startsWith(prefix))),
        }),
        Layer.mock(OutsideAgentConnectionRepository)({
          get: (connectionId) =>
            connectionReadsFail
              ? Effect.fail(
                  new OutsideAgentConnectionRepositoryError({ operation: "get", cause: "test" }),
                )
              : Effect.sync(() => {
                  const row = connectionRows.get(connectionId);
                  return row === undefined
                    ? Option.none()
                    : Option.some({ ...row, connectionId, removedAt: null } as never);
                }),
          listLive: Effect.sync(() =>
            [...connectionRows.keys()].map(
              (connectionId) =>
                ({
                  connectionId,
                  kind: "assistant",
                  signIn: "key",
                  clientName: "Dots",
                  removedAt: null,
                }) as never,
            ),
          ),
        }),
      ),
    ),
    Layer.provide(Layer.succeedContext(storage)),
  );

  /** Starts the sender in its own scope; closing it is the process stopping. */
  const boot = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    const alerts = Context.get(context, AssistantAlerts);
    yield* alerts.start().pipe(Scope.provide(scope));
    return {
      alerts,
      repo: Context.get(context, AssistantAlertRepository),
      stop: Scope.close(scope, Exit.void),
    };
  });

  let seq = 0;
  /** An event the record made final; the sender hears of it. */
  const record_ = (
    name: AssistantEventName,
    options: {
      readonly threadId?: ThreadId;
      readonly projectId?: ProjectId;
      readonly stands?: boolean | "unknown";
    } = {},
  ) =>
    Effect.gen(function* () {
      seq += 1;
      events.push({
        eventId: `event-${seq}`,
        seq,
        name,
        reason: name === "thread.needs_you" ? "approval" : "finished",
        threadId: options.threadId ?? THREAD,
        projectId: options.projectId ?? PROJECT,
        occurredAt: "2026-10-31T10:00:00.000Z",
        recordedAt: "2026-10-31T10:00:08.000Z",
        resolvedAt: null,
        resolvedReason: null,
      });
      if (options.stands !== undefined) stands.set(seq, options.stands);
      yield* PubSub.publish(recorded, undefined);
      return seq;
    });

  return {
    boot,
    calls,
    answers,
    checkAnswers,
    deliveriesAtKeyWrite,
    resumes,
    record: record_,
    stands,
    secrets,
    postsFlow,
    connectionRows,
    setConnectionReadsFail: (fail: boolean) => {
      connectionReadsFail = fail;
    },
    setPrunedThrough: (seq: number) => {
      prunedThroughSeq = seq;
    },
  };
});

/** Lets the sender's loop run: time moves on in small steps. */
const settle = (ms = 500) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
    }
  });

const targetOf = (alerts: AssistantAlertsShape, targetId: AssistantAlertTargetId) =>
  alerts.targets.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((emitted) =>
      emitted[0]!.find((target: AssistantAlertTarget) => target.targetId === targetId),
    ),
    Effect.orDie,
  );

const SUBSCRIPTION: AssistantSubscribeInput = {
  connectionId: CONNECTION,
  url: CALLBACK,
  name: "thread.finished",
  argumentsJson: "{}",
  projectIds: null,
  reachableProjectIds: [PROJECT],
  secret: KEY_A,
  cursor: null,
};
const subscriptionTarget = AssistantAlertTargetId.make(subscriptionIdOf(SUBSCRIPTION));

const deliveriesIn = (calls: ReadonlyArray<Call>) => calls.filter((call) => !isCheck(call));
/** How a subscribe or unsubscribe was turned down. */
const refusal = <A>(
  effect: Effect.Effect<A, { readonly code: number; readonly reason?: string }>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ({ code: error.code, reason: error.reason })),
  );

const createTarget = (alerts: AssistantAlertsShape) =>
  alerts
    .create({
      url: URL_TEXT,
      kinds: ["needs_you", "finished", "failed"],
      projectIds: null,
      skipViewed: true,
      authorization: "Bearer crsr_test",
    })
    .pipe(Effect.map((created) => created.targetId));

it.layer(NodeServices.layer)("AssistantAlerts", (it) => {
  it.effect("sends what's recorded after it was added, signed, without titles or agent text", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.record("thread.finished");
      const { alerts, stop } = yield* harness.boot;
      const targetId = yield* createTarget(alerts);
      const seq = yield* harness.record("thread.needs_you");
      yield* settle();

      // History before the target isn't sent; the new event is, once.
      assert.strictEqual(harness.calls.length, 1);
      const [call] = harness.calls;
      const body = bodyOf(call!);
      assert.deepStrictEqual(
        { name: body.name, eventId: body.eventId, data: body.data },
        {
          name: "thread.needs_you",
          eventId: `event-${seq}`,
          data: {
            kind: "needs_you",
            reason: "approval",
            threadId: THREAD,
            projectId: PROJECT,
            project: "app",
            computer: "Will's MacBook Pro",
            link: `https://app.threadlines.dev/environment-1/${THREAD}`,
            at: "2026-10-31T10:00:00.000Z",
          },
        },
      );
      // The receiver checks the signature with the secret Settings copies.
      const { secret } = yield* alerts.secret({ targetId });
      assert.strictEqual(call!.headers["webhook-id"], `event-${seq}`);
      assert.strictEqual(
        call!.headers["webhook-signature"],
        signWebhook({
          secret: parseWebhookSecret(secret),
          id: `event-${seq}`,
          timestamp: Number(call!.headers["webhook-timestamp"]),
          body: call!.body,
        }),
      );
      assert.strictEqual(call!.headers.authorization, "Bearer crsr_test");
      assert.strictEqual((yield* targetOf(alerts, targetId))?.lastSentAt !== null, true);
      yield* stop;
    }),
  );

  it.effect("signs as Standard Webhooks' test vector says", () =>
    Effect.sync(() => {
      assert.strictEqual(
        signWebhook({
          secret: parseWebhookSecret("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"),
          id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
          timestamp: 1614265330,
          body: '{"test": 2432232314}',
        }),
        "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      );
    }),
  );

  it.effect(
    "a retrying event holds the cursor back while a later one goes out, and one that may have arrived isn't sent again",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { alerts, repo, stop } = yield* harness.boot;
        const targetId = yield* createTarget(alerts);
        const watermark = repo
          .get(targetId)
          .pipe(Effect.map((found) => (found._tag === "Some" ? found.value.watermark : -1)));
        harness.answers.push(
          { type: "answered", status: 503, retryAfterSeconds: undefined, body: "" },
          { type: "answered", status: 200, retryAfterSeconds: undefined, body: "" },
          { type: "unknown", detail: "No answer in time." },
        );
        const first = yield* harness.record("thread.finished");
        const second = yield* harness.record("thread.failed");
        const third = yield* harness.record("thread.finished");
        yield* settle();
        assert.deepStrictEqual(
          harness.calls.map((call) => bodyOf(call).eventId),
          [`event-${first}`, `event-${second}`, `event-${third}`],
        );
        // The first is still retrying: everything after it waits behind it.
        assert.strictEqual(yield* watermark, first - 1);

        // The first is tried again after its delay and gets through; the
        // third may have arrived, so it never goes again.
        yield* settle(6_000);
        assert.deepStrictEqual(
          harness.calls.map((call) => bodyOf(call).eventId),
          [`event-${first}`, `event-${second}`, `event-${third}`, `event-${first}`],
        );
        assert.strictEqual(yield* watermark, third);
        yield* settle(60_000);
        assert.strictEqual(harness.calls.length, 4);
        yield* stop;
      }),
  );

  it.effect(
    "drops a needs-you that no longer stands and skips a thread someone is looking at",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { alerts, stop } = yield* harness.boot;
        yield* createTarget(alerts);
        yield* harness.record("thread.needs_you", { stands: false });
        yield* harness.record("thread.finished", { threadId: VIEWED_THREAD });
        const sent = yield* harness.record("thread.failed");
        yield* settle();
        assert.deepStrictEqual(
          harness.calls.map((call) => bodyOf(call).eventId),
          [`event-${sent}`],
        );
        yield* stop;
      }),
  );

  it.effect(
    "410 turns the target off; three refusals show, and an answer that works clears them",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { alerts, stop } = yield* harness.boot;
        const targetId = yield* createTarget(alerts);
        const refused = {
          type: "answered",
          status: 401,
          retryAfterSeconds: undefined,
          body: "",
        } as const;
        harness.answers.push(refused, refused, refused);
        yield* harness.record("thread.finished");
        // Attempts at 0, 5 s and 20 s.
        yield* settle(21_000);
        const afterRefusals = yield* targetOf(alerts, targetId);
        assert.strictEqual(harness.calls.length, 3);
        assert.notStrictEqual(afterRefusals?.refusedSince, null);
        assert.strictEqual(afterRefusals?.retrying, 1);
        // The fourth try gets through.
        yield* settle(46_000);
        const cleared = yield* targetOf(alerts, targetId);
        assert.strictEqual(harness.calls.length, 4);
        assert.strictEqual(cleared?.refusedSince, null);
        assert.strictEqual(cleared?.lastError, null);

        harness.answers.push({
          type: "answered",
          status: 410,
          retryAfterSeconds: undefined,
          body: "",
        });
        yield* harness.record("thread.finished");
        yield* settle();
        assert.strictEqual((yield* targetOf(alerts, targetId))?.state, "gone");
        // Off: nothing more goes out, and turning it on again sends nothing it missed.
        yield* harness.record("thread.failed");
        yield* settle();
        yield* alerts.setOn({ targetId, on: true });
        yield* settle();
        assert.strictEqual(harness.calls.length, 5);
        const next = yield* harness.record("thread.failed");
        yield* settle();
        assert.strictEqual(bodyOf(harness.calls[5]!).eventId, `event-${next}`);
        yield* stop;
      }),
  );

  it.effect("a send a restart cut off is never repeated, and the rest carry on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = yield* harness.boot;
      const targetId = yield* createTarget(first.alerts);
      yield* first.stop;
      // Queued, and one of them mid-call when the process died.
      const cut = yield* harness.record("thread.finished");
      const waiting = yield* harness.record("thread.failed");
      yield* first.repo.queue({
        targetId,
        events: [
          { seq: cut, eventId: `event-${cut}` },
          { seq: waiting, eventId: `event-${waiting}` },
        ],
        scannedSeq: waiting,
        now: "1970-01-01T00:00:00.000Z",
      });
      yield* first.repo.beginAttempt({ targetId, seq: cut, now: "1970-01-01T00:00:00.000Z" });

      const second = yield* harness.boot;
      yield* settle();
      assert.deepStrictEqual(
        harness.calls.map((call) => bodyOf(call).eventId),
        [`event-${waiting}`],
      );
      // Never again, however long it waits.
      yield* TestClock.adjust("1 hour");
      yield* settle();
      assert.strictEqual(harness.calls.length, 1);
      yield* second.stop;
    }),
  );

  it.effect("an edit reaches alerts still waiting, and moves address and key together", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      const targetId = yield* createTarget(alerts);
      harness.answers.push({
        type: "answered",
        status: 503,
        retryAfterSeconds: undefined,
        body: "",
      });
      yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(harness.calls.length, 1);

      // Now only needs-you, at a new address with a new key: the finished
      // event waiting for its retry is no longer this address's.
      yield* alerts.update({
        targetId,
        url: "https://alerts.example/other",
        kinds: ["needs_you"],
        projectIds: null,
        skipViewed: true,
        authorization: { kind: "set", value: "Bearer crsr_new" },
      });
      yield* settle(6_000);
      assert.strictEqual(harness.calls.length, 1);
      const needed = yield* harness.record("thread.needs_you");
      yield* settle();
      const last = harness.calls.at(-1)!;
      assert.strictEqual(bodyOf(last).eventId, `event-${needed}`);
      assert.strictEqual(last.url, "https://alerts.example/other");
      assert.strictEqual(last.headers.authorization, "Bearer crsr_new");
      // The old key is gone from the secret store; only the new one is kept.
      const keys = [...harness.secrets.keys()].filter((name) => name.includes("-authorization"));
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(
        new TextDecoder().decode(harness.secrets.get(keys[0]!)),
        "Bearer crsr_new",
      );
      yield* stop;
    }),
  );

  it.effect("Remove forgets the target's secrets and stops its alerts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      const targetId = yield* createTarget(alerts);
      yield* alerts.remove({ targetId });
      yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(harness.calls.length, 0);
      assert.strictEqual(yield* targetOf(alerts, targetId), undefined);
      const secret = yield* alerts.secret({ targetId }).pipe(Effect.flip);
      assert.strictEqual(secret.detail, "That address was removed.");
      yield* stop;
    }),
  );
  it.effect("a callback must give the challenge back, signed with the subscriber's key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      const answered = (status: number, body: string): OutboundResult => ({
        type: "answered",
        status,
        retryAfterSeconds: undefined,
        body,
      });

      harness.checkAnswers.push(answered(200, '{"challenge":"not-it"}'));
      assert.deepStrictEqual(yield* refusal(alerts.subscribe(SUBSCRIPTION)), {
        code: -32015,
        reason: "challenge_failed",
      });
      harness.checkAnswers.push(answered(500, ""));
      assert.deepStrictEqual(yield* refusal(alerts.subscribe(SUBSCRIPTION)), {
        code: -32015,
        reason: "bad_status",
      });
      harness.checkAnswers.push({ type: "not_sent", detail: "no route" });
      assert.deepStrictEqual(yield* refusal(alerts.subscribe(SUBSCRIPTION)), {
        code: -32015,
        reason: "unreachable",
      });
      harness.checkAnswers.push({ type: "unknown", detail: "no answer" });
      assert.deepStrictEqual(yield* refusal(alerts.subscribe(SUBSCRIPTION)), {
        code: -32015,
        reason: "timeout",
      });
      // A private or plain address is refused without any call.
      const callsBefore = harness.calls.length;
      assert.deepStrictEqual(
        yield* refusal(alerts.subscribe({ ...SUBSCRIPTION, url: "http://chatgpt.example/x" })),
        { code: -32015, reason: "blocked_address" },
      );
      assert.strictEqual(harness.calls.length, callsBefore);

      const saved = yield* alerts.subscribe(SUBSCRIPTION);
      const check = harness.calls.at(-1)!;
      assert.strictEqual(bodyOf(check).type, "verification");
      assert.strictEqual(check.headers["x-mcp-subscription-id"], saved.id);
      assert.strictEqual(
        check.headers["webhook-signature"],
        signWebhook({
          secret: KEY_A,
          id: check.headers["webhook-id"]!,
          timestamp: Number(check.headers["webhook-timestamp"]),
          body: check.body,
        }),
      );

      // Passed: not checked again for a while, for any event on that address.
      const after = harness.calls.length;
      yield* alerts.subscribe({ ...SUBSCRIPTION, name: "thread.failed" });
      assert.strictEqual(harness.calls.length, after);
      yield* stop;
    }),
  );

  it.effect("a repeat subscribe is the same subscription, later; unsubscribe forgets it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, repo, stop } = yield* harness.boot;
      const first = yield* alerts.subscribe({ ...SUBSCRIPTION, ttlMs: HOUR_MS });
      yield* TestClock.adjust("10 minutes");
      const second = yield* alerts.subscribe({ ...SUBSCRIPTION, ttlMs: HOUR_MS });
      assert.strictEqual(second.id, first.id);
      assert.isTrue(second.refreshBefore > first.refreshBefore);
      assert.strictEqual((yield* repo.list).length, 1);

      // Arguments as sent are the identity: another project form is another one.
      const other = yield* alerts.subscribe({ ...SUBSCRIPTION, argumentsJson: '{"project":"x"}' });
      assert.notStrictEqual(other.id, first.id);

      yield* alerts.unsubscribe(SUBSCRIPTION);
      yield* alerts.unsubscribe(SUBSCRIPTION);
      assert.isTrue(Option.isNone(yield* repo.get(subscriptionTarget)));
      yield* stop;
    }),
  );

  it.effect("the lifetime is at least an hour and at most a week", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      const now = yield* Clock.currentTimeMillis;
      const lifetime = (ttlMs: number | null) =>
        alerts
          .subscribe({ ...SUBSCRIPTION, ttlMs })
          .pipe(Effect.map((saved) => Date.parse(saved.refreshBefore) - now));
      assert.strictEqual(yield* lifetime(1000), HOUR_MS);
      assert.strictEqual(yield* lifetime(null), 7 * 24 * HOUR_MS);
      assert.strictEqual(yield* lifetime(365 * 24 * HOUR_MS), 7 * 24 * HOUR_MS);
      yield* stop;
    }),
  );

  it.effect("limits answer before any lookup or call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      for (let index = 0; index < 20; index += 1) {
        yield* alerts.subscribe({ ...SUBSCRIPTION, argumentsJson: `{"project":"p${index}"}` });
      }
      const callsBefore = harness.calls.length;
      assert.deepStrictEqual(
        yield* refusal(alerts.subscribe({ ...SUBSCRIPTION, argumentsJson: '{"project":"p21"}' })),
        { code: -32025, reason: undefined },
      );
      assert.strictEqual(harness.calls.length, callsBefore);
      // One already there isn't another: it can still be refreshed.
      yield* alerts.subscribe({ ...SUBSCRIPTION, argumentsJson: '{"project":"p0"}' });

      // Checks are limited per connection, passed or not.
      const other = OutsideAgentConnectionId.make("connection-other");
      harness.connectionRows.set(other, { projectIds: null });
      for (let index = 0; index < 10; index += 1) {
        harness.checkAnswers.push({ type: "not_sent", detail: "no route" });
        yield* refusal(
          alerts.subscribe({ ...SUBSCRIPTION, connectionId: other, url: `${CALLBACK}/${index}` }),
        );
      }
      const checksBefore = harness.calls.length;
      assert.deepStrictEqual(
        yield* refusal(
          alerts.subscribe({ ...SUBSCRIPTION, connectionId: other, url: `${CALLBACK}/last` }),
        ),
        { code: -32025, reason: undefined },
      );
      assert.strictEqual(harness.calls.length, checksBefore);
      yield* stop;
    }),
  );

  it.effect("a subscription's delivery names it, signs with its key, and both after a change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      const saved = yield* alerts.subscribe(SUBSCRIPTION);
      const seq = yield* harness.record("thread.finished");
      yield* settle();
      const [delivery] = deliveriesIn(harness.calls);
      const signature = (secret: Uint8Array, call: Call) =>
        signWebhook({
          secret,
          id: call.headers["webhook-id"]!,
          timestamp: Number(call.headers["webhook-timestamp"]),
          body: call.body,
        });
      assert.strictEqual(delivery!.url, CALLBACK);
      assert.strictEqual(delivery!.headers["x-mcp-subscription-id"], saved.id);
      assert.strictEqual(delivery!.headers["webhook-id"], `event-${seq}`);
      assert.strictEqual(delivery!.headers["webhook-signature"], signature(KEY_A, delivery!));
      // When it happened, for both kinds of target.
      assert.strictEqual(bodyOf(delivery!).timestamp, "2026-10-31T10:00:00.000Z");

      yield* alerts.subscribe({ ...SUBSCRIPTION, secret: KEY_B });
      yield* harness.record("thread.finished");
      yield* settle();
      const rotated = deliveriesIn(harness.calls).at(-1)!;
      assert.strictEqual(
        rotated.headers["webhook-signature"],
        `${signature(KEY_B, rotated)} ${signature(KEY_A, rotated)}`,
      );

      // A second change within the hour: only the newest old key still signs.
      yield* alerts.subscribe({ ...SUBSCRIPTION, secret: KEY_C });
      yield* harness.record("thread.finished");
      yield* settle();
      const again = deliveriesIn(harness.calls).at(-1)!;
      assert.strictEqual(
        again.headers["webhook-signature"],
        `${signature(KEY_C, again)} ${signature(KEY_B, again)}`,
      );

      // The hour over, the old key is gone, from the signature and the store.
      yield* TestClock.adjust("61 minutes");
      yield* settle();
      yield* harness.record("thread.finished");
      yield* settle();
      const later = deliveriesIn(harness.calls).at(-1)!;
      assert.strictEqual(later.headers["webhook-signature"], signature(KEY_C, later));
      assert.strictEqual(harness.secrets.size, 1);

      // Unsubscribing leaves no secret behind.
      yield* alerts.unsubscribe(SUBSCRIPTION);
      assert.strictEqual(harness.secrets.size, 0);
      yield* stop;
    }),
  );

  it.effect("past its expiry it sends nothing; a refresh catches up, retries unspent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, repo, stop } = yield* harness.boot;
      yield* alerts.subscribe({ ...SUBSCRIPTION, ttlMs: HOUR_MS });
      // It waits two hours, past the expiry.
      harness.answers.push({ type: "answered", status: 500, retryAfterSeconds: 7200, body: "" });
      const waiting = yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 1);

      yield* TestClock.adjust("61 minutes");
      const missed = yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 1);

      const refreshed = yield* alerts.subscribe({ ...SUBSCRIPTION, ttlMs: HOUR_MS });
      assert.isFalse(refreshed.truncated);
      yield* settle();
      assert.deepStrictEqual(
        deliveriesIn(harness.calls)
          .slice(1)
          .map((call) => bodyOf(call).eventId),
        [`event-${waiting}`, `event-${missed}`],
      );

      // Left expired for a week, it's removed with its key.
      yield* TestClock.adjust("8 days");
      yield* settle();
      assert.isTrue(Option.isNone(yield* repo.get(subscriptionTarget)));
      assert.strictEqual(harness.secrets.size, 0);
      yield* stop;
    }),
  );

  it.effect(
    "a resume starts at the later of the cursor and the watermark, and says when it can't",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { alerts, stop } = yield* harness.boot;
        const one = yield* harness.record("thread.finished");
        const two = yield* harness.record("thread.finished");

        // A new one with no cursor has no history.
        const fresh = yield* alerts.subscribe(SUBSCRIPTION);
        assert.isFalse(fresh.truncated);
        assert.strictEqual(fresh.cursor, encodeEventCursor("record-1", two));
        yield* settle();
        assert.strictEqual(deliveriesIn(harness.calls).length, 0);
        yield* alerts.unsubscribe(SUBSCRIPTION);

        // A new one with a cursor gets what came after it.
        yield* alerts.subscribe({ ...SUBSCRIPTION, cursor: encodeEventCursor("record-1", one) });
        yield* settle();
        assert.deepStrictEqual(
          deliveriesIn(harness.calls).map((call) => bodyOf(call).eventId),
          [`event-${two}`],
        );

        // A refresh never goes back behind its own watermark.
        const refreshed = yield* alerts.subscribe({
          ...SUBSCRIPTION,
          cursor: encodeEventCursor("record-1", 0),
        });
        yield* settle();
        assert.strictEqual(refreshed.cursor, encodeEventCursor("record-1", two));
        assert.strictEqual(deliveriesIn(harness.calls).length, 1);
        yield* alerts.unsubscribe(SUBSCRIPTION);

        // Another record's cursor, or one older than what's kept: truncated. It replays what
        // it may reach, counting only what it may hear about.
        const foreign = yield* alerts.subscribe({
          ...SUBSCRIPTION,
          cursor: encodeEventCursor("record-other", 1),
        });
        assert.isTrue(foreign.truncated);
        assert.deepStrictEqual(harness.resumes.at(-1)?.projectIds, [PROJECT]);
        yield* settle();
        yield* alerts.unsubscribe(SUBSCRIPTION);
        harness.setPrunedThrough(one);
        const old = yield* alerts.subscribe({
          ...SUBSCRIPTION,
          cursor: encodeEventCursor("record-1", 0),
        });
        assert.isTrue(old.truncated);
        yield* stop;
      }),
  );

  it.effect("a removed connection ends its subscriptions; a failed read only waits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, repo, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);

      // A read that fails isn't a removal, and costs no attempt.
      harness.setConnectionReadsFail(true);
      yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 0);
      assert.isTrue(Option.isSome(yield* repo.get(subscriptionTarget)));
      harness.setConnectionReadsFail(false);
      yield* TestClock.adjust("1 minute");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 1);

      harness.connectionRows.delete(CONNECTION);
      yield* TestClock.adjust("1 minute");
      yield* settle();
      assert.isTrue(Option.isNone(yield* repo.get(subscriptionTarget)));
      assert.strictEqual(harness.secrets.size, 0);
      yield* stop;
    }),
  );

  it.effect("a narrowed grant drops other projects' events", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);
      harness.connectionRows.set(CONNECTION, { projectIds: [PROJECT] });
      yield* harness.record("thread.finished", { projectId: OTHER_PROJECT });
      const inGrant = yield* harness.record("thread.finished");
      yield* settle();
      assert.deepStrictEqual(
        deliveriesIn(harness.calls).map((call) => bodyOf(call).eventId),
        [`event-${inGrant}`],
      );
      yield* stop;
    }),
  );

  it.effect("no assistant's alerts cover General Chats", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      yield* createTarget(alerts);
      yield* alerts.subscribe(SUBSCRIPTION);
      yield* harness.record("thread.finished", { projectId: GENERAL_CHATS });
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 0);
      yield* stop;
    }),
  );

  it.effect("a 410 ends that delivery and leaves the subscription on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, repo, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);
      harness.answers.push({
        type: "answered",
        status: 410,
        retryAfterSeconds: undefined,
        body: "",
      });
      yield* harness.record("thread.finished");
      yield* settle();
      const row = yield* repo.get(subscriptionTarget);
      assert.strictEqual(Option.getOrThrow(row).state, "on");
      yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 2);
      yield* stop;
    }),
  );

  it.effect("a subscribe while a slow send holds the lock says busy, then works", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);
      harness.postsFlow.closeUnsafe();
      yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 1);

      const waiting = yield* alerts.subscribe(SUBSCRIPTION).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("6 seconds");
      const busy = yield* Fiber.join(waiting);
      assert.strictEqual(busy.code, -32603);

      harness.postsFlow.openUnsafe();
      yield* settle();
      yield* alerts.subscribe(SUBSCRIPTION);
      yield* stop;
    }),
  );

  it.effect("a subscribe doesn't wait out the sender's whole queue", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);
      harness.postsFlow.closeUnsafe();
      for (let index = 0; index < 5; index += 1) yield* harness.record("thread.finished");
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 1);

      // A new key is written under the lock: only the call under way had gone out,
      // however many are behind it.
      const waiting = yield* alerts
        .subscribe({ ...SUBSCRIPTION, secret: KEY_B })
        .pipe(Effect.forkChild);
      yield* settle();
      harness.postsFlow.openUnsafe();
      const refreshed = yield* Fiber.join(waiting);
      assert.strictEqual(refreshed.id, subscriptionTarget);
      assert.strictEqual(harness.deliveriesAtKeyWrite.at(-1), 1);
      yield* settle();
      assert.strictEqual(deliveriesIn(harness.calls).length, 5);
      yield* stop;
    }),
  );

  it.effect("two identical subscribes at once make one subscription", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, repo, stop } = yield* harness.boot;
      const [first, second] = yield* Effect.all(
        [alerts.subscribe(SUBSCRIPTION), alerts.subscribe(SUBSCRIPTION)],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(first.id, second.id);
      assert.strictEqual((yield* repo.list).length, 1);
      assert.strictEqual(harness.calls.filter(isCheck).length, 1);
      assert.strictEqual(harness.secrets.size, 1);
      yield* stop;
    }),
  );

  it.effect("subscribes around an unsubscribe all take the same lock", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, repo, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);
      yield* Effect.all(
        [
          alerts.unsubscribe(SUBSCRIPTION),
          alerts.subscribe(SUBSCRIPTION),
          alerts.subscribe(SUBSCRIPTION),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual((yield* repo.list).length, 1);
      assert.strictEqual(harness.secrets.size, 1);
      yield* stop;
    }),
  );

  it.effect("a subscription can only be removed in Settings, and shows who added it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { alerts, stop } = yield* harness.boot;
      yield* alerts.subscribe(SUBSCRIPTION);
      const targetId = subscriptionTarget;
      const target = yield* targetOf(alerts, targetId);
      assert.deepStrictEqual(target?.addedBy, { connectionId: CONNECTION, name: "Dots" });
      assert.strictEqual(
        target?.expiresAt,
        new Date((yield* Clock.currentTimeMillis) + 7 * 24 * HOUR_MS).toISOString(),
      );

      const refused = "An assistant's subscription can only be removed.";
      const detailOf = <A>(effect: Effect.Effect<A, { readonly detail: string }>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.detail),
        );
      assert.strictEqual(yield* detailOf(alerts.secret({ targetId })), refused);
      assert.strictEqual(yield* detailOf(alerts.test({ targetId })), refused);
      assert.strictEqual(yield* detailOf(alerts.setOn({ targetId, on: false })), refused);
      assert.strictEqual(
        yield* detailOf(
          alerts.update({
            targetId,
            url: CALLBACK,
            kinds: ["finished"],
            projectIds: null,
            skipViewed: false,
            authorization: { kind: "keep" },
          }),
        ),
        refused,
      );

      yield* alerts.remove({ targetId });
      assert.strictEqual(yield* targetOf(alerts, targetId), undefined);
      assert.strictEqual(harness.secrets.size, 0);
      yield* stop;
    }),
  );

  it.effect("a start removes secret entries no row names, and keeps the rest", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = yield* harness.boot;
      yield* first.alerts.subscribe(SUBSCRIPTION);
      yield* createTarget(first.alerts);
      const kept = [...harness.secrets.keys()].toSorted();
      yield* first.stop;

      // A rotation a crash cut short: the new key written, the row not moved to it.
      harness.secrets.set(`assistant-alert-${subscriptionTarget}-signing-abcd1234`, KEY_B);
      harness.secrets.set("relay-signing-key", KEY_C);
      const second = yield* harness.boot;
      assert.deepStrictEqual(
        [...harness.secrets.keys()].toSorted(),
        [...kept, "relay-signing-key"].toSorted(),
      );
      // The subscription still signs with its key.
      yield* harness.record("thread.finished");
      yield* settle();
      const delivery = deliveriesIn(harness.calls).find(
        (call) => call.headers["x-mcp-subscription-id"] !== undefined,
      )!;
      assert.strictEqual(
        delivery.headers["webhook-signature"],
        signWebhook({
          secret: KEY_A,
          id: delivery.headers["webhook-id"]!,
          timestamp: Number(delivery.headers["webhook-timestamp"]),
          body: delivery.body,
        }),
      );
      yield* second.stop;
    }),
  );
});
