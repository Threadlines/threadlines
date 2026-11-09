import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { ProcessRunner } from "../../processRunner.ts";
import { SystemWake } from "../Services/SystemWake.ts";
import {
  halfAwakeFromSystemState,
  type HalfAwakeStreak,
  lastSleepFromSysctl,
  nextHalfAwakeStreak,
  waitsForFullWake,
} from "../systemWakeState.ts";

/** One reading answers every question asked within this, a scheduler pass's worth. */
const READING_FRESH_MS = 5_000;
const READ_TIMEOUT = Duration.seconds(3);

/** What one look at the computer says; null where it couldn't be read. */
export interface SystemWakeProbe {
  /** Null counts as fully awake. */
  readonly halfAwake: boolean | null;
  readonly lastSleepMs: number | null;
}

/**
 * SystemWake from a probe of the computer. Logs when work starts waiting,
 * when it stops, and when a half-awake reading lasted too long to trust.
 * Exported for tests.
 */
export const makeSystemWake = (probe: Effect.Effect<SystemWakeProbe>) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let streak: HalfAwakeStreak | null = null;
    let waiting = false;
    let reading: { readonly at: number; readonly fullyAwake: boolean } | null = null;

    const fullyAwake = lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (reading !== null && now >= reading.at && now - reading.at < READING_FRESH_MS) {
          return reading.fullyAwake;
        }
        const read = yield* probe;
        streak = nextHalfAwakeStreak(streak, {
          halfAwake: read.halfAwake === true,
          wallMs: now,
          lastSleepMs: read.lastSleepMs,
        });
        const waits = waitsForFullWake(streak);
        if (waits && !waiting) {
          yield* Effect.logInfo(
            "this computer woke only for upkeep: scheduled work waits until it's fully awake",
          );
        } else if (!waits && waiting) {
          if (streak === null) {
            yield* Effect.logInfo("this computer is fully awake: scheduled work can start");
          } else {
            yield* Effect.logWarning(
              "this computer has read as woken only for upkeep for 10 minutes: scheduled work starts anyway",
            );
          }
        }
        waiting = waits;
        reading = { at: now, fullyAwake: !waits };
        return !waits;
      }),
    );

    return SystemWake.of({ fullyAwake });
  });

/** One command's output, or null when it fails. */
const readOutput = (runner: typeof ProcessRunner.Service, command: string, args: Array<string>) =>
  runner
    .run({ command, args, timeout: READ_TIMEOUT, maxOutputBytes: 4_096, outputMode: "truncate" })
    .pipe(
      Effect.map((output) => (output.code === 0 && !output.timedOut ? output.stdout : null)),
      Effect.orElseSucceed(() => null),
    );

/** `pmset -g systemstate` for the capabilities, `sysctl kern.sleeptime` for the last sleep. */
const probeMac = (runner: typeof ProcessRunner.Service): Effect.Effect<SystemWakeProbe> =>
  Effect.all(
    [
      readOutput(runner, "pmset", ["-g", "systemstate"]),
      readOutput(runner, "sysctl", ["-n", "kern.sleeptime"]),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([systemState, sleepTime]) => ({
      halfAwake: systemState === null ? null : halfAwakeFromSystemState(systemState),
      lastSleepMs: sleepTime === null ? null : lastSleepFromSysctl(sleepTime),
    })),
  );

/** macOS reads `pmset`; Windows and Linux have no such reading and count as fully awake. */
export const SystemWakeLive = Layer.effect(
  SystemWake,
  Effect.gen(function* () {
    if (process.platform !== "darwin") {
      return SystemWake.of({ fullyAwake: Effect.succeed(true) });
    }
    const runner = yield* ProcessRunner;
    return yield* makeSystemWake(probeMac(runner));
  }),
);
