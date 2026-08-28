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
import * as DesktopDatabaseRecovery from "./DesktopDatabaseRecovery.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
// Failed spawns before the first successful readiness stop looping and become
// a visible startup-failure prompt. Once the backend has been ready this app
// session, restarts stay unbounded: the window exists, so a crash there is
// not an invisible wedge.
const MAX_STARTUP_ATTEMPTS = 3;
// Cap on the retained stdout+stderr needed for a useful crash report.
const OUTPUT_TAIL_MAX_CHARS = 8_192;
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
  /** Changes whenever an explicit start or stop supersedes automatic work. */
  readonly intentGeneration: number;
  readonly ready: boolean;
  /** True once any run reached readiness in this app session. */
  readonly everReady: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  /** Startup-failure dialog in flight; interrupted by stop(). */
  readonly promptFiber: Option.Option<Fiber.Fiber<void, never>>;
  /** Prevents an automatic recovery loop until the user explicitly retries. */
  readonly automaticDatabaseRecoveryAttempted: boolean;
  /** Shown only after the replacement database reaches readiness. */
  readonly pendingDatabaseRecoveryNotice: Option.Option<DesktopDatabaseRecovery.DesktopDatabaseRecoveryResult>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  intentGeneration: 0,
  ready: false,
  everReady: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  promptFiber: Option.none(),
  automaticDatabaseRecoveryAttempted: false,
  pendingDatabaseRecoveryNotice: Option.none(),
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
  const databaseRecovery = yield* DesktopDatabaseRecovery.DesktopDatabaseRecovery;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopBackendSnapshot => ({
      desiredRunning: current.desiredRunning,
      ready: current.ready,
      activePid: activePid(current.active),
      restartAttempt: current.restartAttempt,
      restartScheduled: Option.isSome(current.restartFiber),
    })),
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

  const startIfDesired: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        // Automatic work may only continue an existing run intent. If stop()
        // won first, do not turn the backend back on.
        if (!current.desiredRunning) {
          return;
        }
        if (Option.isSome(current.active)) {
          return;
        }

        const startIntentGeneration = current.intentGeneration;

        yield* Ref.set(desktopState.backendReady, false);
        const pendingRecovery = yield* Effect.result(databaseRecovery.completePendingRecovery);
        if (Result.isFailure(pendingRecovery)) {
          const shouldReport = yield* Ref.modify(state, (latest) =>
            latest.intentGeneration === startIntentGeneration
              ? ([true, { ...latest, desiredRunning: false }] as const)
              : ([false, latest] as const),
          );
          if (!shouldReport) {
            return;
          }
          yield* logBackendManagerError("pending database recovery could not be completed", {
            message: pendingRecovery.failure.message,
            backupDir: pendingRecovery.failure.backupDir,
          });
          yield* triggerStartupFailure({
            failureKind: "process-exit",
            attempts: 1,
            lastExitCode: Option.none(),
            lastReason: "database recovery could not be completed",
            outputTail: `[cause]: DesktopDatabaseRecoveryError: ${pendingRecovery.failure.message}`,
          });
          return;
        }
        if (Option.isSome(pendingRecovery.success)) {
          yield* logBackendManagerWarning("interrupted database recovery completed", {
            backupDir: pendingRecovery.success.value.backupDir,
            preservedFiles: pendingRecovery.success.value.preservedFiles.join(","),
          });
          yield* Ref.update(state, (latest) => ({
            ...latest,
            automaticDatabaseRecoveryAttempted: true,
            pendingDatabaseRecoveryNotice: pendingRecovery.success,
          }));
        }
        const config = yield* configuration.resolve;
        const entryExists = yield* fileSystem
          .exists(config.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        yield* cancelRestart;
        const shouldContinue = yield* Ref.modify(state, (latest) =>
          latest.intentGeneration === startIntentGeneration && latest.desiredRunning
            ? ([
                true,
                {
                  ...latest,
                  ready: false,
                  config: Option.some(config),
                },
              ] as const)
            : ([false, latest] as const),
        );
        if (!shouldContinue) {
          return;
        }

        if (!entryExists) {
          const reason = `missing server entry at ${config.entryPath}`;
          const latest = yield* Ref.get(state);
          // Same cap as a crashing spawn: a broken install must not retry
          // invisibly forever either.
          if (!latest.everReady && latest.restartAttempt >= MAX_STARTUP_ATTEMPTS - 1) {
            const shouldReport = yield* Ref.modify(state, (current) =>
              current.intentGeneration === startIntentGeneration
                ? ([true, { ...current, desiredRunning: false }] as const)
                : ([false, current] as const),
            );
            if (shouldReport) {
              yield* triggerStartupFailure({
                failureKind: "process-exit",
                attempts: latest.restartAttempt + 1,
                lastExitCode: Option.none(),
                lastReason: reason,
                outputTail: "",
              });
            }
            return;
          }
          yield* scheduleRestart(reason);
          return;
        }

        const runScope = yield* Scope.make("sequential");
        // Per-run crash-report inputs: the output tail carries the fatal
        // error when the process dies, the timeout marker reroutes a
        // killed-for-unresponsiveness exit away from the restart path. Both
        // streams feed the tail — the server's Effect logger reports fatal
        // causes on stdout, and field crash reports came back empty when
        // only stderr was kept.
        const outputTailRef = yield* Ref.make("");
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        const readinessTimeoutRef = yield* Ref.make(Option.none<BackendTimeoutError>());
        const runIdOption = yield* Ref.modify(state, (latest) =>
          latest.intentGeneration === startIntentGeneration && latest.desiredRunning
            ? ([
                Option.some(latest.nextRunId),
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
              ] as const)
            : ([Option.none<number>(), latest] as const),
        );
        if (Option.isNone(runIdOption)) {
          yield* Scope.close(runScope, Exit.void).pipe(Effect.ignore);
          return;
        }
        const runId = runIdOption.value;

        const finalizeRun = Effect.fn("desktop.backendManager.finalizeRun")(function* (
          reason: string,
          exitCode: Option.Option<number>,
          flushOutput: Effect.Effect<void>,
        ) {
          const restartAfterRecovery = yield* mutex.withPermits(1)(
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
                return false;
              }

              const readinessTimeout = yield* Ref.get(readinessTimeoutRef);
              const startupFailed =
                !nextState.everReady &&
                (Option.isSome(readinessTimeout) ||
                  nextState.restartAttempt >= MAX_STARTUP_ATTEMPTS - 1);
              if (!startupFailed) {
                yield* scheduleRestart(reason);
                return false;
              }

              // Stop trying; the prompt fiber owns what happens next.
              yield* Ref.update(state, (latest) =>
                latest.intentGeneration === nextState.intentGeneration
                  ? { ...latest, desiredRunning: false }
                  : latest,
              );
              // Let buffered output land in the tail before reading it.
              yield* flushOutput;
              if ((yield* Ref.get(state)).intentGeneration !== nextState.intentGeneration) {
                return false;
              }
              const outputTail = yield* Ref.get(outputTailRef);
              let report: DesktopCrashReport.DesktopStartupFailureReport = {
                failureKind: Option.isSome(readinessTimeout) ? "readiness-timeout" : "process-exit",
                attempts: nextState.restartAttempt + 1,
                lastExitCode: exitCode,
                lastReason: Option.match(readinessTimeout, {
                  onNone: () => reason,
                  onSome: (timeout) => timeout.message,
                }),
                outputTail,
              };

              if (
                !nextState.automaticDatabaseRecoveryAttempted &&
                DesktopDatabaseRecovery.isDefinitiveSqliteCorruption(report)
              ) {
                yield* Ref.update(state, (latest) => ({
                  ...latest,
                  automaticDatabaseRecoveryAttempted: true,
                }));
                const recoveryResult = yield* Effect.result(
                  databaseRecovery.recoverIfCorrupt(report),
                );
                if (Result.isSuccess(recoveryResult)) {
                  const recovered = recoveryResult.success;
                  if (Option.isSome(recovered)) {
                    yield* logBackendManagerWarning(
                      "damaged SQLite database preserved; restarting with fresh state",
                      {
                        backupDir: recovered.value.backupDir,
                        preservedFiles: recovered.value.preservedFiles.join(","),
                      },
                    );
                    return yield* Ref.modify(state, (latest) => {
                      const intentIsCurrent =
                        latest.intentGeneration === nextState.intentGeneration;
                      return [
                        intentIsCurrent,
                        {
                          ...latest,
                          ...(intentIsCurrent ? { desiredRunning: true, restartAttempt: 0 } : {}),
                          pendingDatabaseRecoveryNotice: recovered,
                        },
                      ] as const;
                    });
                  }
                } else {
                  yield* logBackendManagerError("automatic database recovery failed", {
                    message: recoveryResult.failure.message,
                    backupDir: recoveryResult.failure.backupDir,
                  });
                  const recoveryDetail = `[cause]: DesktopDatabaseRecoveryError: ${recoveryResult.failure.message}`;
                  const combinedOutput = `${report.outputTail}\n${recoveryDetail}`;
                  report = {
                    ...report,
                    outputTail:
                      combinedOutput.length <= OUTPUT_TAIL_MAX_CHARS
                        ? combinedOutput
                        : combinedOutput.slice(combinedOutput.length - OUTPUT_TAIL_MAX_CHARS),
                  };
                }
              }

              if ((yield* Ref.get(state)).intentGeneration === nextState.intentGeneration) {
                yield* triggerStartupFailure(report);
              }
              return false;
            }),
          );
          if (restartAfterRecovery) {
            yield* startIfDesired;
          }
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
            const { isCurrentRun, recoveryNotice } = yield* Ref.modify(
              state,
              (
                latest,
              ): readonly [
                {
                  readonly isCurrentRun: boolean;
                  readonly recoveryNotice: Option.Option<DesktopDatabaseRecovery.DesktopDatabaseRecoveryResult>;
                },
                BackendManagerState,
              ] => {
                const activeRun = Option.getOrUndefined(latest.active);
                if (activeRun?.id !== runId) {
                  return [
                    {
                      isCurrentRun: false,
                      recoveryNotice:
                        Option.none<DesktopDatabaseRecovery.DesktopDatabaseRecoveryResult>(),
                    },
                    latest,
                  ] as const;
                }

                return [
                  {
                    isCurrentRun: true,
                    recoveryNotice: latest.pendingDatabaseRecoveryNotice,
                  },
                  {
                    ...latest,
                    restartAttempt: 0,
                    ready: true,
                    everReady: true,
                    pendingDatabaseRecoveryNotice:
                      Option.none<DesktopDatabaseRecovery.DesktopDatabaseRecoveryResult>(),
                  },
                ] as const;
              },
            );
            if (!isCurrentRun) {
              return;
            }

            yield* Ref.set(desktopState.backendReady, true);
            yield* desktopWindow.handleBackendReady.pipe(
              Effect.catch((error) =>
                logBackendManagerError("failed to open main window after backend readiness", {
                  message: error.message,
                }).pipe(
                  // No window appeared, so a later backend failure is still an
                  // invisible wedge: keep the startup failure cap armed.
                  Effect.andThen(Ref.update(state, (latest) => ({ ...latest, everReady: false }))),
                ),
              ),
            );
            if (Option.isSome(recoveryNotice)) {
              yield* Effect.forkIn(
                startupFailurePrompt.notifyDatabaseRecovery(recoveryNotice.value),
                parentScope,
              );
            }
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
            backendOutputLog.writeOutputChunk(streamName, chunk).pipe(
              Effect.andThen(
                Ref.update(outputTailRef, (tail) => {
                  const decoder = streamName === "stderr" ? stderrDecoder : stdoutDecoder;
                  const appended = tail + decoder.decode(chunk, { stream: true });
                  return appended.length <= OUTPUT_TAIL_MAX_CHARS
                    ? appended
                    : appended.slice(appended.length - OUTPUT_TAIL_MAX_CHARS);
                }),
              ),
            ),
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

  const start = Ref.modify(state, (latest) => {
    if (Option.isSome(latest.active)) {
      return [false, latest] as const;
    }
    const intentGeneration = latest.intentGeneration + 1;
    return [
      true,
      {
        ...latest,
        desiredRunning: true,
        intentGeneration,
      },
    ] as const;
  }).pipe(Effect.flatMap((shouldStart) => (shouldStart ? startIfDesired : Effect.void)));

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
            Effect.flatMap((shouldRestart) => (shouldRestart ? startIfDesired : Effect.void)),
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
              : ([
                  true,
                  {
                    ...latest,
                    restartAttempt: 0,
                    automaticDatabaseRecoveryAttempted: false,
                  },
                ] as const),
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
    // Publish stop intent before waiting for the manager mutex. Recovery may
    // be holding it while copying files; its generation check must see quit
    // immediately and must not schedule a replacement backend afterward.
    yield* Ref.update(state, (latest) => ({
      ...latest,
      desiredRunning: false,
      intentGeneration: latest.intentGeneration + 1,
    }));
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
