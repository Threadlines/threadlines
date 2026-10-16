import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SleepInhibitor, type SleepInhibitorShape } from "../Services/SleepInhibitor.ts";
import {
  initialSleepInhibitionState,
  reduceSleepInhibitionState,
  shouldInhibitSleep,
  type SleepInhibitionInput,
} from "../sleepInhibitionState.ts";

/**
 * SleepAssertionHolder - Platform hook that holds/releases one OS power
 * assertion. Both operations are idempotent; `release` is also the shutdown
 * finalizer, so it must never fail.
 */
export interface SleepAssertionHolder {
  readonly engage: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
}

export const noopSleepAssertionHolder: SleepAssertionHolder = {
  engage: Effect.void,
  release: Effect.void,
};

/**
 * Holder backed by one long-lived child process whose lifetime *is* the
 * assertion: spawning it engages, killing it releases, and both platform
 * helpers self-terminate when the server pid dies so even a crashed server
 * can never leave the machine unable to sleep.
 */
const makeChildProcessSleepAssertionHolder = (command: ChildProcess.StandardCommand) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processScope = yield* Ref.make<Scope.Closeable | null>(null);

    const engage = Effect.gen(function* () {
      const existing = yield* Ref.get(processScope);
      if (existing !== null) {
        return;
      }
      const scope = yield* Scope.make();
      const spawned = yield* spawner
        .spawn(command)
        .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
      if (Exit.isFailure(spawned)) {
        yield* Scope.close(scope, Exit.void);
        if (Cause.hasInterruptsOnly(spawned.cause)) {
          return yield* Effect.interrupt;
        }
        yield* Effect.logWarning("sleep inhibition failed to spawn assertion process", {
          command: command.command,
          cause: Cause.pretty(spawned.cause),
        });
        return;
      }
      yield* Ref.set(processScope, scope);
    }).pipe(Effect.asVoid);

    const release = Effect.gen(function* () {
      const scope = yield* Ref.getAndSet(processScope, null);
      if (scope !== null) {
        yield* Scope.close(scope, Exit.void);
      }
    });

    return { engage, release } satisfies SleepAssertionHolder;
  });

/**
 * macOS: `caffeinate -i` prevents idle *system* sleep while leaving display
 * sleep and the lock screen on their normal schedule. `-w <pid>` ties the
 * assertion to the server process. Lid-close sleep is an OS guarantee no
 * assertion can override.
 */
export const makeCaffeinateSleepAssertionHolder = makeChildProcessSleepAssertionHolder(
  ChildProcess.make("caffeinate", ["-i", "-w", String(process.pid)]),
);

/**
 * Windows: a PowerShell helper P/Invokes
 * `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` — the
 * sanctioned equivalent of an idle-sleep assertion. `ES_DISPLAY_REQUIRED` is
 * deliberately omitted so the display still turns off and locks. The state is
 * cleared by the OS when the helper dies, and the helper blocks on the server
 * pid so it exits with the server.
 */
