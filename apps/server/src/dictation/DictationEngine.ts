// @effect-diagnostics nodeBuiltinImport:off - forks the worker child process
/**
 * DictationEngine - owns the transcription worker child process.
 *
 * Exactly one worker exists at a time. It is spawned lazily on the first
 * `load`, keeps the recognizer resident between clips, and is killed on a
 * crash, on a request timeout, after ten idle minutes, or when the layer's
 * scope closes. Callers see the transitions through `changes`.
 *
 * @module dictation/DictationEngine
 */
import * as childProcess from "node:child_process";
import * as nodePath from "node:path";

import {
  DictationError,
  type DictationEngineState,
  type DictationModelId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { DICTATION_ADDON_FILE, type DictationLibraryPathEnv } from "./catalog.ts";
import type { DictationWorkerRequest, DictationWorkerResponse } from "./worker.ts";

/** Long enough for a cold model load plus a two-minute clip on slow hardware. */
const REQUEST_TIMEOUT = Duration.seconds(60);
/** The recognizer holds hundreds of megabytes; drop it when nobody dictates. */
const IDLE_UNLOAD_DELAY = Duration.minutes(10);
const STDERR_KEEP_CHARS = 2000;

export interface DictationEngineSnapshot {
  readonly state: DictationEngineState;
  readonly loadedModel: DictationModelId | null;
}

export interface DictationEngineLoadInput {
  readonly model: DictationModelId;
  readonly config: unknown;
  readonly runtimeDir: string;
  readonly libraryPathEnv: DictationLibraryPathEnv;
}

export interface DictationEngineShape {
  readonly snapshot: Effect.Effect<DictationEngineSnapshot>;
  /** Emits on every transition; the current value is read via `snapshot`. */
  readonly changes: Stream.Stream<DictationEngineSnapshot>;
  /** No-op when the same model is already loaded. */
  readonly load: (input: DictationEngineLoadInput) => Effect.Effect<void, DictationError>;
  readonly transcribe: (
    samples: Int16Array,
    sampleRate: number,
  ) => Effect.Effect<string, DictationError>;
  readonly unload: Effect.Effect<void>;
}

export class DictationEngine extends Context.Service<DictationEngine, DictationEngineShape>()(
  "threadlines/dictation/DictationEngine",
) {}

const engineFailed = (message: string) => new DictationError({ code: "engine_failed", message });

/**
 * Prepends `directory` to a library-path variable, matching the existing key's
 * casing so Windows does not end up with both `Path` and `PATH`.
 */
function withLibraryPath(
  env: NodeJS.ProcessEnv,
  variable: DictationLibraryPathEnv,
  directory: string,
): NodeJS.ProcessEnv {
  const existingKey =
    Object.keys(env).find((key) => key.toLowerCase() === variable.toLowerCase()) ?? variable;
  const existingValue = env[existingKey];
  return {
    ...env,
    [existingKey]:
      existingValue && existingValue.length > 0
        ? `${directory}${nodePath.delimiter}${existingValue}`
        : directory,
  };
}

const makeDictationEngine = Effect.gen(function* () {
  const stateRef = yield* SubscriptionRef.make<DictationEngineSnapshot>({
    state: "idle",
    loadedModel: null,
  });
  const inFlightRef = yield* Ref.make(false);
  const workerLock = yield* Semaphore.make(1);
  const idleFiber = yield* FiberHandle.make();

  let child: childProcess.ChildProcess | undefined;
  let loadedModel: DictationModelId | null = null;
  let stderrTail = "";

  // Suspended so the published `loadedModel` is read when the transition runs,
  // not when the effect is built.
  const setState = (state: DictationEngineState) =>
    Effect.suspend(() => SubscriptionRef.set(stateRef, { state, loadedModel }));

  const killChild = Effect.sync(() => {
    const current = child;
    child = undefined;
    loadedModel = null;
    if (current && current.exitCode === null && current.signalCode === null) {
      current.removeAllListeners("exit");
      current.kill();
    }
  });

  const spawnWorker = (input: DictationEngineLoadInput) =>
    Effect.try({
      try: () => {
        const env = withLibraryPath(
          {
            ...process.env,
            // Electron's binary only behaves like Node with this set, and the
            // desktop app spawns the worker from inside Electron.
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          },
          input.libraryPathEnv,
          input.runtimeDir,
        );
        const spawned = childProcess.fork(process.argv[1] ?? "", ["dictation-worker"], {
          execPath: process.execPath,
          // Not inherited: `node --watch src/bin.ts` in dev would otherwise
          // hand the worker a `--watch` of its own.
          execArgv: [],
          env,
          serialization: "advanced",
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        stderrTail = "";
        // Both pipes must be drained or a chatty native library blocks on a
        // full buffer; stderr is kept around to explain a crash.
        spawned.stdout?.resume();
        spawned.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_KEEP_CHARS);
        });
        spawned.on("exit", () => {
          child = undefined;
          loadedModel = null;
          Effect.runFork(SubscriptionRef.set(stateRef, { state: "idle", loadedModel: null }));
        });
        return spawned;
      },
      catch: (cause) => engineFailed(`Failed to start the dictation worker: ${String(cause)}`),
    });

  /**
   * Sends one request and waits for the matching reply. A worker exit or an
   * `error` reply fails the call; interruption detaches the listeners.
   */
  const request = <A>(
    message: DictationWorkerRequest,
    match: (response: DictationWorkerResponse) => A | undefined,
  ) =>
    Effect.callback<A, DictationError>((resume) => {
      const current = child;
      if (!current || !current.connected) {
        resume(Effect.fail(engineFailed("The dictation worker is not running.")));
        return;
      }

      const cleanup = () => {
        current.off("message", onMessage);
        current.off("exit", onExit);
        current.off("error", onError);
      };
      const onMessage = (response: DictationWorkerResponse) => {
        const matched = match(response);
        if (matched !== undefined) {
          cleanup();
          resume(Effect.succeed(matched));
          return;
        }
        if (response.type === "error") {
          cleanup();
          resume(Effect.fail(engineFailed(response.message)));
        }
      };
      const onExit = () => {
        cleanup();
        resume(
          Effect.fail(
            engineFailed(
              `The dictation worker exited unexpectedly.${stderrTail ? ` ${stderrTail.trim()}` : ""}`,
            ),
          ),
        );
      };
      const onError = (cause: Error) => {
        cleanup();
        resume(Effect.fail(engineFailed(cause.message)));
      };

      current.on("message", onMessage);
      current.on("exit", onExit);
      current.on("error", onError);
      current.send(message);

      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(engineFailed("The dictation worker timed out.")),
      }),
      // A timed-out or crashed worker is not trustworthy; the next call
      // respawns from scratch.
      Effect.tapError(() => killChild.pipe(Effect.andThen(setState("idle")))),
    );

  const loadUnsafe = (input: DictationEngineLoadInput) =>
    Effect.gen(function* () {
      if (child !== undefined && child.connected && loadedModel === input.model) {
        return;
      }
      if (child !== undefined && child.connected && loadedModel !== input.model) {
        yield* killChild;
      }
      yield* setState("loading");
      if (child === undefined || !child.connected) {
        child = yield* spawnWorker(input);
      }
      yield* request(
        {
          type: "load",
          model: input.model,
          addonPath: nodePath.join(input.runtimeDir, DICTATION_ADDON_FILE),
          config: input.config,
        },
        (response) => (response.type === "loaded" ? true : undefined),
      );
      loadedModel = input.model;
      yield* setState("ready");
    });

  const unloadUnsafe = Effect.gen(function* () {
    if (child !== undefined && child.connected) {
      yield* Effect.sync(() => child?.send({ type: "shutdown" } satisfies DictationWorkerRequest));
    }
    yield* killChild;
    yield* setState("idle");
  });

  const scheduleIdleUnload = FiberHandle.run(
    idleFiber,
    Effect.sleep(IDLE_UNLOAD_DELAY).pipe(
      Effect.andThen(workerLock.withPermits(1)(unloadUnsafe)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.asVoid);

  const load: DictationEngineShape["load"] = (input) =>
    workerLock.withPermits(1)(loadUnsafe(input));

  const transcribe: DictationEngineShape["transcribe"] = (samples, sampleRate) =>
    Effect.gen(function* () {
      const acquired = yield* Ref.modify(inFlightRef, (busy) => [!busy, true] as const);
      if (!acquired) {
        return yield* Effect.fail(
          new DictationError({ code: "busy", message: "A dictation request is already running." }),
        );
      }

      return yield* workerLock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* FiberHandle.clear(idleFiber);
            yield* setState("busy");
            const requestId = crypto.randomUUID();
            const text = yield* request(
              { type: "transcribe", requestId, samples, sampleRate },
              (response) =>
                response.type === "result" && response.requestId === requestId
                  ? response.text
                  : undefined,
            );
            yield* setState("ready");
            return text;
          }),
        )
        .pipe(
          Effect.ensuring(Ref.set(inFlightRef, false)),
          Effect.tap(() => scheduleIdleUnload),
        );
    });

  yield* Effect.addFinalizer(() => FiberHandle.clear(idleFiber).pipe(Effect.andThen(killChild)));

  return {
    snapshot: SubscriptionRef.get(stateRef),
    changes: SubscriptionRef.changes(stateRef),
    load,
    transcribe,
    unload: workerLock.withPermits(1)(unloadUnsafe),
  } satisfies DictationEngineShape;
});

export const DictationEngineLive = Layer.effect(DictationEngine, makeDictationEngine);
