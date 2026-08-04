import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  make,
  PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES,
  type PreviewAutomationBrokerService,
} from "./PreviewAutomationBroker.ts";

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
    readonly operations?: ReadonlyArray<"click" | "snapshot">;
  },
) {
  const requests = yield* broker.connect({
    threadId: options?.threadId ?? threadId,
    hostId: "host-1",
    operations: options?.operations ?? ["click", "snapshot"],
  });
  const pull = yield* Stream.toPull(requests);
  const nextRequest = pull.pipe(
    Effect.map((batch) => batch[0]),
    Effect.orDie,
  );
  return { nextRequest };
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
          .pipe(Effect.flip);
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
          .pipe(Effect.flip);
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
        const failure = yield* Fiber.join(call).pipe(Effect.flip);
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
        const failure = yield* Fiber.join(call).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PreviewAutomationTimeoutError");
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

        yield* broker.connect({ threadId, hostId: "host-2", operations: ["click"] });
        const failure = yield* Fiber.join(call).pipe(Effect.flip);
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
        const failure = yield* Fiber.join(call).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PreviewAutomationResultTooLargeError");
      }),
    ),
  );

  it.effect("keeps one thread's browser out of another thread's calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        yield* attachHost(broker);

        const failure = yield* broker
          .invoke({ threadId: otherThreadId, agentId, operation: "click", input: {} })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PreviewAutomationNoHostError");
        assert.isTrue(yield* broker.hasHost(threadId));
        assert.isFalse(yield* broker.hasHost(otherThreadId));
      }),
    ),
  );
});
