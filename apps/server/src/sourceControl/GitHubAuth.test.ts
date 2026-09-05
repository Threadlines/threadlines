import { assert, it } from "@effect/vitest";
import type { GitHubAuthState } from "@threadlines/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { make, type GitHubAuthShape } from "./GitHubAuth.ts";

const encoder = new TextEncoder();

function handle(
  input: {
    readonly chunks?: ReadonlyArray<string>;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly kill?: () => Effect.Effect<void>;
  } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: input.kill ?? (() => Effect.void),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.fromIterable((input.chunks ?? []).map((chunk) => encoder.encode(chunk))),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const waitForState = (auth: GitHubAuthShape, predicate: (state: GitHubAuthState) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = yield* auth.getState;
      if (predicate(state)) return state;
      yield* Effect.yieldNow;
    }
    assert.fail("GitHub sign-in did not reach the expected state.");
  });

it.effect("keeps the device code available until login and credential verification finish", () =>
  Effect.gen(function* () {
    const loginExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const calls: ReadonlyArray<string>[] = [];
    const spawner = ChildProcessSpawner.make((command) => {
      assert.strictEqual(command._tag, "StandardCommand");
      const standard = command as ChildProcess.StandardCommand;
      calls.push(standard.args);
      return Effect.succeed(
        calls.length === 1
          ? handle({
              chunks: [
                "! First copy your one-time co",
                "de: ABCD-1234\nOpen this URL in your web browser: https://github.com/login/device\n",
                "private auth transcript should not appear in state",
              ],
              exitCode: Deferred.await(loginExit),
            })
          : handle(),
      );
    });
    const auth = yield* make({ commandAvailable: () => true, environment: () => ({}) }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    assert.strictEqual((yield* auth.start).status, "running");
    const prompt = yield* waitForState(auth, (state) => state.userCode !== null);
    assert.strictEqual(prompt?.userCode, "ABCD-1234");
    assert.strictEqual(prompt?.verificationUrl, "https://github.com/login/device");
    assert.strictEqual((yield* auth.start).userCode, "ABCD-1234");
    assert.strictEqual(calls.length, 1);

    yield* Deferred.succeed(loginExit, ChildProcessSpawner.ExitCode(0));
    const completed = yield* waitForState(auth, (state) => state.status === "succeeded");
    assert.deepStrictEqual(completed, {
      status: "succeeded",
      userCode: null,
      verificationUrl: null,
      message: "Signed in to GitHub.",
    });
    assert.deepStrictEqual(calls, [
      ["auth", "login", "--hostname", "github.com", "--web"],
      ["api", "--hostname", "github.com", "user", "--silent"],
      ["auth", "setup-git", "--hostname", "github.com"],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("cancels only its login process and can start a fresh sign-in", () =>
  Effect.gen(function* () {
    let killed = 0;
    let spawned = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawned += 1;
      return Effect.succeed(
        handle({
          chunks: ["First copy your one-time code: ABCD-1234"],
          exitCode: Effect.never,
          kill: () =>
            Effect.sync(() => {
              killed += 1;
            }),
        }),
      );
    });
    const auth = yield* make({ commandAvailable: () => true, environment: () => ({}) }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    yield* auth.start;
    yield* waitForState(auth, (state) => state.userCode !== null);
    yield* auth.cancel;
    assert.strictEqual(killed, 1);
    assert.deepStrictEqual(yield* auth.getState, {
      status: "cancelled",
      userCode: null,
      verificationUrl: null,
      message: "GitHub sign-in cancelled.",
    });
    yield* auth.start;
    yield* waitForState(auth, (state) => state.userCode !== null);
    assert.strictEqual(spawned, 2);
    yield* auth.cancel;
  }).pipe(Effect.scoped),
);

it.effect("configures Git access when Git is installed after GitHub sign-in", () =>
  Effect.gen(function* () {
    let gitInstalled = false;
    let gitConfigured = false;
    const spawner = ChildProcessSpawner.make((command) => {
      assert.strictEqual(command._tag, "StandardCommand");
      const standard = command as ChildProcess.StandardCommand;
      if (standard.args.includes("setup-git")) {
        assert.strictEqual(gitInstalled, true);
        gitConfigured = true;
      }
      return Effect.succeed(handle());
    });
    const options = {
      commandAvailable: (command: string) => command === "gh" || gitInstalled,
      environment: () => ({}),
    };
    const createAuth = make(options).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const auth = yield* createAuth;
    yield* auth.start;
    yield* waitForState(auth, (state) => state.status === "succeeded");
    assert.strictEqual(gitConfigured, false);

    // A restart clears the in-memory sign-in state, but the CLI keeps its credential.
    const restarted = yield* createAuth;
    gitInstalled = true;
    yield* restarted.configureGit;
    assert.strictEqual(gitConfigured, true);
    assert.strictEqual((yield* restarted.getState).status, "idle");
  }).pipe(Effect.scoped),
);

it.effect("leaves Git credentials alone when GitHub has no working sign-in", () =>
  Effect.gen(function* () {
    let gitConfigured = false;
    const auth = yield* make({ commandAvailable: () => true, environment: () => ({}) }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          assert.strictEqual(command._tag, "StandardCommand");
          const standard = command as ChildProcess.StandardCommand;
          gitConfigured ||= standard.args.includes("setup-git");
          return Effect.succeed(
            handle({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }),
          );
        }),
      ),
    );
    yield* auth.configureGit;
    assert.strictEqual(gitConfigured, false);
    assert.strictEqual((yield* auth.getState).status, "idle");
  }).pipe(Effect.scoped),
);

it.effect("reports a Git configuration failure without exposing the CLI output", () =>
  Effect.gen(function* () {
    const auth = yield* make({ commandAvailable: () => true, environment: () => ({}) }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          assert.strictEqual(command._tag, "StandardCommand");
          const standard = command as ChildProcess.StandardCommand;
          return Effect.succeed(
            handle({
              chunks: ["private-token-value"],
              exitCode: Effect.succeed(
                ChildProcessSpawner.ExitCode(standard.args.includes("setup-git") ? 1 : 0),
              ),
            }),
          );
        }),
      ),
    );
    const result = yield* Effect.result(auth.configureGit);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure.operation, "configureGit");
      assert.match(result.failure.detail, /Git is installed/);
      assert.match(result.failure.detail, /gh auth setup-git --hostname github.com/);
      assert.notMatch(result.failure.detail, /private-token-value/);
    }
  }).pipe(Effect.scoped),
);

