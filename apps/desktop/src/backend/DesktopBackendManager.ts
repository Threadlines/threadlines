import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import {
  DESKTOP_LAUNCH_ID_HEADER,
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@threadlines/contracts";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopCrashReport from "../app/DesktopCrashReport.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopStartupFailurePrompt from "../window/DesktopStartupFailurePrompt.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
// Failed spawns before the first successful readiness stop looping and become
// a visible startup-failure prompt. Once the backend has been ready this app
// session, restarts stay unbounded: the window exists, so a crash there is
// not an invisible wedge.
const MAX_STARTUP_ATTEMPTS = 3;
// Cap on the retained stderr needed for a useful crash report.
const STDERR_TAIL_MAX_CHARS = 8_192;
// How long a finished process's output drains may lag its exit.
const DRAIN_FLUSH_TIMEOUT = Duration.seconds(1);
const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);
const DEFAULT_BACKEND_READINESS_INTERVAL = Duration.millis(100);
const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
// Give the server's shutdown finalizers time to pause and persist active
// provider goals before falling back to a force kill.
const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(8);
const BACKEND_READINESS_PATH = "/.well-known/threadlines/environment";

type BackendProcessLayerServices = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

type BackendProcessRunRequirements = BackendProcessLayerServices | Scope.Scope;

export type BackendProcessOutputStream = "stdout" | "stderr";

export interface DesktopBackendStartConfig {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly httpBaseUrl: URL;
  readonly captureOutput: boolean;
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
  readonly result: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
}

export class BackendTimeoutError extends Data.TaggedError("BackendTimeoutError")<{
  readonly url: URL;
  readonly timeoutMs: number;
}> {
  override get message() {
    return `Timed out waiting ${this.timeoutMs}ms for backend readiness at ${this.url.href}.`;
  }
}

class BackendProcessBootstrapEncodeError extends Data.TaggedError(
  "BackendProcessBootstrapEncodeError",
)<{
  readonly cause: Schema.SchemaError;
}> {
  override get message() {
    return `Failed to encode desktop backend bootstrap payload: ${this.cause.message}`;
  }
}

class BackendProcessSpawnError extends Data.TaggedError("BackendProcessSpawnError")<{
  readonly cause: PlatformError.PlatformError;
}> {
  override get message() {
    return `Failed to spawn desktop backend process: ${this.cause.message}`;
  }
}

type BackendProcessError = BackendProcessBootstrapEncodeError | BackendProcessSpawnError;

interface RunBackendProcessOptions extends DesktopBackendStartConfig {
  readonly readinessTimeout?: Duration.Duration;
  readonly onStarted?: (pid: number) => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
  readonly onReadinessFailure?: (error: BackendTimeoutError) => Effect.Effect<void>;
  readonly onOutput?: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
}

export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
}

export interface DesktopBackendManagerShape {
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
}

export class DesktopBackendManager extends Context.Service<
  DesktopBackendManager,
  DesktopBackendManagerShape
>()("threadlines/desktop/BackendManager") {}

const { logWarning: logBackendManagerWarning, logError: logBackendManagerError } =
  DesktopObservability.makeComponentLogger("desktop-backend-manager");

interface ActiveBackendRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  /** True once any run reached readiness in this app session. */
  readonly everReady: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  /** Startup-failure dialog in flight; interrupted by stop(). */
  readonly promptFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  everReady: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  promptFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveBackendRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const closeRun = (
  run: ActiveBackendRun,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<void> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));

  return (
    options?.timeout ? close.pipe(Effect.timeoutOption(options.timeout), Effect.asVoid) : close
  ).pipe(Effect.ignore);
};

class BackendIdentityMismatchError extends Data.TaggedError("BackendIdentityMismatchError")<{
  readonly url: URL;
}> {
  override get message() {
    return `A server answered at ${this.url.href} without echoing this launch's id, so it is not the backend this desktop started.`;
  }
}

