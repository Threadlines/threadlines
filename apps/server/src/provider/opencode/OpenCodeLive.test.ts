/**
 * Optional checks against a real OpenCode 2 install, in an isolated home so
 * they never touch the user's own OpenCode data. They run real model turns on
 * OpenCode's free models, so they are slow.
 * Enable with: THREADLINES_OPENCODE_BIN=/path/to/opencode vp run '@threadlines/server#test' OpenCodeLive
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import { runOpenCode } from "./OpenCodeClient.ts";
import { makeOpenCodeServerManager } from "./OpenCodeServerManager.ts";

const binaryPath = process.env.THREADLINES_OPENCODE_BIN;
const INSTANCE_ID = ProviderInstanceId.make("opencode");
const TURN_TIMEOUT = Duration.seconds(150);

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "threadlines-opencode-"));
  return {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
  };
}

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "threadlines-opencode-work-"));
  mkdirSync(directory, { recursive: true });
  return realpathSync(directory);
}

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "opencode-live-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** A free model, so the checks need no credentials. */
const pickFreeModel = (
  manager: Effect.Success<ReturnType<typeof makeOpenCodeServerManager>>,
  cwd: string,
) =>
  manager.withServer(({ server }) =>
    runOpenCode("model.list", (signal) =>
      server.client.model.list({ location: { directory: cwd } }, { signal }),
    ).pipe(
      Effect.repeat({ until: (result) => (result.data ?? []).length > 0, times: 20 }),
      Effect.map((result) => {
        const free = (result.data ?? []).filter(
          (model) =>
            model.providerID === "opencode" &&
            (model.cost ?? []).every((tier) => tier.input === 0 && tier.output === 0),
        );
        const model = free.find((candidate) => candidate.id === "space-bunny-free") ?? free[0];
        if (!model) throw new Error("OpenCode lists no free model.");
        return `${model.providerID}/${model.id}`;
      }),
    ),
  );

const setup = Effect.gen(function* () {
  const manager = yield* makeOpenCodeServerManager({
    binaryPath: binaryPath!,
    environment: isolatedEnvironment(),
  });
  const adapter = yield* makeOpenCodeAdapter({
    instanceId: INSTANCE_ID,
    settings: {
      enabled: true,
      binaryPath: binaryPath!,
      serverUrl: "",
      serverPassword: "",
      customModels: [],
    },
    manager,
  });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const cwd = workspace();
  const model = yield* pickFreeModel(manager, cwd);
  const nextEvent = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (predicate(event)) return event;
      }
    }).pipe(Effect.timeout(TURN_TIMEOUT));
  return { manager, adapter, cwd, model, nextEvent };
});

describe.runIf(binaryPath !== undefined)("OpenCode 2 live", () => {
  it.live(
    "starts a private server, streams events, and stops it when idle",
    () =>
      Effect.gen(function* () {
        const manager = yield* makeOpenCodeServerManager({
          binaryPath: binaryPath!,
          environment: isolatedEnvironment(),
          idleTtl: Duration.seconds(1),
        });
        const opened = yield* manager.signals.pipe(
          Stream.filter((signal) => signal._tag === "StreamOpened"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const gone = yield* manager.signals.pipe(
          Stream.filter((signal) => signal._tag === "ServerGone"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );

        const { server } = yield* manager.withServer((active) => Effect.succeed(active));
        expect(server.version).toMatch(/^2\./);
        const info = yield* runOpenCode("info", (signal) => server.client.server.info({ signal }));
        expect(info.version).toBe(server.version);
        yield* Fiber.join(opened);

        const [signal] = yield* Fiber.join(gone);
        expect(signal).toMatchObject({ _tag: "ServerGone", unexpected: false });
        yield* server.exited.pipe(Effect.timeout(Duration.seconds(5)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "runs a turn, asks before a command, rolls back, and stops a running command",
    () =>
      Effect.gen(function* () {
        const { adapter, cwd, model, nextEvent } = yield* setup;
        const threadId = ThreadId.make("opencode-live-thread");
        const modelSelection = { instanceId: INSTANCE_ID, model };
        const session = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "approval-required",
          modelSelection,
        });
        expect(session.providerThreadId).toMatch(/^ses_/);

        // A plain turn streams text and completes.
        const first = yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("live-first"),
          input: "Reply with exactly the word: pineapple",
          modelSelection,
        });
        yield* nextEvent(
          (event) => event.type === "content.delta" && event.turnId === first.turnId,
        );
        const firstDone = yield* nextEvent(
          (event) => event.type === "turn.completed" && event.turnId === first.turnId,
        );
        expect(firstDone).toMatchObject({ payload: { state: "completed" } });

        // Supervised: a command waits for approval, then runs.
        const second = yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("live-second"),
          input:
            "Use your shell tool to run exactly `echo threadlines-ok`, then say what it printed.",
          modelSelection,
        });
        const asked = yield* nextEvent((event) => event.type === "request.opened");
        expect(asked).toMatchObject({ payload: { requestType: "exec_command_approval" } });
        yield* adapter.respondToRequest(threadId, asked.requestId! as never, "accept");
        const ran = yield* nextEvent(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "command_output" &&
            event.payload.delta.includes("threadlines-ok"),
        );
        expect(ran.turnId).toBe(second.turnId);
        const secondDone = yield* nextEvent(
          (event) => event.type === "turn.completed" && event.turnId === second.turnId,
        );
        expect(secondDone).toMatchObject({ payload: { state: "completed" } });

        // Rolling back one turn removes the second prompt from OpenCode's history.
        const rolledBack = yield* adapter.rollbackThread(threadId, 1, {
          targetUserMessageId: MessageId.make("live-second"),
        });
        expect(rolledBack.turns.map((turn) => turn.id)).toEqual([first.turnId]);

        // Full access: a long command is stopped and the turn ends interrupted.
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          modelSelection,
          resumeCursor: session.resumeCursor,
        });
        const third = yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("live-third"),
          input: "Use your shell tool to run exactly `sleep 60`, then say done.",
          modelSelection,
        });
        yield* nextEvent(
          (event) =>
            event.type === "item.started" &&
            event.turnId === third.turnId &&
            event.payload.itemType === "command_execution",
        );
        yield* adapter.interruptTurn(threadId, third.turnId);
        const thirdDone = yield* nextEvent(
          (event) => event.type === "turn.completed" && event.turnId === third.turnId,
        );
        expect(thirdDone).toMatchObject({ payload: { state: "interrupted" } });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    600_000,
  );
  it.live(
    "moves a resumed session to the checkout it resumes in",
    () =>
      Effect.gen(function* () {
        const { adapter, manager, cwd, model, nextEvent } = yield* setup;
        const threadId = ThreadId.make("opencode-live-move");
        const modelSelection = { instanceId: INSTANCE_ID, model };
        const first = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          modelSelection,
        });
        yield* adapter.stopSession(threadId);

        const elsewhere = workspace();
        yield* adapter.startSession({
          threadId,
          cwd: elsewhere,
          runtimeMode: "full-access",
          modelSelection,
          resumeCursor: first.resumeCursor,
        });
        const info = yield* manager.withServer(({ server }) =>
          runOpenCode("session.get", (signal) =>
            server.client.session.get({ sessionID: first.providerThreadId! }, { signal }),
          ),
        );
        expect(info.location.directory).toBe(elsewhere);

        const turn = yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("live-moved"),
          input: "Reply with exactly the word: moved",
          modelSelection,
        });
        const done = yield* nextEvent(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
        );
        expect(done).toMatchObject({ payload: { state: "completed" } });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    300_000,
  );
});
