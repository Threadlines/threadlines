/**
 * Notices when this server froze, so a client that lost it can say why once
 * it is back (`subscribeServerStalls`).
 *
 * A timer samples the clocks every half second. When the next sample comes
 * two seconds or more late, the server couldn't answer for that long. Every
 * such freeze goes to the log; clients hear only of those of five seconds or
 * more, about where their heartbeat gives up. A freeze is classified as:
 *
 * - its event loop was occupied the whole time: Threadlines was busy with its
 *   own work when its database calls or its CPU time cover the gap (the
 *   database first: the SQLite driver is synchronous, and a slow read waiting
 *   on the disk holds the loop without using the CPU), the computer was
 *   overloaded when its load average exceeds its cores, and otherwise the
 *   cause is unknown (a slow disk, memory pressure: "stopped answering", which
 *   stays true even for the rare sleep that slips through);
 * - the loop sat idle while its timer ran late: reported only when the
 *   computer was overloaded (starved of CPU). On an idle computer that is
 *   timer throttling (macOS App Nap), not a freeze anyone felt.
 *
 * Sleep is never reported, and must never pass for a freeze. How the clocks
 * treat sleep differs by system and Node version (Linux's monotonic clock
 * stops, macOS's keeps counting from Node 24, Windows' always does), so: a
 * wall clock that ran ahead of the monotonic one (a Linux sleep, or the clock
 * being set) is no freeze, and a gap longer than two minutes is only one when
 * Threadlines' own CPU time covers it. Anything else that long is far more
 * likely a sleep or a paused process than a freeze to explain, so a real
 * freeze that long without the CPU to show for it goes unreported: the price
 * of never calling a sleep a freeze.
 *
 * It watches only from `start`, which `server.ts` calls once startup has
 * built the server's services, its database migrations included. Before that
 * the server is starting, not frozen: a long migration holds the loop just
 * like a freeze, no client is being served yet, and the desktop already says
 * the update is running.
 *
 * Only the latest freeze is kept, and only reported for ten minutes after it
 * ended. Sampling reads clocks and counters only; the load average is read
 * once a gap is found (`os.cpus()` is too slow on some Linux machines to read
 * twice a second). When the cause lies outside Threadlines (`overloaded`,
 * `unknown`), the log line also names the busiest programs on the computer,
 * read with `ps` after the freeze: program names and CPU shares only, never
 * their arguments, and only into the local log.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";

import type { ServerStall, ServerStallCause } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type AnalyticsStallDurationBucket,
  stallDurationBucket,
} from "../telemetry/AnalyticsProperties.ts";
import { makeDailyAnalyticsCounter } from "../telemetry/DailyCounter.ts";
import { readDatabaseCallMs } from "./databaseCallTime.ts";

/** How often the clocks are read. */
export const STALL_SAMPLE_INTERVAL_MS = 500;
/** A gap this long is a freeze, and goes to the log. */
export const STALL_LOG_MIN_MS = 2_000;
/** A freeze this long is reported to clients: about where their heartbeat gives up. */
export const STALL_MIN_MS = 5_000;
/** Past this, only Threadlines' own CPU time makes a gap a freeze (see the module comment). */
export const STALL_UNEXPLAINED_MAX_MS = 2 * 60_000;
/** How long after it ended a freeze is still reported. */
export const STALL_REPORT_WINDOW_MS = 10 * 60_000;

/** The clocks and counters at one moment. All cumulative, in milliseconds. */
export interface StallSample {
  readonly wallMs: number;
  readonly monoMs: number;
  /** Time the event loop spent outside its wait for events. */
  readonly loopActiveMs: number;
  /** This process's CPU time, user and system. */
  readonly cpuMs: number;
  /** Time spent inside synchronous database calls (`databaseCallTime.ts`). */
  readonly databaseMs: number;
}

/** The computer's load, read once a gap is found. */
export interface MachineLoad {
  readonly average1m: number;
  readonly cpuCount: number;
  /** Windows reports no load average. */
  readonly reported: boolean;
}

export interface ClassifiedStall {
  readonly cause: ServerStallCause;
  readonly durationMs: number;
  /** Set when database calls held the server up (cause `busy`). */
  readonly databaseMs?: number;
  readonly load?: { readonly average1m: number; readonly cpuCount: number };
}

/** Of a frozen stretch, the share the loop was busy for it to count as frozen. */
const OCCUPIED_SHARE = 0.5;
/** Of a frozen stretch, the share of CPU this process used for it to be its own work. */
const OWN_WORK_SHARE = 0.6;
/** Of a frozen stretch, the share spent inside database calls for them to be what froze it. */
const DATABASE_SHARE = 0.5;