const waitForHttpReady = Effect.fn("desktop.backendManager.waitForHttpReady")(function* (
  baseUrl: URL,
  timeout: Duration.Duration,
  expectedLaunchId: string | undefined,
): Effect.fn.Return<void, BackendTimeoutError, HttpClient.HttpClient> {
  const readinessUrl = new URL(BACKEND_READINESS_PATH, baseUrl);
  const timeoutMs = Duration.toMillis(timeout);
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    // A 200 alone is not proof of life: an unrelated app on the same port (a
    // sibling fork's SPA fallback answers every GET) must keep reading as
    // "not ready yet", not open the window onto a foreign server.
    HttpClient.transformResponse((responseEffect) =>
      responseEffect.pipe(
        Effect.timeout(DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT),
        Effect.flatMap((response) =>
          expectedLaunchId === undefined ||
          response.headers[DESKTOP_LAUNCH_ID_HEADER] === expectedLaunchId
            ? Effect.succeed(response)
            : Effect.fail(new BackendIdentityMismatchError({ url: readinessUrl })),
        ),
      ),
    ),
    HttpClient.retry(Schedule.spaced(DEFAULT_BACKEND_READINESS_INTERVAL)),
  );

  yield* client.get(readinessUrl).pipe(
    Effect.withTracerEnabled(false),
    Effect.asVoid,
    Effect.timeout(timeout),
    Effect.mapError(() => new BackendTimeoutError({ url: readinessUrl, timeoutMs })),
  );
});

function describeProcessExit(
  result: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
): BackendProcessExit {
  if (Result.isSuccess(result)) {
    return {
      code: Option.some(result.success),
      reason: `code=${result.success}`,
      result,
    };
  }

  return {
    code: Option.none(),
    reason: result.failure.message,
    result,
  };
}

function drainBackendOutput(
  streamName: BackendProcessOutputStream,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutput: (streamName: BackendProcessOutputStream, chunk: Uint8Array) => Effect.Effect<void>,
): Effect.Effect<void> {
  return stream.pipe(
    Stream.runForEach((chunk) => onOutput(streamName, chunk)),
    Effect.ignore,
  );
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  options: RunBackendProcessOptions,
): Effect.fn.Return<
  { readonly exit: BackendProcessExit; readonly flushOutput: Effect.Effect<void> },
  BackendProcessError,
  BackendProcessRunRequirements
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapJson(options.bootstrap).pipe(
    Effect.mapError((cause) => new BackendProcessBootstrapEncodeError({ cause })),
  );
  const onOutput = options.onOutput ?? (() => Effect.void);
  const command = ChildProcess.make(
    options.executablePath,
    [options.entryPath, "--bootstrap-fd", "3"],
    hideWindowsConsole({
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      stdin: "ignore",
      stdout: options.captureOutput ? "pipe" : "inherit",
      stderr: options.captureOutput ? "pipe" : "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
      additionalFds: {
        fd3: {
          type: "input",
          stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
        },
      },
    }),
  );

  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError((cause) => new BackendProcessSpawnError({ cause })));

  yield* options.onStarted?.(handle.pid) ?? Effect.void;
  const drainFibers: Array<Fiber.Fiber<void, never>> = [];
  if (options.captureOutput) {
    drainFibers.push(
      yield* drainBackendOutput("stdout", handle.stdout, onOutput).pipe(Effect.forkScoped),
      yield* drainBackendOutput("stderr", handle.stderr, onOutput).pipe(Effect.forkScoped),
    );
  }
  yield* waitForHttpReady(
    options.httpBaseUrl,
    options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
    options.bootstrap.desktopLaunchId,
  ).pipe(
    Effect.tap(() => options.onReady?.() ?? Effect.void),
    Effect.catch((error) => options.onReadinessFailure?.(error) ?? Effect.void),
    Effect.forkScoped,
  );

  const exit = describeProcessExit(yield* Effect.result(handle.exitCode));
  // Joining the drains here would delay finalization (and make a dead run
  // look active to start()), so the caller decides when to flush: bounded,
  // and only where the buffered tail is actually read.
  const flushOutput = Effect.forEach(drainFibers, (fiber) =>
    Fiber.await(fiber).pipe(Effect.timeoutOption(DRAIN_FLUSH_TIMEOUT), Effect.asVoid),
  ).pipe(Effect.asVoid);
  return { exit, flushOutput };
});