it.effect("rejects credential overrides before starting and never exposes their values", () =>
  Effect.gen(function* () {
    let spawned = false;
    const auth = yield* make({
      commandAvailable: () => true,
      environment: () => ({ GH_TOKEN: "private-token-value" }),
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawned = true;
          return Effect.succeed(handle());
        }),
      ),
    );
    const result = yield* Effect.result(auth.start);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(result.failure.detail, /GH_TOKEN/);
      assert.notMatch(result.failure.detail, /private-token-value/);
    }
    assert.strictEqual(spawned, false);
    assert.strictEqual((yield* auth.getState).status, "idle");
  }).pipe(Effect.scoped),
);

it.effect("clears the device code after timeout and stops the login process", () =>
  Effect.gen(function* () {
    let killed = 0;
    const auth = yield* make({ commandAvailable: () => true, environment: () => ({}) }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            handle({
              chunks: ["First copy your one-time code: ABCD-1234"],
              exitCode: Effect.never,
              kill: () =>
                Effect.sync(() => {
                  killed += 1;
                }),
            }),
          ),
        ),
      ),
    );
    yield* auth.start;
    yield* waitForState(auth, (state) => state.userCode !== null);
    yield* TestClock.adjust("15 minutes");
    const failed = yield* waitForState(auth, (state) => state.status === "failed");
    assert.strictEqual(failed?.userCode, null);
    assert.match(failed?.message ?? "", /timed out/);
    assert.strictEqual(killed, 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "does not report success or configure Git when the saved credential fails verification",
  () =>
    Effect.gen(function* () {
      let spawned = 0;
      const auth = yield* make({ commandAvailable: () => true, environment: () => ({}) }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            spawned += 1;
            return Effect.succeed(
              handle({
                chunks: ["private-token-value"],
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(spawned === 1 ? 0 : 1)),
              }),
            );
          }),
        ),
      );
      yield* auth.start;
      const failed = yield* waitForState(auth, (state) => state.status === "failed");
      assert.strictEqual(spawned, 2);
      assert.strictEqual(failed?.userCode, null);
      assert.match(failed?.message ?? "", /could not verify/);
      assert.notMatch(failed?.message ?? "", /private-token-value/);
    }).pipe(Effect.scoped),
);
