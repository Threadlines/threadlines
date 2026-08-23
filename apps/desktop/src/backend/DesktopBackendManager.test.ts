import {
  DESKTOP_LAUNCH_ID_HEADER,
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopStartupFailurePrompt from "../window/DesktopStartupFailurePrompt.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    threadlinesHome: "/tmp/threadlines",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const healthyHttpClientLayer = httpClientLayer((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

function makeManagerLayer(input: {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly desktopState?: DesktopState.DesktopStateShape;
  readonly desktopWindow?: Partial<DesktopWindow.DesktopWindowShape>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly startupFailurePrompt?: DesktopStartupFailurePrompt.DesktopStartupFailurePromptShape;
  readonly entryExists?: boolean;
}) {
  return DesktopBackendManager.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(input.entryExists ?? true),
        }),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolve: Effect.succeed(input.config ?? baseConfig),
        }),
        input.spawnerLayer,
        input.httpClientLayer ?? healthyHttpClientLayer,
        input.desktopState
          ? Layer.succeed(DesktopState.DesktopState, input.desktopState)
          : DesktopState.layer,
        Layer.succeed(DesktopObservability.DesktopBackendOutputLog, {
          writeSessionBoundary: () => Effect.void,
          writeOutputChunk: () => Effect.void,
          ...input.backendOutputLog,
        } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        Layer.succeed(
          DesktopStartupFailurePrompt.DesktopStartupFailurePrompt,
          input.startupFailurePrompt ?? {
            handle: () => Effect.die("unexpected startup failure prompt"),
          },
        ),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected createMain"),
          ensureMain: Effect.die("unexpected ensureMain"),
          revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
          activate: Effect.void,
          createMainIfBackendReady: Effect.void,
          handleBackendReady: Effect.void,
          allowMainWindowClose: Effect.void,
          requestQuitConfirmation: () => Effect.succeed(false),
          resolveQuitConfirmation: () => Effect.void,
          dispatchMenuAction: () => Effect.void,
          syncAppearance: Effect.void,
          ...input.desktopWindow,
        } satisfies DesktopWindow.DesktopWindowShape),
      ),
    ),
  );
}

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap JSON and reports HTTP readiness", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      let bootstrapJson = "";
      let readyCount = 0;
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawnedCommand = command;
            if (command._tag === "StandardCommand") {
              const fd3 = command.options.additionalFds?.fd3;
              if (fd3?.type === "input" && fd3.stream) {
                bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
              }
            }

            return makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        config: {
          ...baseConfig,
          bootstrap: configWithObservability,
        },
        spawnerLayer,
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          8_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.gen(function* () {
      const requestUrls: Array<string> = [];
      const statuses = [503, 200];
      let readyCount = 0;
      const firstRequest = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.gen(function* () {
            const status = statuses.shift();
            assert.isDefined(status);
            requestUrls.push(request.url);
            yield* Deferred.succeed(firstRequest, void 0);
            return responseForRequest(request, status);
          }),
        ),
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/threadlines/environment",
        ]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/threadlines/environment",
          "http://127.0.0.1:3773/.well-known/threadlines/environment",
        ]);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("treats a 200 without the expected launch id as not ready", () =>
    Effect.gen(function* () {
      // The T3 Code collision: an unrelated server answering on our port
      // returns 200 for every GET but cannot echo this spawn's launch id.
      const responses: Array<{ readonly status: number; readonly launchId?: string }> = [
        { status: 200 },
        { status: 200, launchId: "launch-1" },
      ];
      let readyCount = 0;
      const firstRequest = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        config: {
          ...baseConfig,
          bootstrap: { ...baseConfig.bootstrap, desktopLaunchId: "launch-1" },
        },
        httpClientLayer: httpClientLayer((request) =>
          Effect.gen(function* () {
            const next = responses.shift();
            assert.isDefined(next);
            yield* Deferred.succeed(firstRequest, void 0);
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: next.status,
                headers:
                  next.launchId === undefined ? {} : { [DESKTOP_LAUNCH_ID_HEADER]: next.launchId },
              }),
            );
          }),
        ),
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.equal(responses.length, 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it("includes the readiness timeout in backend timeout messages", () => {
    const error = new DesktopBackendManager.BackendTimeoutError({
      url: new URL("http://127.0.0.1:3773/.well-known/threadlines/environment"),
      timeoutMs: 1_500,
    });

    assert.equal(
      error.message,
      "Timed out waiting 1500ms for backend readiness at http://127.0.0.1:3773/.well-known/threadlines/environment.",
    );
  });

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.gen(function* () {
      let startCount = 0;
      let closedCount = 0;
      const closed = yield* Deferred.make<void>();
      const startedPids = yield* Queue.unbounded<number>();
      const ready = yield* Deferred.make<void>();
      const backendReady = yield* Ref.make(false);
      const quitting = yield* Ref.make(false);
      const runningThreadCount = yield* Ref.make(0);

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            startCount += 1;
            yield* Queue.offer(startedPids, 123);
            const close = Effect.sync(() => {
              closedCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(closed, void 0)), Effect.asVoid);

            yield* Scope.addFinalizer(scope, close);

            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        desktopState: {
          backendReady,
          quitting,
          runningThreadCount,
        },
        desktopWindow: {
          handleBackendReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        assert.isTrue(Option.isNone(yield* manager.currentConfig));

        yield* manager.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReady));
        assert.deepEqual(yield* manager.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* manager.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        yield* manager.stop();
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);

        const stoppedSnapshot = yield* manager.snapshot;
        assert.isFalse(yield* Ref.get(backendReady));
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect(
    "restarts a backend that dies before readiness, then caps at three attempts with a prompt",
    () =>
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const promptReports =
          yield* Queue.unbounded<DesktopStartupFailurePrompt.DesktopStartupFailureReport>();
        const promptAction =
          yield* Ref.make<DesktopStartupFailurePrompt.DesktopStartupFailureAction>("retry");
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const managerLayer = makeManagerLayer({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          startupFailurePrompt: {
            handle: (report) =>
              Queue.offer(promptReports, report).pipe(Effect.andThen(Ref.get(promptAction))),
          },
        });

        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;

          assert.equal(yield* Queue.take(starts), 1);

          yield* TestClock.adjust(Duration.millis(499));
          assert.equal(yield* Queue.size(starts), 0);
          yield* TestClock.adjust(Duration.millis(1));
          assert.equal(yield* Queue.take(starts), 2);

          yield* TestClock.adjust(Duration.millis(999));
          assert.equal(yield* Queue.size(starts), 0);
          yield* TestClock.adjust(Duration.millis(1));
          assert.equal(yield* Queue.take(starts), 3);

          // The third failed attempt surfaces the prompt instead of a fourth
          // silent restart.
          const firstReport = yield* Queue.take(promptReports);
          assert.equal(firstReport.failureKind, "process-exit");
          assert.equal(firstReport.attempts, 3);
          assert.deepEqual(firstReport.lastExitCode, Option.some(1));

          // "Try Again" resets the failure budget: a full new round of three.
          assert.equal(yield* Queue.take(starts), 4);
          yield* Ref.set(promptAction, "quit");
          yield* TestClock.adjust(Duration.millis(500));
          assert.equal(yield* Queue.take(starts), 5);
          yield* TestClock.adjust(Duration.seconds(1));
          assert.equal(yield* Queue.take(starts), 6);

          const secondReport = yield* Queue.take(promptReports);
          assert.equal(secondReport.attempts, 3);

          // "Quit" leaves the manager idle: no further spawns on any delay.
          yield* TestClock.adjust(Duration.seconds(30));
          assert.equal(yield* Queue.size(starts), 0);
        }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
      }),
  );

  it.effect("caps missing-entry retries with the same startup failure prompt", () =>
    Effect.gen(function* () {
      const promptReports =
        yield* Queue.unbounded<DesktopStartupFailurePrompt.DesktopStartupFailureReport>();
      let spawnCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawnCount += 1;
            return makeProcess();
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        entryExists: false,
        startupFailurePrompt: {
          handle: (report) => Queue.offer(promptReports, report).pipe(Effect.as("quit" as const)),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));

        const report = yield* Queue.take(promptReports);
        assert.equal(report.attempts, 3);
        assert.include(report.lastReason, "missing server entry");
        assert.equal(spawnCount, 0);

        yield* TestClock.adjust(Duration.seconds(30));
        assert.equal(yield* Queue.size(promptReports), 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect(
    "kills and reports a backend that never answers readiness before the first window",
    () =>
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const promptReports =
          yield* Queue.unbounded<DesktopStartupFailurePrompt.DesktopStartupFailureReport>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
              yield* Scope.addFinalizer(scope, close);
              return makeProcess({
                // The fatal cause lands on stdout, like the server's Effect
                // logger; stderr carries a secondary line. Both must reach
                // the crash-report tail.
                stdout: Stream.make(
                  new TextEncoder().encode("[FATAL] EADDRINUSE: port already bound\n"),
                ),
                stderr: Stream.make(new TextEncoder().encode("node exited\n")),
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(143))),
                kill: () => close,
              });
            }),
          ),
        );

        const managerLayer = makeManagerLayer({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          startupFailurePrompt: {
            handle: (report) => Queue.offer(promptReports, report).pipe(Effect.as("quit" as const)),
          },
        });

        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          assert.equal(yield* Queue.take(starts), 1);

          // The 60s readiness budget elapses without a single healthy answer.
          yield* TestClock.adjust(Duration.minutes(1));

          const report = yield* Queue.take(promptReports);
          assert.equal(report.failureKind, "readiness-timeout");
          assert.equal(report.attempts, 1);
          assert.include(report.lastReason, "Timed out");
          assert.include(report.outputTail, "EADDRINUSE");
          assert.include(report.outputTail, "node exited");

          // The unresponsive process was killed and nothing respawns.
          yield* TestClock.adjust(Duration.seconds(30));
          assert.equal(yield* Queue.size(starts), 0);
        }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
      }),
  );

  it.effect("keeps restarting without a prompt once the backend has been ready", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const exitFirstRun = yield* Deferred.make<void>();
      let startCount = 0;
      let requestCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            if (startCount === 1) {
              return makeProcess({
                exitCode: Deferred.await(exitFirstRun).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }
            const scope = yield* Scope.Scope;
            const closed = yield* Deferred.make<void>();
            yield* Scope.addFinalizer(scope, Deferred.succeed(closed, void 0).pipe(Effect.asVoid));
            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
        ),
      );

      // First run answers healthy; every later run never answers, which after
      // readiness must stay a logged warning, not a kill or a prompt.
      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.suspend(() => {
            requestCount += 1;
            return requestCount === 1
              ? Effect.succeed(responseForRequest(request, 200))
              : Effect.never;
          }),
        ),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        // Wait for readiness, then crash the first run.
        yield* Effect.gen(function* () {
          while (!(yield* manager.snapshot).ready) {
            yield* Effect.yieldNow;
          }
        });
        yield* Deferred.succeed(exitFirstRun, void 0);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);

        // The second run never becomes ready; the 60s readiness timeout must
        // leave it running instead of surfacing a startup failure.
        yield* TestClock.adjust(Duration.minutes(2));
        const snapshot = yield* manager.snapshot;
        assert.equal(Option.isSome(snapshot.activePid), true);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const secondClosed = yield* Deferred.make<void>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);

            if (startCount === 1) {
              return makeProcess({
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              });
            }

            const scope = yield* Scope.Scope;
            const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
            yield* Scope.addFinalizer(scope, close);
            return makeProcess({
              exitCode: Deferred.await(secondClosed).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        assert.equal(yield* Queue.take(starts), 1);

        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* manager.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            startCount += 1;
            return makeProcess({
              exitCode: Queue.offer(starts, startCount).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(1)),
              ),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* manager.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* manager.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* manager.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );
});