const makeDesktopBackendManager = Effect.fn("makeDesktopBackendManager")(function* () {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
  const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;
  const desktopState = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const startupFailurePrompt = yield* DesktopStartupFailurePrompt.DesktopStartupFailurePrompt;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map(
      (current): DesktopBackendSnapshot => ({
        desiredRunning: current.desiredRunning,
        ready: current.ready,
        activePid: activePid(current.active),
        restartAttempt: current.restartAttempt,
        restartScheduled: Option.isSome(current.restartFiber),
      }),
    ),
  );
  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      {
        ...current,
        restartFiber: Option.none(),
      },
    ]);

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (Option.isSome(current.active)) {
          return;
        }

        yield* Ref.set(desktopState.backendReady, false);
        const config = yield* configuration.resolve;
        const entryExists = yield* fileSystem
          .exists(config.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        yield* cancelRestart;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
          ready: false,
          config: Option.some(config),
        }));

        if (!entryExists) {
          const reason = `missing server entry at ${config.entryPath}`;
          const latest = yield* Ref.get(state);
          // Same cap as a crashing spawn: a broken install must not retry
          // invisibly forever either.
          if (!latest.everReady && latest.restartAttempt >= MAX_STARTUP_ATTEMPTS - 1) {
            yield* Ref.update(state, (current) => ({
              ...current,
              desiredRunning: false,
            }));
            yield* triggerStartupFailure({
              failureKind: "process-exit",
              attempts: latest.restartAttempt + 1,
              lastExitCode: Option.none(),
              lastReason: reason,
              stderrTail: "",
            });
            return;
          }
          yield* scheduleRestart(reason);
          return;
        }

        const runScope = yield* Scope.make("sequential");
        // Per-run crash-report inputs: the stderr tail carries the fatal
        // error when the process dies, the timeout marker reroutes a
        // killed-for-unresponsiveness exit away from the restart path.
        const stderrTailRef = yield* Ref.make("");
        const stderrDecoder = new TextDecoder();
        const readinessTimeoutRef = yield* Ref.make(Option.none<BackendTimeoutError>());
        const runId = yield* Ref.modify(state, (latest) => [
          latest.nextRunId,
          {
            ...latest,
            active: Option.some({
              id: latest.nextRunId,
              scope: runScope,
              fiber: Option.none(),
              pid: Option.none(),
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        const finalizeRun = Effect.fn("desktop.backendManager.finalizeRun")(function* (
          reason: string,
          exitCode: Option.Option<number>,
          flushOutput: Effect.Effect<void>,
        ) {
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid } = yield* Ref.modify(
                state,
                (
                  latest,
                ): readonly [
                  {
                    readonly isCurrentRun: boolean;
                    readonly nextState: BackendManagerState;
                    readonly pid: Option.Option<number>;
                  },
                  BackendManagerState,
                ] => {
                  const currentRun = Option.getOrUndefined(latest.active);
                  if (currentRun?.id !== runId) {
                    return [
                      {
                        isCurrentRun: false,
                        nextState: latest,
                        pid: Option.none<number>(),
                      },
                      latest,
                    ] as const;
                  }

                  const next = {
                    ...latest,
                    active: Option.none<ActiveBackendRun>(),
                    ready: false,
                  };
                  return [
                    {
                      isCurrentRun: true,
                      nextState: next,
                      pid: currentRun.pid,
                    },
                    next,
                  ] as const;
                },
              );

              if (isCurrentRun) {
                if (Option.isSome(pid)) {
                  yield* backendOutputLog.writeSessionBoundary({
                    phase: "END",
                    details: `pid=${pid.value} ${reason}`,
                  });
                }
                yield* Ref.set(desktopState.backendReady, false);
              }

              if (!isCurrentRun || !nextState.desiredRunning) {
                return;
              }

              const readinessTimeout = yield* Ref.get(readinessTimeoutRef);
              const startupFailed =
                !nextState.everReady &&
                (Option.isSome(readinessTimeout) ||
                  nextState.restartAttempt >= MAX_STARTUP_ATTEMPTS - 1);
              if (!startupFailed) {
                yield* scheduleRestart(reason);
                return;
              }

              // Stop trying; the prompt fiber owns what happens next.
              yield* Ref.update(state, (latest) => ({
                ...latest,
                desiredRunning: false,
              }));
              // Let buffered output land in the tail before reading it.
              yield* flushOutput;
              const stderrTail = yield* Ref.get(stderrTailRef);
              yield* triggerStartupFailure({
                failureKind: Option.isSome(readinessTimeout) ? "readiness-timeout" : "process-exit",
                attempts: nextState.restartAttempt + 1,
                lastExitCode: exitCode,
                lastReason: Option.match(readinessTimeout, {
                  onNone: () => reason,
                  onSome: (timeout) => timeout.message,
                }),
                stderrTail,
              });
            }),
          );
        });

        const program = runBackendProcess({
          ...config,
          onStarted: Effect.fn("desktop.backendManager.onStarted")(function* (pid) {
            yield* updateActiveRun(runId, (run) => ({
              ...run,
              pid: Option.some(pid),
            }));
            yield* backendOutputLog.writeSessionBoundary({
              phase: "START",
              details: `pid=${pid} port=${config.bootstrap.port} cwd=${config.cwd}`,
            });
          }),
          onReady: Effect.fn("desktop.backendManager.onReady")(function* () {
            const isCurrentRun = yield* Ref.modify(state, (latest) => {
              const activeRun = Option.getOrUndefined(latest.active);
              if (activeRun?.id !== runId) {
                return [false, latest] as const;
              }

              return [
                true,
                {
                  ...latest,
                  restartAttempt: 0,
                  ready: true,
                  everReady: true,
                },
              ] as const;
            });
            if (!isCurrentRun) {
              return;
            }

            yield* Ref.set(desktopState.backendReady, true);
            yield* desktopWindow.handleBackendReady.pipe(
              Effect.catch((error) =>
                logBackendManagerError("failed to open main window after backend readiness", {
                  message: error.message,
                }),
              ),
            );
          }),
          onReadinessFailure: (error) =>
            Effect.gen(function* () {
              yield* logBackendManagerWarning("backend readiness check failed during bootstrap", {
                error: error.message,
              });
              const latest = yield* Ref.get(state);
              if (latest.everReady) {
                return;
              }
              // Before the first readiness there is no window: a process that
              // is alive but unresponsive would sit invisible forever. Mark
              // the run and kill it so finalizeRun surfaces the failure
              // instead of scheduling a restart.
              yield* Ref.set(readinessTimeoutRef, Option.some(error));
              const run = Option.getOrUndefined(latest.active);
              if (run?.id === runId) {
                yield* Effect.forkIn(closeRun(run), parentScope);
              }
            }),
          onOutput: (streamName, chunk) =>
            streamName === "stderr"
              ? backendOutputLog.writeOutputChunk(streamName, chunk).pipe(
                  Effect.andThen(
                    Ref.update(stderrTailRef, (tail) => {
                      const appended = tail + stderrDecoder.decode(chunk, { stream: true });
                      return appended.length <= STDERR_TAIL_MAX_CHARS
                        ? appended
                        : appended.slice(appended.length - STDERR_TAIL_MAX_CHARS);
                    }),
                  ),
                )
              : backendOutputLog.writeOutputChunk(streamName, chunk),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) => finalizeRun(error.message, Option.none(), Effect.void),
            onSuccess: ({ exit, flushOutput }) => finalizeRun(exit.reason, exit.code, flushOutput),
          }),
          Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
        );

        const fiber = yield* Effect.forkIn(program, parentScope);
        yield* updateActiveRun(runId, (run) => ({
          ...run,
          fiber: Option.some(fiber),
        }));
      }),
    ),
  ).pipe(Effect.withSpan("desktop.backendManager.start"));

  const scheduleRestart = Effect.fn("desktop.backendManager.scheduleRestart")(function* (
    reason: string,
  ) {
    const scheduled = yield* Ref.modify(state, (latest) => {
      if (!latest.desiredRunning || Option.isSome(latest.restartFiber)) {
        return [Option.none<Duration.Duration>(), latest] as const;
      }

      const delay = calculateRestartDelay(latest.restartAttempt);
      return [
        Option.some(delay),
        {
          ...latest,
          restartAttempt: latest.restartAttempt + 1,
        },
      ] as const;
    });

    yield* Option.match(scheduled, {
      onNone: () => Effect.void,
      onSome: Effect.fn("desktop.backendManager.scheduleRestartFiber")(function* (delay) {
        yield* logBackendManagerError("backend exited unexpectedly; restart scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        });
        const restartFiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Ref.modify(state, (latest) => {
                const shouldRestart = latest.desiredRunning;
                return [
                  shouldRestart,
                  {
                    ...latest,
                    restartFiber: Option.none(),
                  },
                ] as const;
              }),
            ),
            Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
            Effect.catchCause((cause) =>
              logBackendManagerError("desktop backend restart fiber failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
          parentScope,
        );
        yield* Ref.update(state, (latest) =>
          Option.isNone(latest.restartFiber)
            ? {
                ...latest,
                restartFiber: Option.some(restartFiber),
              }
            : latest,
        );
      }),
    });
  });

  // Forked so the (possibly minutes-long) dialog never blocks the manager
  // mutex. "quit" is handled inside the prompt; "retry" resets the failure
  // budget and starts over. The fiber is tracked in state so stop() can
  // cancel a pending dialog's consequences.
  const triggerStartupFailure = Effect.fn("desktop.backendManager.triggerStartupFailure")(
    function* (report: DesktopCrashReport.DesktopStartupFailureReport) {
      const promptFiber = yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* logBackendManagerError("backend failed to start; showing startup failure prompt", {
            failureKind: report.failureKind,
            attempts: report.attempts,
            reason: report.lastReason,
          });
          const action = yield* startupFailurePrompt.handle(report);
          if (action !== "retry") {
            return;
          }
          // Someone may have started the backend while the dialog was open;
          // retry must not fight them.
          const shouldStart = yield* Ref.modify(state, (latest) =>
            latest.desiredRunning
              ? ([false, latest] as const)
              : ([true, { ...latest, restartAttempt: 0 }] as const),
          );
          if (shouldStart) {
            yield* start;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            logBackendManagerError("startup failure prompt failed", {
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.ensuring(
            Ref.update(state, (latest) => ({
              ...latest,
              promptFiber: Option.none<Fiber.Fiber<void, never>>(),
            })),
          ),
        ),
        parentScope,
      );
      yield* Ref.update(state, (latest) => ({
        ...latest,
        promptFiber: Option.some(promptFiber),
      }));
    },
  );

  const stop = Effect.fn("desktop.backendManager.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber, promptFiber } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (latest) => [
          {
            active: latest.active,
            restartFiber: latest.restartFiber,
            promptFiber: latest.promptFiber,
          },
          {
            ...latest,
            desiredRunning: false,
            ready: false,
            active: Option.none<ActiveBackendRun>(),
            restartFiber: Option.none<Fiber.Fiber<void, never>>(),
            promptFiber: Option.none<Fiber.Fiber<void, never>>(),
          },
        ]);
        yield* Ref.set(desktopState.backendReady, false);
        return result;
      }),
    );

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    // A stale startup-failure dialog must not resurrect the backend after a
    // stop; the OS dialog itself stays visible but its choice goes nowhere.
    yield* Option.match(promptFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) => closeRun(run, options),
    });
  });

  yield* Effect.addFinalizer(() => stop());

  return DesktopBackendManager.of({
    start,
    stop,
    currentConfig,
    snapshot,
  });
});

export const layer = Layer.effect(DesktopBackendManager, makeDesktopBackendManager());