/** What froze the server between two samples, or null when nothing did. See the module comment. */
export function classifyStall(
  previous: StallSample,
  next: StallSample,
  readMachineLoad: () => MachineLoad,
): ClassifiedStall | null {
  const wallGap = next.wallMs - previous.wallMs;
  const monoGap = next.monoMs - previous.monoMs;
  if (monoGap < STALL_LOG_MIN_MS) return null;
  // The wall clock ran ahead by as much as a freeze: asleep (Linux) or the
  // clock was set, and the gap can't be read as a freeze.
  if (wallGap - monoGap >= STALL_LOG_MIN_MS) return null;

  const durationMs = Math.round(monoGap);
  const occupied = next.loopActiveMs - previous.loopActiveMs >= OCCUPIED_SHARE * monoGap;
  // The process's CPU time counts its other threads too; only with the loop
  // itself occupied is it the loop's own work.
  const ownWork = occupied && next.cpuMs - previous.cpuMs >= OWN_WORK_SHARE * monoGap;
  // Database time runs on the monotonic clock like the gap itself, so past
  // the cap it explains a freeze only when the CPU time does too.
  const databaseMs = next.databaseMs - previous.databaseMs;
  const heldByDatabase =
    occupied &&
    databaseMs >= DATABASE_SHARE * monoGap &&
    (ownWork || monoGap <= STALL_UNEXPLAINED_MAX_MS);
  if (ownWork && !heldByDatabase) {
    return { cause: "busy", durationMs };
  }
  if (!heldByDatabase && monoGap > STALL_UNEXPLAINED_MAX_MS) return null;

  const machine = readMachineLoad();
  const load =
    machine.reported && machine.average1m >= machine.cpuCount
      ? { average1m: Math.round(machine.average1m * 10) / 10, cpuCount: machine.cpuCount }
      : null;
  // Under heavy load too, it says both: the load is what the computer reported,
  // not proof the CPU slowed the database (disk waits count in it on Linux).
  if (heldByDatabase) {
    return {
      cause: "busy",
      durationMs,
      databaseMs: Math.round(databaseMs),
      ...(load ? { load } : {}),
    };
  }
  if (load) {
    return { cause: "overloaded", durationMs, load };
  }
  return occupied ? { cause: "unknown", durationMs } : null;
}

function readSample(): StallSample {
  const cpu = process.cpuUsage();
  return {
    wallMs: Date.now(),
    monoMs: performance.now(),
    loopActiveMs: performance.eventLoopUtilization().active,
    cpuMs: (cpu.user + cpu.system) / 1000,
    databaseMs: readDatabaseCallMs(),
  };
}

function readMachineLoad(): MachineLoad {
  return {
    average1m: os.loadavg()[0] ?? 0,
    cpuCount: os.availableParallelism(),
    reported: process.platform !== "win32",
  };
}

/** How many of the busiest programs a freeze's log line names. */
const TOP_PROCESS_COUNT = 5;
/** How long reading the process table may take before the line is logged without it. */
const TOP_PROCESS_TIMEOUT_MS = 1_500;

/**
 * The busiest programs in `ps -A -o pcpu=,comm=` output, as "name 12.3%".
 * `comm` never holds arguments, and of a full path (as macOS gives it) only
 * the last part is kept: a path can name the user or a project.
 */
export function parseTopProcesses(output: string, limit = TOP_PROCESS_COUNT): string[] {
  const processes: { readonly name: string; readonly cpu: number }[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const command = match[2]!;
    // A Linux `comm` can hold a slash of its own ("kworker/u8:2"); only a
    // path, absolute or relative, is cut down to its last part.
    const isPath = command.startsWith("/") || command.startsWith(".");
    const name = isPath ? (command.split("/").at(-1) ?? "") : command;
    if (name.length === 0) continue;
    processes.push({ name, cpu: Number(match[1]) });
  }
  return processes
    .toSorted((left, right) => right.cpu - left.cpu)
    .slice(0, limit)
    .map((entry) => `${entry.name} ${entry.cpu.toFixed(1)}%`);
}

/**
 * The busiest programs right now, or none on Windows or when `ps` can't
 * start, fails, or is slow. Gives up after the timeout even when the child
 * won't exit, and kills it on the way out.
 */
const readTopProcesses: Effect.Effect<ReadonlyArray<string>> =
  process.platform === "win32"
    ? Effect.succeed([])
    : Effect.callback<ReadonlyArray<string>>((resume) => {
        try {
          const child = execFile(
            "ps",
            ["-A", "-o", "pcpu=,comm="],
            {
              timeout: TOP_PROCESS_TIMEOUT_MS,
              killSignal: "SIGKILL",
              maxBuffer: 4 * 1024 * 1024,
              // A decimal point, not a locale's comma.
              env: { ...process.env, LC_ALL: "C" },
            },
            (error, stdout) => resume(Effect.succeed(error ? [] : parseTopProcesses(stdout))),
          );
          return Effect.sync(() => child.kill("SIGKILL"));
        } catch {
          resume(Effect.succeed([]));
          return;
        }
      }).pipe(
        Effect.timeoutOption(Duration.millis(TOP_PROCESS_TIMEOUT_MS + 500)),
        Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
      );

export interface RecordedStall extends ClassifiedStall {
  readonly id: string;
  /** When it ended, on each clock. */
  readonly endedAtMonoMs: number;
  readonly endedAtWallMs: number;
}

