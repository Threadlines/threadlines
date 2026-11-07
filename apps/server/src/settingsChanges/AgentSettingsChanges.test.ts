import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationSettingsChangeRequest,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
  SettingsChangeRequestId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { settingsChangeStateOn } from "@threadlines/shared/settingsChangeState";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import { make } from "./AgentSettingsChanges.ts";

const THREAD = ThreadId.make("thread-settings");
const REQUEST = SettingsChangeRequestId.make("request-1");
const AT = "2026-11-02T10:00:00.000Z";

const waiting = (
  changes: OrchestrationSettingsChangeRequest["changes"],
): OrchestrationSettingsChangeRequest => ({
  requestId: REQUEST,
  participantId: null,
  turnId: TurnId.make("turn-1"),
  changes,
  status: "waiting",
  createdAt: AT,
  noted: false,
});

const STREAM_OFF = { place: "general.streamReplies", value: false, from: true } as const;
const THEME_LIGHT = { place: "appearance.theme", value: "light" } as const;

/** Codex, since switched to an API key: billed per use by the time the user answers. */
const PROVIDERS = [
  {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated", type: "apiKey" },
    models: [{ slug: "gpt-test", name: "GPT Test" }],
  },
] as unknown as ReadonlyArray<ServerProvider>;

/**
 * The service over one thread's requests, an engine that keeps them the way
 * the projections do (a command the reducer can't apply is refused), and the
 * given settings service.
 */
function run<A, E>(
  requests: ReadonlyArray<OrchestrationSettingsChangeRequest>,
  settingsLayer: Layer.Layer<ServerSettingsService, ServerSettingsError>,
  body: (
    service: Effect.Success<ReturnType<typeof make>>,
    state: () => ReadonlyArray<OrchestrationSettingsChangeRequest>,
  ) => Effect.Effect<A, E, ServerSettingsService>,
) {
  let state = requests;
  const engine = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.suspend(() => {
        const before = state;
        if (command.type === "thread.settings-change.claim") {
          state = settingsChangeStateOn.claimed(state, {
            threadId: THREAD,
            requestId: command.requestId,
            claim: command.claim,
            claimedAt: command.createdAt,
          });
        } else if (command.type === "thread.settings-change.settle") {
          const request = state.find((entry) => entry.requestId === command.requestId);
          const allowed =
            command.ending === "declined"
              ? request?.status === "waiting"
              : request?.status === "claimed" && request.claim?.claimId === command.claimId;
          if (allowed) {
            state = settingsChangeStateOn.settled(state, {
              threadId: THREAD,
              requestId: command.requestId,
              ending: command.ending,
              ...(command.detail !== undefined ? { detail: command.detail } : {}),
              settledAt: command.createdAt,
            });
          }
        } else if (command.type === "thread.settings-change.report-device") {
          state = settingsChangeStateOn.deviceReported(state, {
            threadId: THREAD,
            requestId: command.requestId,
            device: command.device,
            reportedAt: command.createdAt,
          });
        }
        return state === before
          ? Effect.fail({ _tag: "OrchestrationCommandInvariantError", message: "refused" } as never)
          : Effect.succeed({ sequence: 1 });
      }),
  });
  const program = Effect.gen(function* () {
    const service = yield* make({
      providers: Effect.succeed(PROVIDERS),
      request: (_threadId, requestId) =>
        Effect.sync(() => state.find((entry) => entry.requestId === requestId)),
      claimed: Effect.sync(() =>
        state
          .filter((request) => request.status === "claimed")
          .map((request) => ({ threadId: THREAD, request })),
      ),
    });
    return yield* body(service, () => state);
  });
  return Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(Layer.merge(engine, settingsLayer))),
  );
}

const claim = { claimId: "claim-a", deviceLabel: "iPhone" };

