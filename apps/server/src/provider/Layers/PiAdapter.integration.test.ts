/**
 * PiAdapter against a real Pi and the test model server. Runs when a Pi
 * `cli.js` is available (THREADLINES_PI_CLI, or the server's pinned dev
 * dependency).
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { parsePiResumeCursor } from "../pi/PiCursor.ts";
import {
  makeTestPiHome,
  resolveTestPiCli,
  startTestModelServer,
  testPiEnvironment,
} from "../pi/testing/PiTestServers.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const piCli = resolveTestPiCli();
const INSTANCE_ID = ProviderInstanceId.make("pi");

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "threadlines-pi-project-")));

const setup = Effect.gen(function* () {
  const model = yield* Effect.acquireRelease(
    Effect.promise(() => startTestModelServer()),
    (server) => Effect.promise(() => server.close()),
  );
  const home = makeTestPiHome(model.url);
  const adapter = yield* makePiAdapter({
    instanceId: INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
    launch: Effect.succeed({ command: process.execPath, prefixArgs: [piCli!] }),
    instanceEnvironment: undefined,
    baseEnvironment: testPiEnvironment(home.agentDir),
    extensionDir: mkdtempSync(join(tmpdir(), "threadlines-pi-ext-")),
    models: () => [],
  });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const seen: Array<ProviderRuntimeEvent> = [];
  const nextEvent = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (predicate(event)) return event;
      }
    }).pipe(Effect.timeout(Duration.seconds(30)));
  const turnEnd = (threadId: ThreadId) =>
    nextEvent((event) => event.type === "turn.completed" && event.threadId === threadId);
  const start = (
    threadId: ThreadId,
    input: {
      readonly runtimeMode?: RuntimeMode;
      readonly cwd?: string;
      readonly resumeCursor?: unknown;
      readonly forkFrom?: { readonly providerThreadId: string; readonly lastTurnId?: string };
    } = {},
  ) =>
    adapter.startSession({
      threadId,
      cwd: input.cwd ?? folder(),
      runtimeMode: input.runtimeMode ?? "full-access",
      ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      ...(input.forkFrom ? { forkFrom: input.forkFrom } : {}),
    });
  const send = (threadId: ThreadId, text: string, interactionMode?: "plan") =>
    adapter.sendTurn({
      threadId,
      messageId: MessageId.make(`m-${text.slice(0, 20)}`),
      input: text,
      ...(interactionMode ? { interactionMode } : {}),
    });
  /** The user messages the model saw on its last request. */
  const lastUserMessages = () =>
    ((model.requests.at(-1)?.messages ?? []) as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content));
  return { adapter, model, nextEvent, turnEnd, start, send, seen, lastUserMessages };
});

const run = <A, E, R extends Layer.Success<typeof testLayer> | Scope.Scope>(
  body: Effect.Effect<A, E, R>,
) => Effect.scoped(body).pipe(Effect.provide(testLayer));