/**
 * A recorded freeze as a client gets it, or none once it is too old. Its age
 * is the larger the two clocks give: a Linux sleep since then stops the
 * monotonic one, and an old freeze must not come back as a fresh one.
 */
export function reportableStall(
  recorded: RecordedStall,
  now: { readonly monoMs: number; readonly wallMs: number },
): ServerStall | null {
  const agoMs = Math.max(
    0,
    Math.round(now.monoMs - recorded.endedAtMonoMs),
    Math.round(now.wallMs - recorded.endedAtWallMs),
  );
  if (agoMs > STALL_REPORT_WINDOW_MS) return null;
  return {
    id: recorded.id,
    cause: recorded.cause,
    durationMs: recorded.durationMs,
    agoMs,
    ...(recorded.databaseMs !== undefined ? { databaseMs: recorded.databaseMs } : {}),
    ...(recorded.load ? { load: recorded.load } : {}),
  };
}

export interface StallMonitorShape {
  /** The latest freeze if it ended within the report window, then each new one. */
  readonly stalls: Stream.Stream<ServerStall>;
  /**
   * Starts watching for freezes, from now. Called once startup is past the
   * migrations (see the module comment); later calls do nothing.
   */
  readonly start: Effect.Effect<void>;
}

export class StallMonitor extends Context.Service<StallMonitor, StallMonitorShape>()(
  "threadlines/observability/StallMonitor",
) {}

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const stallCounter = yield* makeDailyAnalyticsCounter<{
    readonly cause: ServerStallCause;
    readonly durationBucket: AnalyticsStallDurationBucket;
    readonly heldByDatabase: boolean;
  }>({
    event: "server.stall",
    keyOf: ({ cause, durationBucket, heldByDatabase }) =>
      `${cause}\u0000${durationBucket}\u0000${heldByDatabase}`,
  });
  const runId = randomUUID().slice(0, 8);
  let sequence = 0;
  const latest = yield* SubscriptionRef.make<Option.Option<RecordedStall>>(Option.none());
  let started = false;
  let previous = readSample();

  // A freeze too old to report is dropped for good, so a clock set back
  // later can't make it look recent again.
  const expireOld = Effect.flatMap(SubscriptionRef.get(latest), (current) =>
    Option.isSome(current) &&
    reportableStall(current.value, { monoMs: performance.now(), wallMs: Date.now() }) === null
      ? SubscriptionRef.set(latest, Option.none())
      : Effect.void,
  );

  const logStall = (stall: RecordedStall, topProcesses: ReadonlyArray<string>) =>
    Effect.logWarning("server froze", {
      cause: stall.cause,
      durationMs: stall.durationMs,
      ...(stall.databaseMs !== undefined ? { databaseMs: stall.databaseMs } : {}),
      ...(stall.load ? { load: stall.load } : {}),
      ...(topProcesses.length > 0 ? { topProcesses } : {}),
    });

  // When something outside Threadlines froze it, the log names the busiest
  // programs. The process table is read in its own fiber, so the sampling
  // and what clients are told never wait on it.
  const record = (stall: RecordedStall) =>
    Effect.gen(function* () {
      stallCounter.increment({
        cause: stall.cause,
        durationBucket: stallDurationBucket(stall.durationMs),
        heldByDatabase: stall.databaseMs !== undefined,
      });
      if (stall.cause === "overloaded" || stall.cause === "unknown") {
        yield* Effect.forkIn(
          Effect.flatMap(readTopProcesses, (top) => logStall(stall, top)),
          scope,
        );
      } else {
        yield* logStall(stall, []);
      }
      if (stall.durationMs >= STALL_MIN_MS) {
        yield* SubscriptionRef.set(latest, Option.some(stall));
      }
    });

  const watch = Effect.sync(() => {
    const next = readSample();
    const stall = classifyStall(previous, next, readMachineLoad);
    previous = next;
    if (stall === null) return Option.none<RecordedStall>();
    sequence += 1;
    return Option.some<RecordedStall>({
      ...stall,
      id: `${runId}-${sequence}`,
      endedAtMonoMs: next.monoMs,
      endedAtWallMs: next.wallMs,
    });
  }).pipe(
    Effect.flatMap((recorded) => (Option.isSome(recorded) ? record(recorded.value) : expireOld)),
    Effect.repeat(Schedule.spaced(Duration.millis(STALL_SAMPLE_INTERVAL_MS))),
  );

  // The first gap is measured from the start, not from when the monitor was
  // built: the migrations run in between.
  const start = Effect.suspend(() => {
    if (started) return Effect.void;
    started = true;
    previous = readSample();
    return Effect.asVoid(Effect.forkIn(watch, scope));
  });

  return StallMonitor.of({
    start,
    stalls: SubscriptionRef.changes(latest).pipe(
      Stream.map((recorded) =>
        Option.isSome(recorded)
          ? reportableStall(recorded.value, { monoMs: performance.now(), wallMs: Date.now() })
          : null,
      ),
      Stream.filter((stall): stall is ServerStall => stall !== null),
    ),
  });
});

export const layer = Layer.effect(StallMonitor, make);
