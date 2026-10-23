/**
 * Notices when this server froze, so a client that lost it can say why once
 * it is back (`subscribeServerStalls`).
 *
 * A timer samples the clocks every half second. When the next sample comes
 * five seconds or more late, the server couldn't answer for that long:
 *
 * - its event loop was occupied the whole time: Threadlines was busy with its
 *   own work when its CPU time covers the gap, the computer was overloaded
 *   when its load average exceeds its cores, and otherwise the cause is
 *   unknown (a slow disk, memory pressure: "stopped answering", which stays
 *   true even for the rare sleep that slips through);
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
 * Only the latest freeze is kept, and only reported for ten minutes after it
 * ended. Sampling reads clocks and counters only; the load average is read
 * once a gap is found (`os.cpus()` is too slow on some Linux machines to read
 * twice a second).
 */
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

/** How often the clocks are read. */
export const STALL_SAMPLE_INTERVAL_MS = 500;
/** A gap this long is a freeze: about where a client's heartbeat gives up. */
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
  readonly load?: { readonly average1m: number; readonly cpuCount: number };
}

/** Of a frozen stretch, the share the loop was busy for it to count as frozen. */
const OCCUPIED_SHARE = 0.5;
/** Of a frozen stretch, the share of CPU this process used for it to be its own work. */
const OWN_WORK_SHARE = 0.6;

/** What froze the server between two samples, or null when nothing did. See the module comment. */
export function classifyStall(
  previous: StallSample,
  next: StallSample,
  readMachineLoad: () => MachineLoad,
): ClassifiedStall | null {
  const wallGap = next.wallMs - previous.wallMs;
  const monoGap = next.monoMs - previous.monoMs;
  if (monoGap < STALL_MIN_MS) return null;
  // The wall clock ran well ahead: asleep (Linux) or the clock was set.
  if (wallGap - monoGap >= STALL_MIN_MS) return null;

  const durationMs = Math.round(monoGap);
  const occupied = next.loopActiveMs - previous.loopActiveMs >= OCCUPIED_SHARE * monoGap;
  // The process's CPU time counts its other threads too; only with the loop
  // itself occupied is it the loop's own work.
  if (occupied && next.cpuMs - previous.cpuMs >= OWN_WORK_SHARE * monoGap) {
    return { cause: "busy", durationMs };
  }
  if (monoGap > STALL_UNEXPLAINED_MAX_MS) return null;

  const machine = readMachineLoad();
  const overloaded = machine.reported && machine.average1m >= machine.cpuCount;
  if (overloaded) {
    return {
      cause: "overloaded",
      durationMs,
      load: { average1m: Math.round(machine.average1m * 10) / 10, cpuCount: machine.cpuCount },
    };
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
  };
}

function readMachineLoad(): MachineLoad {
  return {
    average1m: os.loadavg()[0] ?? 0,
    cpuCount: os.availableParallelism(),
    reported: process.platform !== "win32",
  };
}

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
    ...(recorded.load ? { load: recorded.load } : {}),
  };
}

export interface StallMonitorShape {
  /** The latest freeze if it ended within the report window, then each new one. */
  readonly stalls: Stream.Stream<ServerStall>;
}

export class StallMonitor extends Context.Service<StallMonitor, StallMonitorShape>()(
  "threadlines/observability/StallMonitor",
) {}

const make = Effect.gen(function* () {
  const runId = randomUUID().slice(0, 8);
  let sequence = 0;
  const latest = yield* SubscriptionRef.make<Option.Option<RecordedStall>>(Option.none());
  let previous = readSample();

  // A freeze too old to report is dropped for good, so a clock set back
  // later can't make it look recent again.
  const expireOld = Effect.flatMap(SubscriptionRef.get(latest), (current) =>
    Option.isSome(current) &&
    reportableStall(current.value, { monoMs: performance.now(), wallMs: Date.now() }) === null
      ? SubscriptionRef.set(latest, Option.none())
      : Effect.void,
  );

  yield* Effect.sync(() => {
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
    Effect.flatMap((recorded) =>
      Option.isSome(recorded)
        ? Effect.logWarning("server froze", {
            cause: recorded.value.cause,
            durationMs: recorded.value.durationMs,
            ...(recorded.value.load ? { load: recorded.value.load } : {}),
          }).pipe(Effect.andThen(SubscriptionRef.set(latest, recorded)))
        : expireOld,
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(STALL_SAMPLE_INTERVAL_MS))),
    Effect.forkScoped,
  );

  return StallMonitor.of({
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
