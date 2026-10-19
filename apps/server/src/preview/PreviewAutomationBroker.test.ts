import { assert, describe, it } from "@effect/vitest";
import {
  ThreadId,
  type PreviewAutomationHostFeature,
  type PreviewAutomationHostMessage,
  type PreviewAutomationRequest,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  make,
  PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES,
  PREVIEW_AUTOMATION_SCREENSHOT_LIMIT_BYTES,
  type PreviewAutomationBrokerService,
} from "./PreviewAutomationBroker.ts";

/** The failure a call ends with; its result is never read. */
const failureOf = <E, R>(call: Effect.Effect<unknown, E, R>) =>
  call.pipe(Effect.asVoid, Effect.flip);

const threadId = ThreadId.make("thread-browser-a");
const otherThreadId = ThreadId.make("thread-browser-b");
const agentId = "agent-browser-a";

/**
 * Connects a host and hands back a way to await the next request it is sent.
 *
 * Pulled rather than pumped into an array: the call is offered on one fiber and
 * delivered on another, and asserting on an array between the two is how you
 * write a test that passes on a fast machine and fails on a busy one. Pulling
 * blocks until the request actually arrives, and it does so without a clock,
 * which these tests have replaced with a fake one.
 */
const attachHost = Effect.fn(function* (
  broker: PreviewAutomationBrokerService,
  options?: {
    readonly threadId?: ThreadId;
    readonly operations?: ReadonlyArray<"click" | "snapshot" | "waitFor" | "screenshot">;
    readonly features?: ReadonlyArray<PreviewAutomationHostFeature>;
  },
) {
  const messages = yield* broker.connect({
    threadId: options?.threadId ?? threadId,
    hostId: "host-1",
    operations: options?.operations ?? ["click", "snapshot"],
    ...(options?.features === undefined ? {} : { features: options.features }),
  });
  const pull = yield* Stream.toPull(messages);
  const nextMessage = pull.pipe(
    Effect.map((batch): PreviewAutomationHostMessage | undefined => batch[0]),
    Effect.orDie,
  );
  const nextRequest = nextMessage.pipe(
    Effect.map((message): PreviewAutomationRequest => {
      if (message === undefined || "_tag" in message) {
        throw new Error(`expected a request, got ${JSON.stringify(message)}`);
      }
      return message;
    }),
  );
  return { nextMessage, nextRequest };
});

/** A client-wide host in its own scope, so a test can make it leave. */
const attachClient = Effect.fn(function* (
  broker: PreviewAutomationBrokerService,
  hostId: string,
  machineLocal: boolean,
  features: ReadonlyArray<PreviewAutomationHostFeature> = ["cancel"],
) {
  const scope = yield* Scope.make();
  const messages = yield* broker
    .connectClient({
      hostId,
      operations: ["click", "snapshot"],
      features,
      machineLocal,
    })
    .pipe(Scope.provide(scope));
  const pull = yield* Stream.toPull(messages).pipe(Scope.provide(scope));
  const nextMessage = pull.pipe(
    Effect.map((batch): PreviewAutomationHostMessage | undefined => batch[0]),
    Effect.orDie,
  );
  return { nextMessage, leave: Scope.close(scope, Exit.void) };
});

