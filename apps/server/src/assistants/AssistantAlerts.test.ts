import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AssistantAlertTarget,
  type AssistantAlertTargetId,
  ProjectId,
  ThreadId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { checkOutboundUrl, type OutboundResult } from "../net/outboundHttps.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PushAlerts } from "../pushAlerts/PushAlerts.ts";
import {
  AssistantAlertRepository,
  AssistantAlertRepositoryLive,
} from "./AssistantAlertRepository.ts";
import { AssistantAlerts, type AssistantAlertsShape } from "./AssistantAlerts.ts";
import { type AlertTransport, makeAssistantAlertsLayer } from "./AssistantAlertsLive.ts";
import {
  type AssistantEvent,
  type AssistantEventName,
  AssistantEvents,
  type AssistantEventsShape,
} from "./AssistantEvents.ts";
import { parseWebhookSecret, signWebhook } from "./webhookSigning.ts";

const THREAD = ThreadId.make("thread-1");
const VIEWED_THREAD = ThreadId.make("thread-viewed");
const PROJECT = ProjectId.make("project-app");
const URL_TEXT = "https://alerts.example/hook";

interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

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
  const recorded = yield* PubSub.unbounded<void>();
  const storage = yield* Layer.build(SqlitePersistenceMemory);

  const position = Effect.sync(() => ({
    recordId: "record-1",
    running: true,
    lastSeq: events.at(-1)?.seq ?? 0,
    prunedThroughSeq: 0,
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
          : { event, stands: stands.get(seq) ?? true, project: "app" };
      }),
    keep: (use) => Effect.flatMap(position, use),
    changes: Stream.fromPubSub(recorded),
    start: () => Effect.void,
  };
  const transport: AlertTransport = {
    check: (url) => Effect.sync(() => checkOutboundUrl(url)),
    post: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return answers.shift() ?? { type: "answered", status: 200, retryAfterSeconds: undefined };
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
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
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
    options: { readonly threadId?: ThreadId; readonly stands?: boolean | "unknown" } = {},
  ) =>
    Effect.gen(function* () {
      seq += 1;
      events.push({
        eventId: `event-${seq}`,
        seq,
        name,
        reason: name === "thread.needs_you" ? "approval" : "finished",
        threadId: options.threadId ?? THREAD,
        projectId: PROJECT,
        occurredAt: "2026-10-31T10:00:00.000Z",
        recordedAt: "2026-10-31T10:00:08.000Z",
        resolvedAt: null,
        resolvedReason: null,
      });
      if (options.stands !== undefined) stands.set(seq, options.stands);
      yield* PubSub.publish(recorded, undefined);
      return seq;
    });

  return { boot, calls, answers, record: record_, stands, secrets };
});

/** Lets the sender's loop run: time moves on in small steps. */
const settle = (ms = 500) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
    }
  });

const bodyOf = (call: Call) => JSON.parse(call.body) as Record<string, unknown>;

const targetOf = (alerts: AssistantAlertsShape, targetId: AssistantAlertTargetId) =>
  alerts.targets.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((emitted) =>
      emitted[0]!.find((target: AssistantAlertTarget) => target.targetId === targetId),
    ),
    Effect.orDie,
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
          { type: "answered", status: 503, retryAfterSeconds: undefined },
          { type: "answered", status: 200, retryAfterSeconds: undefined },
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
        const refused = { type: "answered", status: 401, retryAfterSeconds: undefined } as const;
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

        harness.answers.push({ type: "answered", status: 410, retryAfterSeconds: undefined });
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
      harness.answers.push({ type: "answered", status: 503, retryAfterSeconds: undefined });
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
});
