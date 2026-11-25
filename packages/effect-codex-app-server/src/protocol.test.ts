import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode Codex App Server message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode Codex App Server message");
    }),
  );

  it.effect("keeps reading responses while an inbound request handler is pending", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () =>
          Deferred.succeed(requestStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRequest)),
            Effect.as({ answers: {} }),
          ),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 77,
          method: "item/tool/requestUserInput",
          params: {
            itemId: "item-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
          },
        }),
      );
      yield* Deferred.await(requestStarted);

      const pendingInterrupt = yield* transport
        .request("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" })
        .pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      });

      yield* Queue.offer(input, encodeJsonl({ id: 1, result: {} }));
      assert.deepEqual(yield* Fiber.join(pendingInterrupt), {});

      yield* Deferred.succeed(releaseRequest, undefined);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 77,
        result: { answers: {} },
      });
    }),
  );

  it.effect("tells a request's caller-chosen hook its id when the caller stops waiting", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
      const abandoned: Array<number> = [];

      const sample = yield* transport
        .request(
          "thread/sample",
          { threadId: "thread-1", expectedTurnId: "turn-1", prompt: "Next?" },
          { onAbandon: (requestId) => Effect.sync(() => void abandoned.push(requestId)) },
        )
        .pipe(Effect.forkScoped);
      const sent = (yield* decodeJson(yield* Queue.take(output))) as { readonly id: number };
      yield* Fiber.interrupt(sample);
      assert.deepEqual(abandoned, [sent.id]);

      // A late answer to it is dropped, and the next request still gets its own.
      yield* Queue.offer(input, encodeJsonl({ id: sent.id, result: { text: "late" } }));
      const next = yield* transport.request("thread/list", {}).pipe(Effect.forkScoped);
      const nextSent = (yield* decodeJson(yield* Queue.take(output))) as { readonly id: number };
      yield* Queue.offer(input, encodeJsonl({ id: nextSent.id, result: { data: [] } }));
      assert.deepEqual(yield* Fiber.join(next), { data: [] });
      // One that was answered never reaches the hook.
      assert.deepEqual(abandoned, [sent.id]);
    }),
  );

  it.effect(
    "reassembles multi-chunk CRLF lines and respects independent bufferNotifications/bufferRequests flags",
    () =>
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const received: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
        const secondReceived = yield* Deferred.make<void>();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          bufferNotifications: false,
          onNotification: (notification) =>
            Effect.gen(function* () {
              received.push(notification);
              if (received.length >= 2) {
                yield* Deferred.succeed(secondReceived, undefined);
              }
            }),
        });

        const payload = `${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "abc" } })}\r\n${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "def" } })}\n`;
        // Split right across the CRLF boundary and mid-JSON.
        const split1 = payload.indexOf("\r") + 1;
        yield* Queue.offer(input, encoder.encode(payload.slice(0, 12)));
        yield* Queue.offer(input, encoder.encode(payload.slice(12, split1)));
        yield* Queue.offer(input, encoder.encode(payload.slice(split1)));
        yield* Queue.offer(
          input,
          encodeJsonl({ id: 77, method: "item/tool/requestUserInput", params: {} }),
        );
        yield* Deferred.await(secondReceived);

        assert.equal(received.length, 2);
        assert.deepEqual(received[0]?.params, { delta: "abc" });
        assert.deepEqual(received[1]?.params, { delta: "def" });

        // Notifications were opt-out buffered, so incomingNotifications stays empty.
        const bufferedNotificationFiber = yield* transport.incomingNotifications.pipe(
          Stream.runHead,
          Effect.timeoutOption("50 millis"),
          Effect.forkScoped,
        );
        yield* TestClock.adjust("100 millis");
        const bufferedNotification = yield* Fiber.join(bufferedNotificationFiber);
        assert.equal(bufferedNotification._tag, "None");

        // Requests keep their default buffering when only bufferNotifications is false.
        const bufferedRequest = yield* transport.incomingRequests.pipe(Stream.runHead);
        assert.equal(bufferedRequest._tag, "Some");
        if (bufferedRequest._tag === "Some") {
          assert.equal(bufferedRequest.value.id, 77);
        }
      }),
  );
});
