import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@threadlines/contracts";
import type { ProviderAuthEvent } from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../../terminal/Services/PTY.ts";
import { makeProviderAuthSessions } from "./ProviderAuthSessions.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyProcess {
  readonly pid = 4242;
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal: null });
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  failNextSpawn = false;

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    if (this.failNextSpawn) {
      this.failNextSpawn = false;
      return Effect.fail(
        new PtySpawnError({ adapter: "fake", message: "Failed to spawn PTY process" }),
      );
    }
    const process = new FakePtyProcess();
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 1_000,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

const CLAUDE_INSTANCE = ProviderInstanceId.make("claude-work");
const CODEX_INSTANCE = ProviderInstanceId.make("codex-work");

const settingsLayer = ServerSettingsService.layerTest({
  providerInstances: {
    [CLAUDE_INSTANCE]: {
      driver: "claudeAgent",
      config: { binaryPath: "claude", homePath: "/tmp/claude-home" },
    },
    [CODEX_INSTANCE]: {
      driver: "codex",
      config: { binaryPath: "codex", shadowHomePath: "/tmp/codex-home" },
    },
  },
});

const createSessions = Effect.fn("createSessions")(function* () {
  const settings = yield* ServerSettingsService;
  const ptyAdapter = new FakePtyAdapter();
  const refreshedRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const sessions = yield* makeProviderAuthSessions({
    ptyAdapter,
    settings,
    refreshInstance: (instanceId) =>
      Ref.update(refreshedRef, (refreshed) => [...refreshed, String(instanceId)]),
    homeDir: "/tmp",
    env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "stale-token" },
  });

  const eventsRef = yield* Ref.make<ReadonlyArray<ProviderAuthEvent>>([]);
  const scope = yield* Effect.scope;
  const subscribeTo = (instanceId: ProviderInstanceId) =>
    sessions
      .subscribe(instanceId, (event) => Ref.update(eventsRef, (events) => [...events, event]))
      .pipe(Effect.tap((unsubscribe) => Scope.addFinalizer(scope, Effect.sync(unsubscribe))));

  return {
    sessions,
    ptyAdapter,
    settings,
    subscribeTo,
    getEvents: Ref.get(eventsRef),
    getRefreshed: Ref.get(refreshedRef),
  };
});

const statusesOf = (events: ReadonlyArray<ProviderAuthEvent>) =>
  events.flatMap((event) => (event.type === "status" ? [event.status] : []));

const outputOf = (events: ReadonlyArray<ProviderAuthEvent>) =>
  events
    .flatMap((event) => (event.type === "output" ? [event.data] : []))
    .join("")
    .trimEnd();