describe("answering an agent's settings change", () => {
  it("Change claims it, writes the computer's changes once and says the app makes the device ones", async () => {
    const answer = await run(
      [waiting([STREAM_OFF, THEME_LIGHT])],
      ServerSettingsService.layerTest(),
      (service, state) =>
        Effect.gen(function* () {
          const result = yield* service.respond({
            threadId: THREAD,
            requestId: REQUEST,
            allow: true,
            claim,
          });
          const settings = yield* ServerSettingsService;
          return { result, settings: yield* settings.readStored, request: state()[0] };
        }),
    );
    expect(answer.result).toEqual({ outcome: "changed", makeDeviceChanges: true });
    expect(answer.settings.enableAssistantStreaming).toBe(false);
    expect(answer.request).toMatchObject({ status: "changed", claim });
  });

  it("writes nothing when a computer setting moved since the agent asked", async () => {
    const answer = await run(
      [waiting([STREAM_OFF])],
      ServerSettingsService.layerTest({ enableAssistantStreaming: false }),
      (service, state) =>
        Effect.gen(function* () {
          const result = yield* service.respond({
            threadId: THREAD,
            requestId: REQUEST,
            allow: true,
            claim,
          });
          return { result, request: state()[0] };
        }),
    );
    expect(answer.result.outcome).toBe("failed");
    expect(answer.result.detail).toContain(
      "Stream replies was changed to Off since the agent asked",
    );
    expect(answer.result.makeDeviceChanges).toBe(true);
    expect(answer.request?.status).toBe("failed");
  });

  it("settles changed when the file landed but a later step failed", async () => {
    const landed = Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const stored = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
        return {
          readStored: Ref.get(stored),
          updateSettingsChecked: () =>
            Ref.set(stored, { ...DEFAULT_SERVER_SETTINGS, enableAssistantStreaming: false }).pipe(
              Effect.andThen(Effect.fail({ cause: new Error("secret store"), written: true })),
            ),
        } as unknown as ServerSettingsShape;
      }),
    );
    const answer = await run([waiting([STREAM_OFF])], landed, (service, state) =>
      Effect.gen(function* () {
        const result = yield* service.respond({
          threadId: THREAD,
          requestId: REQUEST,
          allow: true,
          claim,
        });
        return { result, request: state()[0] };
      }),
    );
    expect(answer.result.outcome).toBe("changed");
    expect(answer.request?.status).toBe("changed");
  });

  it("finishes an accepted change when the app that pressed Change goes away mid-way", async () => {
    const release = Effect.runSync(Deferred.make<void>());
    const writing = Effect.runSync(Deferred.make<void>());
    const slow = Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const stored = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
        return {
          readStored: Ref.get(stored),
          updateSettingsChecked: () =>
            Deferred.succeed(writing, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Ref.updateAndGet(stored, (current) => ({
                  ...current,
                  enableAssistantStreaming: false,
                })),
              ),
            ),
        } as unknown as ServerSettingsShape;
      }),
    );
    const request = await run([waiting([STREAM_OFF])], slow, (service, state) =>
      Effect.gen(function* () {
        const caller = yield* service
          .respond({ threadId: THREAD, requestId: REQUEST, allow: true, claim })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        // The app's request ends (its connection dropped) while the write is under way.
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(release, undefined);
        // The next answer waits its turn behind the first, so after it the first is done.
        yield* service.respond({ threadId: THREAD, requestId: REQUEST, allow: false });
        return state()[0];
      }),
    );
    expect(request).toMatchObject({ status: "changed", claim });
  });

  it("answers a retry from the same app with how it went, and anyone else with who answered", async () => {
    const answer = await run(
      [waiting([STREAM_OFF])],
      ServerSettingsService.layerTest(),
      (service) =>
        Effect.gen(function* () {
          const input = { threadId: THREAD, requestId: REQUEST, allow: true, claim };
          yield* service.respond(input);
          const retry = yield* service.respond(input);
          const other = yield* service.respond({
            ...input,
            claim: { claimId: "claim-b", deviceLabel: "Mac" },
          });
          const notNow = yield* service.respond({ ...input, allow: false });
          return { retry, other, notNow };
        }),
    );
    expect(answer.retry).toEqual({ outcome: "changed", makeDeviceChanges: true });
    expect(answer.other).toMatchObject({ outcome: "already_answered", makeDeviceChanges: false });
    expect(answer.other.detail).toContain("iPhone");
    expect(answer.notNow.outcome).toBe("already_answered");
  });

  it("Not now changes nothing", async () => {
    const answer = await run(
      [waiting([STREAM_OFF, THEME_LIGHT])],
      ServerSettingsService.layerTest(),
      (service, state) =>
        Effect.gen(function* () {
          const result = yield* service.respond({
            threadId: THREAD,
            requestId: REQUEST,
            allow: false,
          });
          const settings = yield* ServerSettingsService;
          return { result, settings: yield* settings.readStored, request: state()[0] };
        }),
    );
    expect(answer.result).toEqual({ outcome: "declined", makeDeviceChanges: false });
    expect(answer.settings.enableAssistantStreaming).toBe(true);
    expect(answer.request?.status).toBe("declined");
  });

  it("settles a claim a previous run stopped in the middle of from what the settings hold", async () => {
    const claimed = (
      changes: OrchestrationSettingsChangeRequest["changes"],
    ): OrchestrationSettingsChangeRequest => ({ ...waiting(changes), status: "claimed", claim });
    const FETCH = { place: "sourceControl.fetchInterval", value: 60, from: 120 } as const;
    const outcome = (settings: Parameters<typeof ServerSettingsService.layerTest>[0]) =>
      run(
        [claimed([STREAM_OFF, FETCH])],
        ServerSettingsService.layerTest(settings),
        (service, state) =>
          // An answer waits for recovery, so after it the claim is settled.
          service
            .respond({ threadId: THREAD, requestId: REQUEST, allow: true, claim })
            .pipe(Effect.map(() => state()[0])),
      );
    const all = await outcome({
      enableAssistantStreaming: false,
      automaticGitFetchInterval: Duration.seconds(60),
    });
    expect(all?.status).toBe("changed");
    const none = await outcome({});
    expect(none?.status).toBe("failed");
    expect(none?.detail).toContain("Stream replies is On (asked: Off)");
    const mix = await outcome({ enableAssistantStreaming: false });
    expect(mix?.status).toBe("uncertain");
  });

  it("checks a model again when the user accepts: its provider may bill per use by now", () =>
    run(
      [waiting([{ place: "threads.agent", value: "codex/gpt-test", from: "none" }])],
      ServerSettingsService.layerTest(),
      (service) =>
        Effect.gen(function* () {
          const answer = yield* service.respond({
            threadId: THREAD,
            requestId: REQUEST,
            allow: true,
            claim,
          });
          expect(answer.outcome).toBe("failed");
          expect(answer.detail).toContain("billed per use");
          const settings = yield* ServerSettingsService;
          expect((yield* settings.getSettings).newThreadModelSelection).toBeNull();
        }),
    ));
});
