import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { PROVIDER_READINESS_EVENT, reportProviderReadiness } from "./ProviderReadinessTelemetry.ts";

const codex = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

/**
 * Runs the reporter against a registry whose current list lives in a Ref
 * (what `getProviders` reads) and whose change stream is a queue (what
 * `streamChanges` emits), recording every analytics event it sends.
 */
const startReporter = Effect.gen(function* () {
  const current = yield* Ref.make<ReadonlyArray<ServerProvider>>([
    codex({ statusReason: "provider_probe_pending" }),
  ]);
  const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
  const recorded: Array<{ event: string; properties: Readonly<Record<string, unknown>> }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ProviderRegistry, {
      getProviders: Ref.get(current),
      streamChanges: Stream.fromQueue(changes),
    } as never),
    Layer.succeed(AnalyticsService, {
      record: (event, properties) =>
        Effect.sync(() => {
          recorded.push({ event, properties: properties ?? {} });
        }),
      flush: Effect.void,
    }),
  );
  const fiber = yield* reportProviderReadiness.pipe(Effect.provide(layer), Effect.forkChild);
  const publish = (providers: ReadonlyArray<ServerProvider>) =>
    Ref.set(current, providers).pipe(Effect.andThen(Queue.offer(changes, providers)));
  return { current, publish, recorded, fiber };
});

const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

it.effect("reports readiness once checks settle, then only when it changes", () =>
  Effect.gen(function* () {
    const { publish, recorded, fiber } = yield* startReporter;

    yield* settle;
    assert.lengthOf(recorded, 0, "nothing is reported while a check is still running");

    yield* publish([codex()]);
    yield* publish([codex({ checkedAt: "2026-10-02T00:05:00.000Z" })]);
    yield* settle;
    assert.lengthOf(recorded, 1, "a refresh with the same answer is not reported again");
    assert.strictEqual(recorded[0]?.event, PROVIDER_READINESS_EVENT);
    assert.strictEqual(recorded[0]?.properties.codexSignedIn, "yes");

    yield* publish([codex({ auth: { status: "unauthenticated" } })]);
    yield* settle;
    assert.lengthOf(recorded, 2);
    assert.strictEqual(recorded[1]?.properties.codexSignedIn, "no");
    assert.strictEqual(recorded[1]?.properties.anyAgentReady, false);

    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("reports a result the change stream never delivered", () =>
  Effect.gen(function* () {
    const { current, recorded, fiber } = yield* startReporter;
    yield* settle;

    // The probe finished before the reporter subscribed: the registry holds
    // the answer, but no change is ever emitted for it.
    yield* Ref.set(current, [codex()]);
    yield* TestClock.adjust("15 seconds");
    yield* settle;
    assert.lengthOf(recorded, 1);
    assert.strictEqual(recorded[0]?.properties.anyAgentReady, true);

    yield* Fiber.interrupt(fiber);
  }),
);