describe("PreviewAutomationBroker", () => {
  it.effect("carries a call to the connected browser and its answer back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextRequest } = yield* attachHost(broker);

        const call = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: { target: { ref: 3 } } })
          .pipe(Effect.forkChild);

        const request = yield* nextRequest;
        assert.strictEqual(request.operation, "click");
        assert.strictEqual(request.agentId, agentId);
        assert.deepStrictEqual(request.input, { target: { ref: 3 } });

        yield* broker.respond({ requestId: request.requestId, result: { ok: true } });
        const result = yield* Fiber.join(call);
        assert.deepStrictEqual(result, { ok: true });
      }),
    ),
  );

  it.effect("tells the agent to ask for a browser when no one is showing the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const failure = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationNoHostError");
      }),
    ),
  );

  it.effect("refuses an operation the connected browser did not offer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        yield* attachHost(broker, { operations: ["snapshot"] });

        // Answered immediately rather than sent and waited on: an old client that
        // silently drops the request would otherwise cost a full timeout.
        const failure = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationUnsupportedError");
      }),
    ),
  );

  it.effect("carries a page's refusal through as a failure, not a result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextRequest } = yield* attachHost(broker);
        const call = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(Effect.forkChild);
        const request = yield* nextRequest;
        yield* broker.respond({ requestId: request.requestId, error: "no element matched" });
        const failure = yield* Fiber.join(call).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationExecutionError");
        assert.include(failure.message, "no element matched");
      }),
    ),
  );

  it.effect("gives up on a browser that never answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        yield* attachHost(broker);
        const call = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {}, timeoutMs: 5_000 })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* TestClock.adjust("6 seconds");
        const failure = yield* Fiber.join(call).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationTimeoutError");
      }),
    ),
  );

  it.effect("tells a client that can hear it to drop a request it gave up on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextMessage, nextRequest } = yield* attachHost(broker, { features: ["cancel"] });
        const call = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {}, timeoutMs: 5_000 })
          .pipe(Effect.forkChild);
        const request = yield* nextRequest;

        yield* TestClock.adjust("6 seconds");
        const failure = yield* Fiber.join(call).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationTimeoutError");
        // Otherwise the click is still queued behind whatever stalled, and lands
        // after the agent has been told it failed and has tried again.
        assert.deepStrictEqual(yield* nextMessage, {
          _tag: "cancel",
          requestId: request.requestId,
        });
      }),
    ),
  );

  it.effect("sends an older client nothing it cannot read when a request times out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextMessage, nextRequest } = yield* attachHost(broker);
        const first = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {}, timeoutMs: 5_000 })
          .pipe(Effect.forkChild);
        yield* nextRequest;
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(first).pipe(failureOf);

        // The next thing down the wire is the next request, not a cancel the old
        // client would fail to decode and drop its subscription over.
        yield* broker
          .invoke({ threadId, agentId, operation: "snapshot", input: {} })
          .pipe(Effect.forkChild);
        const message = yield* nextMessage;
        assert.strictEqual(
          message !== undefined && "operation" in message && message.operation,
          "snapshot",
        );
      }),
    ),
  );

  it.effect("lets a wait run as long as the agent asked before timing it out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextRequest } = yield* attachHost(broker, { operations: ["waitFor"] });
        const call = yield* broker
          .invoke({
            threadId,
            agentId,
            operation: "waitFor",
            input: { text: "Saved", timeoutMs: 30_000 },
          })
          .pipe(Effect.forkChild);
        const request = yield* nextRequest;

        // Past the ordinary twenty seconds, still inside the thirty it asked for.
        yield* TestClock.adjust("25 seconds");
        yield* broker.respond({ requestId: request.requestId, result: { ok: true } });
        assert.deepStrictEqual(yield* Fiber.join(call), { ok: true });
      }),
    ),
  );

  it.effect("waits for the user once a request says it is asking them, but only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextRequest } = yield* attachHost(broker, { features: ["cancel"] });
        const call = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(Effect.forkChild);
        const request = yield* nextRequest;

        yield* broker.progress({ requestId: request.requestId, awaitingUser: true });
        // Long past the usual twenty seconds, and still waiting.
        yield* TestClock.adjust("4 minutes");
        assert.isUndefined(call.pollUnsafe());
        // Saying so again buys nothing more: five minutes from the first note.
        yield* broker.progress({ requestId: request.requestId, awaitingUser: true });
        yield* TestClock.adjust("90 seconds");

        const failure = yield* Fiber.join(call).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationTimeoutError");
        assert.include(failure.message, "did not answer in time");
      }),
    ),
  );

  it.effect(
    "gives a thread nobody holds to the client on the server's machine, and keeps it there",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          const local = yield* attachClient(broker, "mac", true);
          // Newer, but on another computer: its localhost is not the agent's.
          yield* attachClient(broker, "windows", false);

          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          const first = yield* local.nextMessage;
          assert.deepInclude(first, { threadId, operation: "click" });

          yield* attachClient(broker, "mac-2", true);
          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          // The thread's tabs are on the first machine; a newer client does not take them.
          assert.deepInclude(yield* local.nextMessage, { threadId, operation: "snapshot" });
        }),
      ),
  );

  it.effect("moves a thread to the client that opened its browser, and tells the old one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const mac = yield* attachClient(broker, "mac", true);
        const windows = yield* attachClient(broker, "windows", false);
        const inFlight = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(Effect.forkChild);
        yield* mac.nextMessage;

        yield* broker.claim({ hostId: "windows", threadId });

        // The click was headed for pages the user is no longer looking at.
        const failure = yield* Fiber.join(inFlight).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationDisconnectedError");
        assert.deepStrictEqual(yield* mac.nextMessage, { _tag: "release", threadId });
        yield* broker
          .invoke({ threadId, agentId, operation: "snapshot", input: {} })
          .pipe(Effect.forkChild);
        assert.deepInclude(yield* windows.nextMessage, { threadId, operation: "snapshot" });
      }),
    ),
  );

  it.effect("keeps a claim that arrives before the client's host does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        yield* attachClient(broker, "mac", true);
        // The panel's claim and the host's subscription travel separately.
        yield* broker.claim({ hostId: "windows", threadId });
        const windows = yield* attachClient(broker, "windows", false);

        yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(Effect.forkChild);
        assert.deepInclude(yield* windows.nextMessage, { threadId, operation: "click" });
      }),
    ),
  );

  it.effect("finds a thread a new home when the client holding it leaves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const mac = yield* attachClient(broker, "mac", true);
        const windows = yield* attachClient(broker, "windows", false);
        yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(Effect.forkChild);
        yield* mac.nextMessage;

        yield* mac.leave;
        yield* broker
          .invoke({ threadId, agentId, operation: "snapshot", input: {} })
          .pipe(Effect.forkChild);
        assert.deepInclude(yield* windows.nextMessage, { threadId, operation: "snapshot" });
      }),
    ),
  );

  it.effect("settles calls in flight when the browser goes away", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        // A second connection for the same thread is a reload or a second window;
        // the first one's calls have to stop waiting rather than hang until they
        // time out on a client that is no longer listening.
        yield* attachHost(broker);
        const call = yield* broker
          .invoke({ threadId, agentId, operation: "click", input: {} })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        // Only host-2 arriving matters here, not its messages.
        yield* broker
          .connect({ threadId, hostId: "host-2", operations: ["click"] })
          .pipe(Effect.asVoid);
        const failure = yield* Fiber.join(call).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationDisconnectedError");
      }),
    ),
  );

  it.effect("refuses a result too large to carry rather than truncating it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextRequest } = yield* attachHost(broker);
        const call = yield* broker
          .invoke({ threadId, agentId, operation: "snapshot", input: {} })
          .pipe(Effect.forkChild);
        const request = yield* nextRequest;
        yield* broker.respond({
          requestId: request.requestId,
          result: { page: "x".repeat(PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES + 1) },
        });
        const failure = yield* Fiber.join(call).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationResultTooLargeError");
      }),
    ),
  );

  it.effect("carries a screenshot past the text limit, and refuses only an absurd one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const { nextRequest } = yield* attachHost(broker, { operations: ["screenshot"] });
        /** A screenshot call the browser answers with `data`, still to be joined. */
        const screenshot = (data: string) =>
          Effect.gen(function* () {
            const call = yield* broker
              .invoke({ threadId, agentId, operation: "screenshot", input: {} })
              .pipe(Effect.forkChild);
            const request = yield* nextRequest;
            yield* broker.respond({
              requestId: request.requestId,
              result: { data, width: 1280, height: 800, mimeType: "image/jpeg" },
            });
            return call;
          });

        // A busy page as JPEG: over what a text result may be, and fine as a picture.
        const busyData = "x".repeat(PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES + 1);
        const busy = (yield* Fiber.join(yield* screenshot(busyData))) as Record<string, unknown>;
        assert.strictEqual(busy.data, busyData);
        assert.strictEqual(busy.mimeType, "image/jpeg");

        const absurd = yield* screenshot("x".repeat(PREVIEW_AUTOMATION_SCREENSHOT_LIMIT_BYTES));
        const failure = yield* Fiber.join(absurd).pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationResultTooLargeError");
        // A screenshot has nothing to narrow; the advice has to be something
        // the agent can actually do.
        assert.notInclude(failure.message, "Narrow the request");
        assert.include(failure.message, "browser_resize");
      }),
    ),
  );

  describe("following the user between computers", () => {
    const TUNNEL: ReadonlyArray<PreviewAutomationHostFeature> = ["cancel", "loopbackTunnel"];
    const minutes = (count: number) => count * 60_000;

    it.effect("opens a new browser on the computer the user used last", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          yield* attachClient(broker, "mac", true);
          const windows = yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.active({ hostId: "mac", idleMs: minutes(50) });
          yield* broker.active({ hostId: "windows", idleMs: 2_000 });

          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          assert.deepInclude(yield* windows.nextMessage, { threadId, operation: "click" });
        }),
      ),
    );

    it.effect(
      "leaves a browser on the server's machine when the other computer can't reach its localhost",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* make;
            yield* TestClock.adjust("1 hour");
            const mac = yield* attachClient(broker, "mac", true);
            // Connected over the relay, say: no tunnel offered.
            yield* attachClient(broker, "windows", false);
            yield* broker.active({ hostId: "mac", idleMs: minutes(50) });
            yield* broker.active({ hostId: "windows", idleMs: 0 });

            yield* broker
              .invoke({ threadId, agentId, operation: "click", input: {} })
              .pipe(Effect.forkChild);
            assert.deepInclude(yield* mac.nextMessage, { threadId, operation: "click" });
          }),
        ),
    );

    it.effect("moves a browser to the computer the user moved to, and tells the agent", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          const mac = yield* attachClient(broker, "mac", true);
          const windows = yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.active({ hostId: "mac", idleMs: 0 });

          const first = yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          const onMac = yield* mac.nextMessage;
          assert.deepInclude(onMac, { threadId, operation: "click" });
          assert.notProperty(onMac, "moved");
          yield* broker.respond({ requestId: (onMac as PreviewAutomationRequest).requestId });
          yield* Fiber.join(first);

          // The user walks over to the other computer and stays there.
          yield* TestClock.adjust(minutes(5));
          yield* broker.active({ hostId: "windows", idleMs: 1_000 });

          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          assert.deepStrictEqual(yield* mac.nextMessage, { _tag: "release", threadId });
          const onWindows = yield* windows.nextMessage;
          assert.deepInclude(onWindows, { threadId, operation: "snapshot", moved: true });

          // Said once: the agent has been told.
          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          assert.notProperty(yield* windows.nextMessage, "moved");
        }),
      ),
    );

    it.effect("keeps a browser where it is while the user is still at that computer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          const mac = yield* attachClient(broker, "mac", true);
          yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.active({ hostId: "mac", idleMs: 0 });
          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          const onMac = yield* mac.nextMessage;
          yield* broker.respond({ requestId: (onMac as PreviewAutomationRequest).requestId });

          // Touching the other computer a moment later is not leaving this one.
          yield* TestClock.adjust("30 seconds");
          yield* broker.active({ hostId: "windows", idleMs: 0 });
          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          assert.deepInclude(yield* mac.nextMessage, { threadId, operation: "snapshot" });
        }),
      ),
    );

    it.effect("does not move a browser out from under a call still running there", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          const mac = yield* attachClient(broker, "mac", true);
          const windows = yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.active({ hostId: "mac", idleMs: 0 });
          yield* broker
            .invoke({
              threadId,
              agentId: "agent-slow",
              operation: "click",
              input: {},
              timeoutMs: minutes(10),
            })
            .pipe(Effect.forkChild);
          const running = yield* mac.nextMessage;

          yield* TestClock.adjust(minutes(5));
          yield* broker.active({ hostId: "windows", idleMs: 0 });
          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          const snapshot = yield* mac.nextMessage;
          assert.deepInclude(snapshot, { threadId, operation: "snapshot" });

          // Once nothing is running there, the next call follows the user.
          yield* broker.respond({ requestId: (running as PreviewAutomationRequest).requestId });
          yield* broker.respond({ requestId: (snapshot as PreviewAutomationRequest).requestId });
          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          assert.deepStrictEqual(yield* mac.nextMessage, { _tag: "release", threadId });
          assert.deepInclude(yield* windows.nextMessage, { threadId, operation: "click" });
        }),
      ),
    );

    it.effect("treats a client coming back under its own name as the same browser", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          const before = yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.active({ hostId: "windows", idleMs: 0 });
          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          const first = (yield* before.nextMessage) as PreviewAutomationRequest;
          yield* broker.respond({ requestId: first.requestId });

          // The connection drops and comes back; the old one's goodbye arrives late.
          const after = yield* attachClient(broker, "windows", false, TUNNEL);
          const call = yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          const second = yield* after.nextMessage;
          assert.deepInclude(second, { threadId, operation: "snapshot" });
          // Same pages, same computer: nothing moved.
          assert.notProperty(second, "moved");
          yield* before.leave;
          yield* broker.respond({
            requestId: (second as PreviewAutomationRequest).requestId,
            result: { ok: true },
          });
          assert.deepStrictEqual(yield* Fiber.join(call), { ok: true });
        }),
      ),
    );

    it.effect("keeps a thread with its browser across that client's reconnect", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          yield* attachClient(broker, "mac", true);
          const before = yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.active({ hostId: "windows", idleMs: 0 });
          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          const first = (yield* before.nextMessage) as PreviewAutomationRequest;
          yield* broker.respond({ requestId: first.requestId });

          // Both computers in use; the Mac a moment later. Then Windows drops and comes back.
          yield* TestClock.adjust("20 seconds");
          yield* broker.active({ hostId: "mac", idleMs: 0 });
          yield* before.leave;
          const after = yield* attachClient(broker, "windows", false, TUNNEL);

          // Its pages are still on Windows, so the thread stays there.
          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          const second = yield* after.nextMessage;
          assert.deepInclude(second, { threadId, operation: "snapshot" });
          assert.notProperty(second, "moved");
        }),
      ),
    );

    it.effect("keeps a browser when an unused computer puts the thread back on screen", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* make;
          yield* TestClock.adjust("1 hour");
          const mac = yield* attachClient(broker, "mac", true);
          const windows = yield* attachClient(broker, "windows", false, TUNNEL);
          yield* broker.claim({ hostId: "windows", threadId, idleMs: 0 });

          // The Mac app restarts overnight and restores the thread it showed.
          yield* broker.claim({ hostId: "mac", threadId, idleMs: minutes(40) });
          yield* broker
            .invoke({ threadId, agentId, operation: "click", input: {} })
            .pipe(Effect.forkChild);
          assert.deepInclude(yield* windows.nextMessage, { threadId, operation: "click" });

          // Someone actually opening it on the Mac takes it.
          yield* broker.claim({ hostId: "mac", threadId, idleMs: 0 });
          assert.deepStrictEqual(yield* windows.nextMessage, { _tag: "release", threadId });
          yield* broker
            .invoke({ threadId, agentId, operation: "snapshot", input: {} })
            .pipe(Effect.forkChild);
          assert.deepInclude(yield* mac.nextMessage, { threadId, operation: "snapshot" });
        }),
      ),
    );
  });

  it.effect("keeps one thread's browser out of another thread's calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        yield* attachHost(broker);

        const failure = yield* broker
          .invoke({ threadId: otherThreadId, agentId, operation: "click", input: {} })
          .pipe(failureOf);
        assert.strictEqual(failure._tag, "PreviewAutomationNoHostError");
        assert.isTrue(yield* broker.hasHost(threadId));
        assert.isFalse(yield* broker.hasHost(otherThreadId));
      }),
    ),
  );
});