describe.skipIf(!piCli)("PiAdapter with a real Pi", () => {
  it.live(
    "streams a turn, asks before a command, and remembers where the session lives",
    () =>
      run(
        Effect.gen(function* () {
          const { adapter, nextEvent, turnEnd, start, send } = yield* setup;
          const threadId = ThreadId.make("pi-a");
          const session = yield* start(threadId, { runtimeMode: "approval-required" });
          expect(parsePiResumeCursor(session.resumeCursor)?.sessionFile).toMatch(/\.jsonl$/u);

          yield* send(threadId, "hello there");
          const delta = yield* nextEvent((event) => event.type === "content.delta");
          expect(delta.type === "content.delta" && delta.payload.delta).toContain("echo");
          const done = yield* turnEnd(threadId);
          expect(done.type === "turn.completed" && done.payload.state).toBe("completed");

          yield* send(threadId, 'TOOL bash {"command":"echo approved"}');
          const opened = yield* nextEvent((event) => event.type === "request.opened");
          expect(opened.type === "request.opened" && opened.payload.requestType).toBe(
            "command_execution_approval",
          );
          // Events and logs are files the agent can read: the nonce stays out.
          expect(JSON.stringify(opened.raw)).toContain("[nonce]");
          if (opened.type !== "request.opened") return;
          yield* adapter.respondToRequest(threadId, opened.requestId as never, "accept");
          const command = yield* nextEvent(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "command_execution",
          );
          expect(command.type === "item.completed" && command.payload.status).toBe("completed");
          expect(
            JSON.stringify(command.type === "item.completed" ? command.payload.data : {}),
          ).toContain('"exitCode":0');
          yield* turnEnd(threadId);
        }),
      ),
    90_000,
  );

  it.live(
    "plan mode declines writing and proposes the plan; steering joins the turn; Stop interrupts",
    () =>
      run(
        Effect.gen(function* () {
          const { adapter, nextEvent, turnEnd, start, send, lastUserMessages, seen } = yield* setup;
          const threadId = ThreadId.make("pi-b");
          yield* start(threadId);

          yield* send(threadId, 'TOOL write {"path":"x.txt","content":"no"}', "plan");
          const write = yield* nextEvent(
            (event) => event.type === "item.completed" && event.payload.itemType === "file_change",
          );
          expect(write.type === "item.completed" && write.payload.status).toBe("declined");
          yield* nextEvent((event) => event.type === "turn.proposed.completed");
          yield* turnEnd(threadId);

          const slow = yield* send(threadId, "SLOW 1500 one two three four five six");
          yield* nextEvent((event) => event.type === "content.delta");
          yield* adapter.steerTurn!({ threadId, expectedTurnId: slow.turnId, input: "steered in" });
          const steered = yield* turnEnd(threadId);
          expect(steered.turnId).toBe(slow.turnId);
          expect(lastUserMessages().some((text) => text.includes("steered in"))).toBe(true);

          const long = yield* send(threadId, "SLOW 20000 this will be stopped");
          yield* nextEvent((event) => event.type === "content.delta");
          const stopped = Date.now();
          yield* adapter.interruptTurn(threadId, long.turnId);
          const end = yield* turnEnd(threadId);
          expect(end.type === "turn.completed" && end.payload.state).toBe("interrupted");
          // Pi stops on its own: no restart, well inside the first Stop step.
          expect(Date.now() - stopped).toBeLessThan(3_000);
          expect(
            seen.some(
              (event) =>
                event.type === "runtime.warning" &&
                JSON.stringify(event.payload).includes("did not stop in time"),
            ),
          ).toBe(false);
        }),
      ),
    90_000,
  );

  it.live(
    "reverts Pi's memory, resumes after a restart, follows a checkout move, and forks for another thread",
    () =>
      run(
        Effect.gen(function* () {
          const { adapter, turnEnd, start, send, lastUserMessages } = yield* setup;
          const threadId = ThreadId.make("pi-c");
          const cwd = folder();
          yield* start(threadId, { cwd });
          const first = yield* send(threadId, "first message");
          yield* turnEnd(threadId);
          yield* send(threadId, "second message");
          yield* turnEnd(threadId);

          const rolled = yield* adapter.rollbackThread(threadId, 1);
          expect(rolled.conversationRolledBack).toBe(true);
          yield* send(threadId, "after revert");
          yield* turnEnd(threadId);
          expect(lastUserMessages().some((text) => text.includes("second message"))).toBe(false);
          expect(lastUserMessages().some((text) => text.includes("first message"))).toBe(true);

          // Restart on the same cursor: Pi still remembers.
          const cursor = (yield* adapter.listSessions()).find(
            (s) => s.threadId === threadId,
          )?.resumeCursor;
          yield* adapter.stopSession(threadId);
          yield* start(threadId, { cwd, resumeCursor: cursor });
          yield* send(threadId, "after restart");
          yield* turnEnd(threadId);
          expect(lastUserMessages().some((text) => text.includes("after revert"))).toBe(true);

          // The thread moved to another checkout: it continues in a copy there.
          const moved = folder();
          const movedCursor = (yield* adapter.listSessions()).find(
            (s) => s.threadId === threadId,
          )?.resumeCursor;
          yield* adapter.stopSession(threadId);
          const movedSession = yield* start(threadId, { cwd: moved, resumeCursor: movedCursor });
          expect(parsePiResumeCursor(movedSession.resumeCursor)?.cwd).toBe(moved);
          yield* send(threadId, 'TOOL bash {"command":"pwd"}');
          yield* turnEnd(threadId);
          expect(lastUserMessages().some((text) => text.includes("after restart"))).toBe(true);

          // Another thread forks through the first turn only.
          const source = parsePiResumeCursor(movedSession.resumeCursor)!.sessionFile;
          const forkThread = ThreadId.make("pi-d");
          yield* start(forkThread, {
            forkFrom: { providerThreadId: source, lastTurnId: first.turnId },
          });
          yield* send(forkThread, "in the fork");
          yield* turnEnd(forkThread);
          const seenByFork = lastUserMessages();
          expect(seenByFork.some((text) => text.includes("first message"))).toBe(true);
          expect(seenByFork.some((text) => text.includes("after revert"))).toBe(false);
          // The fork holds two turns: the one it copied and its own.
          const forkReverted = yield* adapter.rollbackThread(forkThread, 2);
          expect(forkReverted.conversationRolledBack).toBe(true);
          yield* send(forkThread, "fork again");
          yield* turnEnd(forkThread);
          expect(lastUserMessages().some((text) => text.includes("first message"))).toBe(false);

          // Back on the moved thread, which restarted twice: revert counts back
          // through the turns from before the restarts too, and past the turn
          // reverted earlier, which is gone.
          const reverted = yield* adapter.rollbackThread(threadId, 4);
          expect(reverted.conversationRolledBack).toBe(true);
          yield* send(threadId, "final message");
          yield* turnEnd(threadId);
          expect(lastUserMessages().some((text) => text.includes("first message"))).toBe(false);
          expect(lastUserMessages().some((text) => text.includes("final message"))).toBe(true);
        }),
      ),
    120_000,
  );
});
