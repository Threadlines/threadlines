import * as Path from "effect/Path";
import * as AcpError from "./errors.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio, makeTerminationError, makeChildStdio } from "./_internal/stdio.ts";

const SessionCancelNotification = jsonRpcNotification(
  "session/cancel",
  AcpSchema.CancelNotification,
);
const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);
const ElicitationCompleteNotification = jsonRpcNotification(
  "session/elicitation/complete",
  AcpSchema.ElicitationCompleteNotification,
);
const RequestPermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);
const RequestPermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);
const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));
const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));
const decodeSessionCancelNotification = Schema.decodeEffect(
  Schema.fromJsonString(SessionCancelNotification),
);
const decodeExtRequest = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));
const decodeRequestPermissionResponse = Schema.decodeEffect(
  Schema.fromJsonString(RequestPermissionResponse),
);
const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

const makeHandle = (env?: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const command = ChildProcess.make(process.execPath, [yield* mockPeerPath], {
      cwd: path.join(import.meta.dirname, ".."),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return yield* spawner.spawn(command);
  });

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect(
    "emits exact JSON-RPC notifications and decodes inbound session/update and elicitation completion",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
        });

        const notifications =
          yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
        yield* transport.incoming.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
          Effect.forkScoped,
        );

        yield* transport.notify("session/cancel", { sessionId: "session-1" });
        const outbound = yield* Queue.take(output);
        assert.deepEqual(yield* decodeSessionCancelNotification(outbound), {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        });

        yield* Queue.offer(
          input,
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: {
                sessionUpdate: "plan",
                entries: [
                  {
                    content: "Inspect repository",
                    priority: "high",
                    status: "in_progress",
                  },
                ],
              },
            },
          }),
        );

        yield* Queue.offer(
          input,
          yield* encodeJsonl(ElicitationCompleteNotification, {
            jsonrpc: "2.0",
            method: "session/elicitation/complete",
            params: {
              elicitationId: "elicitation-1",
            },
          }),
        );

        const [update, completion] = yield* Deferred.await(notifications);
        assert.equal(update?._tag, "SessionUpdate");
        assert.equal(completion?._tag, "ElicitationComplete");
      }),
  );

  it.effect("logs outgoing notifications when logOutgoing is enabled", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logOutgoing: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* transport.notify("session/cancel", { sessionId: "session-1" });

      assert.deepEqual(events, [
        {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            _tag: "Notification",
            tag: "session/cancel",
            payload: {
              sessionId: "session-1",
            },
          },
        },
        {
          direction: "outgoing",
          stage: "raw",
          payload:
            '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}\n',
        },
      ]);
    }),
  );

  it.effect("skips outgoing notification logs when logOutgoing is disabled", () =>
    Effect.gen(function* () {
      const { stdio, output } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logOutgoing: false,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* transport.notify("session/cancel", { sessionId: "session-1" });
      const outbound = yield* Queue.take(output);
      assert.deepEqual(yield* decodeSessionCancelNotification(outbound), {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "session-1" },
      });
      assert.deepEqual(events, []);
    }),
  );

  it.effect("fails notification encoding through the declared ACP error channel", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, AcpError.AcpProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode ACP message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, AcpError.AcpProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode ACP message");
    }),
  );

  it.effect("supports generic extension requests over the patched transport", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      const outbound = yield* Queue.take(output);
      // Plain JSON-RPC: no RPC headers for the agent to trip over.
      assert.notInclude(outbound, '"headers"');
      assert.deepEqual(yield* decodeExtRequest(outbound), {
        jsonrpc: "2.0",
        id: 1,
        method: "x/test",
        params: {
          hello: "world",
        },
      });

      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            ok: true,
          },
        }),
      );

      const resolved = yield* Fiber.join(response);
      assert.deepEqual(resolved, { ok: true });
    }),
  );

  it.effect("hands an in-order request's answer over where it was read among the updates", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const seen: Array<string> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: () => Effect.sync(() => void seen.push("update")),
      });
      const update = yield* encodeJsonl(SessionUpdateNotification, {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } },
      });
      const answered = yield* Deferred.make<void>();
      yield* transport.requestInOrder("x/test", { hello: "world" }, (answer) =>
        Effect.sync(() => {
          seen.push(answer._tag === "Success" ? "answer" : "failure");
        }).pipe(Effect.andThen(Deferred.succeed(answered, undefined))),
      );
      // Returns once the request is out, before any answer.
      assert.deepEqual((yield* decodeExtRequest(yield* Queue.take(output))).id, 1);
      assert.deepEqual(seen, []);
      // An update, the answer, and an update the agent wrote right after it.
      yield* Queue.offer(input, update);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, { jsonrpc: "2.0", id: 1, result: { ok: true } }),
      );
      yield* Queue.offer(input, update);
      yield* Deferred.await(answered);
      for (let attempt = 0; attempt < 100 && seen.length < 3; attempt += 1) yield* Effect.yieldNow;
      assert.deepEqual(seen, ["update", "answer", "update"]);
    }),
  );

  it.effect("counts an in-order request sent only once the agent's stdin took it", () =>
    Effect.gen(function* () {
      // The agent's stdin takes nothing until `gate` opens, then fails (it
      // closed its end).
      const gate = yield* Deferred.make<void>();
      const reached = yield* Deferred.make<void>();
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stdout: () =>
          Sink.forEach(() =>
            Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(Effect.die(new Error("EPIPE: the agent closed its stdin"))),
            ),
          ),
        stderr: () => Sink.drain,
      });
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const answers: Array<string> = [];
      const sending = yield* transport
        .requestInOrder("x/test", { hello: "world" }, (answer) =>
          Effect.sync(() => void answers.push(answer._tag)),
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(reached);
      for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;
      // Queued and handed to the sink, but not taken: not sent yet.
      assert.isUndefined(sending.pollUnsafe());
      yield* Deferred.succeed(gate, undefined);
      const exit = yield* Fiber.join(sending);
      assert.isTrue(exit._tag === "Failure");
      // Never written, so never answered either.
      assert.deepEqual(answers, []);
    }),
  );

  it.effect("never answers or queues a request once the agent's output has ended", () =>
    Effect.gen(function* () {
      // The agent's stdin takes nothing and never fails; its stdout ends
      // while a request waits to be written.
      const reached = yield* Deferred.make<void>();
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stdout: () =>
          Sink.forEach(() =>
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        stderr: () => Sink.drain,
      });
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const answers: Array<string> = [];
      const note = (answer: { readonly _tag: string }) =>
        Effect.sync(() => void answers.push(answer._tag));
      const first = yield* transport
        .requestInOrder("x/test", { n: 1 }, note)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(reached);
      // A second request queues behind the frame the sink holds.
      const second = yield* transport
        .requestInOrder("x/test", { n: 2 }, note)
        .pipe(Effect.exit, Effect.forkScoped);
      for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;
      yield* Queue.end(input);
      // Neither was written: both fail, and neither is reported answered.
      assert.isTrue((yield* Fiber.join(first))._tag === "Failure");
      assert.isTrue((yield* Fiber.join(second))._tag === "Failure");
      assert.deepEqual(answers, []);
      // A request made afterwards fails at once instead of waiting forever.
      const late = yield* transport.requestInOrder("x/test", { n: 3 }, note).pipe(Effect.exit);
      assert.isTrue(late._tag === "Failure");
      assert.deepEqual(answers, []);
    }),
  );

  it.effect("keeps reading the agent while an extension request waits for its answer", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const answer = yield* Deferred.make<void>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onExtRequest: () => Deferred.await(answer).pipe(Effect.as({ ok: true })),
      });

      // The agent asks something a person must answer, then keeps talking.
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtRequest, {
          jsonrpc: "2.0",
          id: 7,
          method: "x/test",
          params: { hello: "world" },
        }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "plan", entries: [] },
          },
        }),
      );
      const update = yield* transport.incoming.pipe(Stream.runHead);
      assert.equal(update._tag === "Some" ? update.value._tag : undefined, "SessionUpdate");

      yield* Deferred.succeed(answer, undefined);
      assert.deepEqual(
        yield* Schema.decodeEffect(Schema.fromJsonString(ExtResponse))(yield* Queue.take(output)),
        { jsonrpc: "2.0", id: 7, result: { ok: true } },
      );
    }),
  );

  it.effect("preserves zero-valued ids for inbound core client requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(["session/request_permission"]),
      });
      const inboundRequest = yield* Deferred.make<unknown>();

      yield* transport.serverProtocol
        .run((_clientId, message) => Deferred.succeed(inboundRequest, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(RequestPermissionRequest, {
          jsonrpc: "2.0",
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: "session-1",
            toolCall: {
              toolCallId: "tool-1",
              title: "Allow mock action",
            },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        }),
      );

      const message = yield* Deferred.await(inboundRequest);
      assert.deepEqual(message, {
        _tag: "Request",
        id: 0,
        tag: "session/request_permission",
        payload: {
          sessionId: "session-1",
          toolCall: {
            toolCallId: "tool-1",
            title: "Allow mock action",
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        headers: [],
      });

      yield* transport.serverProtocol.send(0, {
        _tag: "Exit",
        requestId: 0,
        exit: {
          _tag: "Success",
          value: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      });

      const outbound = yield* Queue.take(output);
      assert.deepEqual(yield* decodeRequestPermissionResponse(outbound), {
        jsonrpc: "2.0",
        id: 0,
        result: {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        },
      });
    }),
  );

  it.effect("cleans up interrupted extension requests before a late response arrives", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const lateResponse = yield* Deferred.make<unknown>();

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(lateResponse, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      const outbound = yield* Queue.take(output);
      assert.deepEqual(yield* decodeExtRequest(outbound), {
        jsonrpc: "2.0",
        id: 1,
        method: "x/test",
        params: {
          hello: "world",
        },
      });

      yield* Fiber.interrupt(response);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            ok: true,
          },
        }),
      );

      const message = yield* Deferred.await(lateResponse);
      assert.deepEqual(message, {
        _tag: "Exit",
        requestId: 1,
        exit: {
          _tag: "Success",
          value: {
            ok: true,
          },
        },
      });
    }),
  );

  it.effect("propagates the real child exit code when the input stream ends", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_EXIT_IMMEDIATELY_CODE: "7" });
      const firstMessage = yield* Deferred.make<unknown>();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: makeChildStdio(handle),
        terminationError: makeTerminationError(handle),
        serverRequestMethods: new Set(),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const message = yield* Deferred.await(firstMessage);
      const exitError = yield* Deferred.await(termination);
      assert.instanceOf(exitError, AcpError.AcpProcessExitedError);
      assert.equal((exitError as AcpError.AcpProcessExitedError).code, 7);
      assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");
      const defect = (message as { readonly error: { readonly reason: unknown } }).error.reason as {
        readonly _tag: string;
        readonly cause: unknown;
      };
      assert.equal(defect._tag, "RpcClientDefect");
      assert.instanceOf(defect.cause, AcpError.AcpProcessExitedError);
      assert.equal((defect.cause as AcpError.AcpProcessExitedError).code, 7);
    }),
  );

  it.effect("does not emit a second process-exit error after a decode failure", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        ACP_MOCK_MALFORMED_OUTPUT: "1",
        ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE: "23",
      });
      const terminationCalls = yield* Ref.make(0);
      const firstMessage = yield* Deferred.make<unknown>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: makeChildStdio(handle),
        terminationError: makeTerminationError(handle),
        serverRequestMethods: new Set(),
        onTermination: () => Ref.update(terminationCalls, (count) => count + 1),
      });

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const message = yield* Deferred.await(firstMessage);
      assert.equal(yield* Ref.get(terminationCalls), 1);
      assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");
      const defect = (message as { readonly error: { readonly reason: unknown } }).error.reason as {
        readonly _tag: string;
        readonly cause: unknown;
      };
      assert.equal(defect._tag, "RpcClientDefect");
      assert.instanceOf(defect.cause, AcpError.AcpProtocolParseError);
    }),
  );

  it.effect("fails pending extension requests with the propagated exit code", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        terminationError: Effect.succeed(new AcpError.AcpProcessExitedError({ code: 0 })),
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.end(input);

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request to fail after process exit"),
        }),
      );
      assert.instanceOf(error, AcpError.AcpProcessExitedError);
      assert.equal(error.code, 0);
    }),
  );

  it.effect("does not buffer incoming notifications when bufferNotifications is false", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Deferred.make<AcpProtocol.AcpIncomingNotification>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        bufferNotifications: false,
        onNotification: (notification) =>
          Deferred.succeed(handled, notification).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "plan", entries: [] },
          },
        }),
      );
      const seen = yield* Deferred.await(handled);
      assert.equal(seen._tag, "SessionUpdate");

      const bufferedFiber = yield* transport.incoming.pipe(
        Stream.runHead,
        Effect.timeoutOption("50 millis"),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("100 millis");
      const buffered = yield* Fiber.join(bufferedFiber);
      assert.equal(buffered._tag, "None");
    }),
  );
});

it("decodes prompt responses with an agent's own stop reasons and partial usage", () => {
  // fx 0.0.10's reply for a free Gateway model: its own stop reason vocabulary,
  // and usage carrying only the counts it has, under its own names.
  const decodePromptResponse = Schema.decodeUnknownSync(AcpSchema.PromptResponse);
  const decoded = decodePromptResponse({
    stopReason: "max_output_tokens",
    usage: { inputTokens: 1204, outputTokens: 18, cacheReadTokens: 0, reasoningTokens: 7 },
  });
  assert.equal(decoded.stopReason, "max_output_tokens");
  assert.equal(decoded.usage?.inputTokens, 1204);
  assert.doesNotThrow(() => decodePromptResponse({ stopReason: "end_turn", usage: {} }));
});