it.layer(NodeServices.layer, { excludeTestServices: true })("ProviderAuthSessions", (it) => {
  it.effect("captures a setup token split across chunks, saves it, and masks the broadcast", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      yield* harness.subscribeTo(CLAUDE_INSTANCE);
      yield* harness.sessions.start({
        instanceId: CLAUDE_INSTANCE,
        flow: "claude-setup-token",
      });

      const process = harness.ptyAdapter.processes[0]!;
      process.emitData("Your token: sk-ant-oat01-ABCD");
      process.emitData("EFGH1234\nDone.\n");

      yield* waitFor(harness.getRefreshed.pipe(Effect.map((refreshed) => refreshed.length === 1)));

      const events = yield* harness.getEvents;
      const output = outputOf(events);
      expect(output).not.toContain("sk-ant-oat01-");
      expect(output).toContain("••• captured");
      expect(statusesOf(events)).toEqual(["idle", "starting", "running", "succeeded"]);

      const settings = yield* harness.settings.getSettings;
      const environment = settings.providerInstances[CLAUDE_INSTANCE]?.environment ?? [];
      expect(environment).toEqual([
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: "sk-ant-oat01-ABCDEFGH1234",
          sensitive: true,
          valueRedacted: false,
        },
      ]);

      // A second capture must not re-save or double-refresh.
      process.emitExit(0);
      const refreshed = yield* harness.getRefreshed;
      assert.deepStrictEqual(refreshed, [String(CLAUDE_INSTANCE)]);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("spawns the setup-token pty too wide for the CLI to wrap the token", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      yield* harness.subscribeTo(CLAUDE_INSTANCE);
      yield* harness.sessions.start({
        instanceId: CLAUDE_INSTANCE,
        flow: "claude-setup-token",
        cols: 100,
        rows: 20,
      });

      // The CLI hard-wraps output at the PTY width. A token wider than the
      // requested viewport must still arrive on one line, or capture would
      // save a truncated (dead) credential and leak the tail past the mask.
      const spawnInput = harness.ptyAdapter.spawnInputs[0]!;
      expect(spawnInput.cols).toBeGreaterThanOrEqual(256);

      // Resizing (e.g. the browser terminal fitting itself) must not shrink
      // it back down mid-run.
      yield* harness.sessions.resize({ instanceId: CLAUDE_INSTANCE, cols: 80, rows: 20 });
      const token = `sk-ant-oat01-${"A".repeat(90)}zbk`;
      const process = harness.ptyAdapter.processes[0]!;
      process.emitData(`Your OAuth token (valid for 1 year):\n\n${token}\n\nStore it.\n`);

      yield* waitFor(harness.getRefreshed.pipe(Effect.map((refreshed) => refreshed.length === 1)));
      const settings = yield* harness.settings.getSettings;
      const environment = settings.providerInstances[CLAUDE_INSTANCE]?.environment ?? [];
      expect(environment[0]?.value).toBe(token);
      expect(outputOf(yield* harness.getEvents)).not.toContain("zbk");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("fails a setup-token run that never prints a token", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      yield* harness.subscribeTo(CLAUDE_INSTANCE);
      yield* harness.sessions.start({
        instanceId: CLAUDE_INSTANCE,
        flow: "claude-setup-token",
      });

      harness.ptyAdapter.processes[0]!.emitExit(1);

      yield* waitFor(
        harness.getEvents.pipe(Effect.map((events) => statusesOf(events).includes("failed"))),
      );
      const refreshed = yield* harness.getRefreshed;
      assert.deepStrictEqual(refreshed, []);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("re-probes the provider when a login flow exits cleanly", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      yield* harness.subscribeTo(CODEX_INSTANCE);
      yield* harness.sessions.start({ instanceId: CODEX_INSTANCE, flow: "login" });

      const spawnInput = harness.ptyAdapter.spawnInputs[0]!;
      assert.equal(spawnInput.shell, "codex");
      assert.deepStrictEqual(spawnInput.args, ["login"]);
      assert.equal(spawnInput.env.CODEX_HOME, "/tmp/codex-home");
      // Credential overrides never reach an auth process.
      assert.equal(spawnInput.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

      harness.ptyAdapter.processes[0]!.emitData("Signed in.\n");
      harness.ptyAdapter.processes[0]!.emitExit(0);

      yield* waitFor(harness.getRefreshed.pipe(Effect.map((refreshed) => refreshed.length === 1)));
      const events = yield* harness.getEvents;
      expect(statusesOf(events)).toEqual(["idle", "starting", "running", "succeeded"]);
      expect(outputOf(events)).toBe("Signed in.");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("reports the exit code when a login flow fails", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      yield* harness.subscribeTo(CODEX_INSTANCE);
      yield* harness.sessions.start({ instanceId: CODEX_INSTANCE, flow: "login" });

      harness.ptyAdapter.processes[0]!.emitExit(7);

      yield* waitFor(
        harness.getEvents.pipe(Effect.map((events) => statusesOf(events).includes("failed"))),
      );
      const events = yield* harness.getEvents;
      const failure = events.findLast((event) => event.type === "status");
      assert.equal(failure?.type === "status" ? failure.exitCode : null, 7);
      const refreshed = yield* harness.getRefreshed;
      assert.deepStrictEqual(refreshed, []);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("rejects a setup-token flow on a driver that has no such command", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      const error = yield* Effect.flip(
        harness.sessions.start({ instanceId: CODEX_INSTANCE, flow: "claude-setup-token" }),
      );
      expect(error).toMatchObject({ _tag: "ProviderAuthError", reason: "unsupportedFlow" });
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("stops a running flow when a new one starts for the same instance", () =>
    Effect.gen(function* () {
      const harness = yield* createSessions();
      yield* harness.sessions.start({ instanceId: CODEX_INSTANCE, flow: "login" });
      yield* harness.sessions.start({ instanceId: CODEX_INSTANCE, flow: "login" });

      expect(harness.ptyAdapter.processes).toHaveLength(2);
      assert.isTrue(harness.ptyAdapter.processes[0]!.killed);
      assert.isFalse(harness.ptyAdapter.processes[1]!.killed);
    }).pipe(Effect.provide(settingsLayer)),
  );
});
