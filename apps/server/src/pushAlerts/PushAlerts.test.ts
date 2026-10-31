// @effect-diagnostics nodeBuiltinImport:off
import { createDecipheriv, createECDH, createHmac } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type RelayDeviceAlertInput,
  ThreadId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { LinkRequestRepository, type LinkRequestRow } from "../links/LinkRequestRepository.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RelayHost } from "../relay/RelayHost.ts";
import { PushAlerts, PushAlertsLive } from "./PushAlerts.ts";
import { FINISHED_HOLD_MS } from "./pushAlertRules.ts";

const THREAD = ThreadId.make("thread-1");
const PHONE_SESSION = AuthSessionId.make("session-phone");
const PHONE = "device-phone";

/** The phone's side of RFC 8291: what an alert says once it arrives. */
function openAlert(body: string, receiverPrivateKey: Buffer, auth: Buffer) {
  const hmac = (key: Uint8Array, data: Uint8Array) =>
    createHmac("sha256", key).update(data).digest();
  const bytes = Buffer.from(body, "base64url");
  const salt = bytes.subarray(0, 16);
  const senderKey = bytes.subarray(21, 21 + bytes.readUInt8(20));
  const sealed = bytes.subarray(21 + bytes.readUInt8(20));
  const receiver = createECDH("prime256v1");
  receiver.setPrivateKey(receiverPrivateKey);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0", "latin1"),
    receiver.getPublicKey(),
    senderKey,
    Buffer.of(1),
  ]);
  const prk = hmac(salt, hmac(hmac(auth, receiver.computeSecret(senderKey)), info));
  const key = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(0x02)).toString("utf8")) as {
    readonly notification: {
      readonly title: string;
      readonly body: string;
      readonly navigate: string;
    };
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD,
    title: "Fix the build",
    activities: [],
    proposedPlans: [],
    latestTurn: null,
    session: null,
    queuedFollowUps: [],
    sideTurn: null,
    childRequests: {
      open: [],
      deliveryEpoch: 0,
      startsSinceUser: 0,
      sendsSinceUser: 0,
      pendingNotes: [],
    },
    ...overrides,
  } as unknown as OrchestrationThread;
}

/**
 * A computer with one paired phone: the event log, the thread as the
 * projections read it, and the relay are fakes the test drives.
 */
const makeHarness = Effect.gen(function* () {
  const events: OrchestrationEvent[] = [];
  const published = yield* PubSub.unbounded<OrchestrationEvent>();
  const sent: RelayDeviceAlertInput[] = [];
  const state = {
    thread: makeThread(),
    phoneActive: true,
    failReads: 0,
    linkRows: [] as Array<Partial<LinkRequestRow>>,
  };
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = Buffer.alloc(16, 9);

  const layer = PushAlertsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          readEvents: (after) => Stream.fromIterable(events.filter((e) => e.sequence > after)),
          streamDomainEvents: Stream.fromPubSub(published),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () =>
            state.failReads > 0
              ? Effect.suspend(() => {
                  state.failReads -= 1;
                  return Effect.fail(new Error("database is locked") as never);
                })
              : Effect.succeed(Option.some(state.thread)),
        }),
        Layer.mock(RelayHost)({
          admitDirect: () => null,
          activeClientDeviceForSession: (sessionId) =>
            Effect.succeed(sessionId === PHONE_SESSION && state.phoneActive ? PHONE : null),
          isActiveClientDevice: () => Effect.succeed(state.phoneActive),
          sendDeviceAlert: (_deviceId, input) =>
            Effect.sync(() => {
              sent.push(input);
              return { outcome: "sent" as const };
            }),
        }),
        Layer.mock(LinkRequestRepository)({
          listByThread: () => Effect.sync(() => state.linkRows as never),
        }),
        ServerEnvironment.layerTest({
          environmentId: EnvironmentId.make("env-mac"),
          label: "Studio Mac",
        }),
      ),
    ),
    Layer.provide(SqlitePersistenceMemory),
  );
  const context = yield* Layer.build(layer);
  return { events, published, sent, state, receiver, auth, context };
});

let sequence = 0;
const appended = (
  harness: Effect.Success<typeof makeHarness>,
  type: OrchestrationEvent["type"],
  payload: object,
) =>
  Effect.gen(function* () {
    sequence += 1;
    const event = {
      sequence,
      eventId: EventId.make(`event-${sequence}`),
      type,
      aggregateKind: "thread",
      aggregateId: THREAD,
      occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      commandId: CommandId.make(`command-${sequence}`),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload,
    } as OrchestrationEvent;
    harness.events.push(event);
    yield* PubSub.publish(harness.published, event);
  });

