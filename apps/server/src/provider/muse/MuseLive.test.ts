/**
 * Optional checks against a real Muse Code install, in an isolated home so
 * they never touch the user's own Muse data or sign-in. They run Muse's
 * offline `echo` provider, so they need no account and spend nothing.
 * Enable with: THREADLINES_MUSE_BIN=/path/to/muse vp run '@threadlines/server#test' MuseLive
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
  ThreadId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import { museHostEnvironment } from "./MuseLaunch.ts";

const binaryPath = process.env.THREADLINES_MUSE_BIN;
const INSTANCE_ID = ProviderInstanceId.make("muse");
const EVENT_TIMEOUT = Duration.seconds(process.env.MUSE_LIVE_DEBUG ? 15 : 60);

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "threadlines-muse-"));
  return museHostEnvironment(undefined, {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
  });
}

const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "threadlines-muse-work-")));

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "muse-live-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const setup = Effect.gen(function* () {
  const adapter = yield* makeMuseAdapter({
    instanceId: INSTANCE_ID,
    settings: {
      enabled: true,
      binaryPath: binaryPath!,
      allowApiKeyBilling: false,
      customModels: [],
    },
    binaryPath: () => binaryPath!,
    environment: isolatedEnvironment(),
    instanceEnvironment: undefined,
    readContributorMode: Effect.succeed(undefined),
    sandboxAvailable: () => true,
    models: () => [],
    onSubscriptionUsage: () => Effect.void,
    onAccountChanged: Effect.void,
    providerId: "echo",
    hostArgs: ["--provider", "echo"],
  });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const nextEvent = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (process.env.MUSE_LIVE_DEBUG)
          console.log("EVENT", event.type, JSON.stringify(event.payload ?? {}).slice(0, 200));
        if (predicate(event)) return event;
      }
    }).pipe(Effect.timeout(EVENT_TIMEOUT));
  return { adapter, nextEvent };
});

describe.runIf(binaryPath !== undefined)("Muse Code live", () => {
  it.live(
    "runs a turn, then resumes the conversation on a new host with another access level",
    () =>
      Effect.gen(function* () {
        const { adapter, nextEvent } = yield* setup;
        const threadId = ThreadId.make("muse-live-thread");
        const cwd = workspace();
        const session = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "approval-required",
        });
        expect(session.providerThreadId).toBeTruthy();

        const turn = yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("muse-live-message-1"),
          input: "hello from Threadlines",
        });
        const delta = yield* nextEvent(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        );
        expect(delta.type === "content.delta" && delta.payload.delta).toContain(
          "hello from Threadlines",
        );
        const completed = yield* nextEvent((event) => event.type === "turn.completed");
        expect(completed.turnId).toBe(turn.turnId);
        expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");

        // A new host must take the lease, and apply the new profile.
        yield* adapter.stopSession(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        expect(resumed.providerThreadId).toBe(session.providerThreadId);
        yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("muse-live-message-2"),
          input: "and again",
        });
        const second = yield* nextEvent((event) => event.type === "turn.completed");
        expect(second.type === "turn.completed" && second.payload.state).toBe("completed");
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    120_000,
  );

  it.live(
    "moves to a read-only host for a plan turn and proposes the answer as the plan",
    () =>
      Effect.gen(function* () {
        const { adapter, nextEvent } = yield* setup;
        const threadId = ThreadId.make("muse-live-plan");
        yield* adapter.startSession({ threadId, cwd: workspace(), runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("muse-live-plan-1"),
          input: "plan the change",
          interactionMode: "plan",
        });
        const proposed = yield* nextEvent((event) => event.type === "turn.proposed.completed");
        expect(
          proposed.type === "turn.proposed.completed" && proposed.payload.planMarkdown,
        ).toContain("plan the change");
        const completed = yield* nextEvent((event) => event.type === "turn.completed");
        expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    120_000,
  );
});