const WINDOWS_POWER_REQUEST_SCRIPT = [
  `Add-Type -Namespace Threadlines -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
  // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  `[Threadlines.Power]::SetThreadExecutionState(2147483649) | Out-Null`,
  `(Get-Process -Id ${process.pid}).WaitForExit()`,
].join("; ");

export const makeWindowsSleepAssertionHolder = makeChildProcessSleepAssertionHolder(
  ChildProcess.make(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_POWER_REQUEST_SCRIPT],
    hideWindowsConsole({}),
  ),
);

const makePlatformSleepAssertionHolder = Effect.gen(function* () {
  switch (process.platform) {
    case "darwin":
      return yield* makeCaffeinateSleepAssertionHolder;
    case "win32":
      return yield* makeWindowsSleepAssertionHolder;
    default:
      // Linux (systemd-inhibit) fits the same holder contract when someone
      // needs it.
      yield* Effect.logDebug("sleep inhibition is not supported on this platform", {
        platform: process.platform,
      });
      return noopSleepAssertionHolder;
  }
});

/**
 * How long the assertion outlives the last turn. Holding it costs nothing
 * (idle sleep timers are far longer), while dropping it between the turns of
 * a conversation would start a new helper process for each one: a PowerShell
 * that compiles C# on Windows.
 */
const SLEEP_RELEASE_GRACE = Duration.minutes(5);

/**
 * Sequential core: fold one input into the state and reconcile the held
 * assertion with the desired one. Once the last turn ends the assertion is
 * released after `releaseGrace`, unless another turn starts first; turning
 * the setting off or shutting down releases at once. Exported for tests.
 */
export const makeSleepInhibitionController = (
  holder: SleepAssertionHolder,
  options: { readonly releaseGrace?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    const releaseGrace = Duration.fromInputUnsafe(options.releaseGrace ?? SLEEP_RELEASE_GRACE);
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const stateRef = yield* Ref.make(initialSleepInhibitionState(true));
    const inhibitedRef = yield* Ref.make(false);
    const pendingReleaseRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);

    const cancelPendingRelease = Ref.getAndSet(pendingReleaseRef, null).pipe(
      Effect.flatMap((pending) => (pending === null ? Effect.void : Fiber.interrupt(pending))),
    );

    const releaseHeld = Effect.gen(function* () {
      if (yield* Ref.getAndSet(inhibitedRef, false)) {
        yield* holder.release;
        yield* Effect.logInfo("sleep inhibition released");
      }
    });

    const releaseAfterGrace = Effect.sleep(releaseGrace).pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(pendingReleaseRef, null);
            if (!shouldInhibitSleep(yield* Ref.get(stateRef))) {
              yield* releaseHeld;
            }
          }),
        ),
      ),
    );

    const handle = (input: SleepInhibitionInput) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(stateRef);
          const state = reduceSleepInhibitionState(previous, input);
          if (state === previous) {
            return;
          }
          yield* Ref.set(stateRef, state);

          if (shouldInhibitSleep(state)) {
            yield* cancelPendingRelease;
            if (!(yield* Ref.get(inhibitedRef))) {
              yield* holder.engage;
              yield* Ref.set(inhibitedRef, true);
              yield* Effect.logInfo("sleep inhibition engaged while turns are active", {
                activeThreads: state.activeThreadIds.size,
              });
            }
            return;
          }
          if (!(yield* Ref.get(inhibitedRef))) {
            return;
          }
          if (!state.enabled) {
            yield* cancelPendingRelease;
            yield* releaseHeld;
            return;
          }
          if ((yield* Ref.get(pendingReleaseRef)) === null) {
            yield* Ref.set(pendingReleaseRef, yield* Effect.forkIn(releaseAfterGrace, scope));
          }
        }),
      );

    const shutdown = lock.withPermits(1)(cancelPendingRelease.pipe(Effect.andThen(releaseHeld)));

    return { handle, shutdown };
  });

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;
  const holder = yield* makePlatformSleepAssertionHolder;
  const controller = yield* makeSleepInhibitionController(holder);

  const handleSafely = (input: SleepInhibitionInput) =>
    controller.handle(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("sleep inhibitor failed to process input", {
          inputKind: input.kind,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(handleSafely);

  const start: SleepInhibitorShape["start"] = Effect.fn("start")(function* () {
    // Seed the enabled flag from persisted settings before subscribing so a
    // later change event always supersedes the snapshot.
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catch((error) =>
        Effect.logWarning("sleep inhibitor could not read server settings; assuming enabled", {
          detail: error.detail,
        }).pipe(Effect.as(null)),
      ),
    );
    if (settings !== null) {
      yield* worker.enqueue({ kind: "settings", enabled: settings.preventSleepDuringActiveTurns });
    }

    yield* Effect.addFinalizer(() => controller.shutdown);
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ kind: "runtime-event", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, (changed) =>
        worker.enqueue({ kind: "settings", enabled: changed.preventSleepDuringActiveTurns }),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies SleepInhibitorShape;
});

export const SleepInhibitorLive = Layer.effect(SleepInhibitor, make);