/** Lets the alert loops run: time moves on in small steps. */
const settle = (ms = 500) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
    }
  });

it.layer(NodeServices.layer)("PushAlerts", (it) => {
  it.effect("alerts a phone once for each approval, sealed for that phone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const pushAlerts = yield* PushAlerts.pipe(Effect.provide(harness.context));
        yield* TestClock.adjust("1 hour");
        yield* pushAlerts.start();
        yield* settle();
        yield* pushAlerts.register(PHONE_SESSION, {
          registrationId: "registration-1",
          p256dh: harness.receiver.getPublicKey().toString("base64url"),
          auth: harness.auth.toString("base64url"),
          keyId: "key-nightly",
          appOrigin: "https://nightly.app.threadlines.dev",
        });

        const requested = {
          threadId: THREAD,
          activity: {
            id: "activity-1",
            tone: "approval",
            kind: "approval.requested",
            summary: "Run a command",
            payload: { requestId: "request-1" },
            turnId: "turn-1",
            createdAt: "2026-10-23T12:00:00.000Z",
          },
        };
        harness.state.thread = makeThread({ activities: [requested.activity] as never });
        yield* appended(harness, "thread.activity-appended", requested);
        yield* settle();

        assert.strictEqual(harness.sent.length, 1);
        const [alert] = harness.sent;
        assert.strictEqual(alert!.kind, "needs_you");
        assert.strictEqual(alert!.registrationId, "registration-1");
        assert.strictEqual(alert!.urgency, "high");
        assert.deepStrictEqual(
          openAlert(alert!.payload, harness.receiver.getPrivateKey(), harness.auth).notification,
          {
            title: "Fix the build",
            body: "Needs your approval · Studio Mac",
            navigate: "https://nightly.app.threadlines.dev/env-mac/thread-1",
          },
        );

        // The same request read again (a replayed event) alerts no one twice.
        yield* PubSub.publish(harness.published, harness.events[0]!);
        yield* settle();
        assert.strictEqual(harness.sent.length, 1);
      }),
    ),
  );

  it.effect("waits on a finished turn and sends nothing when more work followed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const pushAlerts = yield* PushAlerts.pipe(Effect.provide(harness.context));
        yield* TestClock.adjust("1 hour");
        yield* pushAlerts.start();
        yield* settle();
        yield* pushAlerts.register(PHONE_SESSION, {
          registrationId: "registration-1",
          p256dh: harness.receiver.getPublicKey().toString("base64url"),
          auth: harness.auth.toString("base64url"),
          keyId: "key-nightly",
          appOrigin: "https://nightly.app.threadlines.dev",
        });

        const completed = (turnId: string) =>
          appended(harness, "thread.turn-completed", {
            threadId: THREAD,
            turnId,
            state: "completed",
            completedAt: "2026-10-23T12:00:00.000Z",
          });

        // turn-1 finished, but a queued message started turn-2 meanwhile.
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-2", state: "running" } as never,
        });
        yield* completed("turn-1");
        yield* settle(FINISHED_HOLD_MS + 1_000);
        assert.strictEqual(harness.sent.length, 0);

        // turn-2 finished with nothing left to do: one "finished" alert, after the hold.
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-2", state: "completed" } as never,
        });
        yield* completed("turn-2");
        yield* settle(FINISHED_HOLD_MS - 2_000);
        assert.strictEqual(harness.sent.length, 0);
        yield* settle(3_000);
        assert.strictEqual(harness.sent.length, 1);
        assert.strictEqual(harness.sent[0]!.kind, "finished");
      }),
    ),
  );

  it.effect("tries again when the thread can't be read, instead of losing the alert", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const pushAlerts = yield* PushAlerts.pipe(Effect.provide(harness.context));
        yield* TestClock.adjust("1 hour");
        yield* pushAlerts.start();
        yield* settle();
        yield* pushAlerts.register(PHONE_SESSION, {
          registrationId: "registration-1",
          p256dh: harness.receiver.getPublicKey().toString("base64url"),
          auth: harness.auth.toString("base64url"),
          keyId: "key-nightly",
          appOrigin: "https://nightly.app.threadlines.dev",
        });

        harness.state.failReads = 1;
        yield* appended(harness, "thread.turn-completed", {
          threadId: THREAD,
          turnId: "turn-1",
          state: "error",
          completedAt: "2026-10-23T12:00:00.000Z",
        });
        yield* settle(4_000);
        assert.strictEqual(harness.sent.length, 0);
        yield* settle(6_000);
        assert.strictEqual(harness.sent.length, 1);
        assert.strictEqual(harness.sent[0]!.kind, "failed");
      }),
    ),
  );

  it.effect("stays quiet for a thread someone is looking at, and for a removed phone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const pushAlerts = yield* PushAlerts.pipe(Effect.provide(harness.context));
        yield* TestClock.adjust("1 hour");
        yield* pushAlerts.start();
        yield* settle();
        yield* pushAlerts.register(PHONE_SESSION, {
          registrationId: "registration-1",
          p256dh: harness.receiver.getPublicKey().toString("base64url"),
          auth: harness.auth.toString("base64url"),
          keyId: "key-nightly",
          appOrigin: "https://nightly.app.threadlines.dev",
        });
        const failed = (turnId: string) =>
          appended(harness, "thread.turn-completed", {
            threadId: THREAD,
            turnId,
            state: "error",
            completedAt: "2026-10-23T12:00:00.000Z",
          });

        yield* pushAlerts.setViewing("desktop-window", THREAD);
        yield* failed("turn-1");
        yield* settle(5_000);
        assert.strictEqual(harness.sent.length, 0);

        yield* pushAlerts.releaseViewer("desktop-window");
        harness.state.phoneActive = false;
        yield* failed("turn-2");
        yield* settle(5_000);
        assert.strictEqual(harness.sent.length, 0);
        // The removed phone's keys are gone, so registering is refused too.
        const refused = yield* pushAlerts.sendTest(PHONE_SESSION).pipe(Effect.flip);
        assert.strictEqual(refused.code, "not-a-paired-phone");
      }),
    ),
  );
  it.effect("leaves a child's alert to the thread that asked, once it has the result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const pushAlerts = yield* PushAlerts.pipe(Effect.provide(harness.context));
        yield* TestClock.adjust("1 hour");
        yield* pushAlerts.start();
        yield* settle();
        yield* pushAlerts.register(PHONE_SESSION, {
          registrationId: "registration-1",
          p256dh: harness.receiver.getPublicKey().toString("base64url"),
          auth: harness.auth.toString("base64url"),
          keyId: "key-nightly",
          appOrigin: "https://nightly.app.threadlines.dev",
        });
        harness.state.thread = makeThread({
          remoteOrigin: { linkDeviceId: "device-asker" } as never,
        });
        const nowIso = () =>
          Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
        const activity = (id: string, kind: string, turnId: string | null) =>
          appended(harness, "thread.activity-appended", {
            threadId: THREAD,
            activity: { id, tone: "error", kind, summary: "It stopped", payload: {}, turnId },
          });

        // A restart cut the child's first turn off before it had an id; the
        // report stays unclaimed until the asking computer takes it.
        const report = {
          reportId: "report-1",
          turnId: null,
          reportTurnId: null,
          settledAt: yield* nowIso(),
          deliveredAt: null as string | null,
        };
        harness.state.linkRows = [report];
        yield* activity("activity-restart", "provider.session.restart-interrupted", "turn-1");
        yield* settle(6_000);
        assert.strictEqual(harness.sent.length, 0);
        report.deliveredAt = yield* nowIso();
        yield* settle(70_000);
        assert.strictEqual(harness.sent.length, 0);

        // That old report says nothing about a later start that failed.
        yield* TestClock.adjust("5 minutes");
        yield* activity("activity-start", "provider.turn.start.failed", null);
        yield* settle(5_000);
        assert.strictEqual(harness.sent.length, 1);
        assert.strictEqual(harness.sent[0]!.kind, "failed");

        // A report the asking computer never takes (it's offline): the alert goes out.
        harness.state.linkRows = [
          report,
          {
            reportId: "report-3",
            turnId: "turn-3" as never,
            reportTurnId: "turn-3",
            settledAt: yield* nowIso(),
            deliveredAt: null,
          },
        ];
        yield* appended(harness, "thread.turn-completed", {
          threadId: THREAD,
          turnId: "turn-3",
          state: "error",
          completedAt: "2026-10-23T12:00:00.000Z",
        });
        yield* settle(30_000);
        assert.strictEqual(harness.sent.length, 1);
        yield* settle(40_000);
        assert.strictEqual(harness.sent.length, 2);

        // A child here: its parent took turn 4's result before the turn's
        // final capture started the alert.
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-4", state: "completed" } as never,
          handedBackTurnId: "turn-4" as never,
        });
        yield* appended(harness, "thread.turn-diff-completed", {
          threadId: THREAD,
          turnId: "turn-4",
          checkpointTurnCount: 4,
          checkpointRef: "refs/threadlines/checkpoints/4",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: yield* nowIso(),
          completesTurn: true,
        });
        yield* settle(FINISHED_HOLD_MS + 2_000);
        assert.strictEqual(harness.sent.length, 2);
      }),
    ),
  );
});
