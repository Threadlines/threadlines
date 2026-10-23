import { describe, expect, it } from "@effect/vitest";

import {
  classifyStall,
  type MachineLoad,
  reportableStall,
  STALL_REPORT_WINDOW_MS,
  type StallSample,
} from "./StallMonitor.ts";

const START: StallSample = {
  wallMs: 1_000_000,
  monoMs: 50_000,
  loopActiveMs: 10_000,
  cpuMs: 9_000,
};

/** The next sample after `monoMs` of server time, with the loop and CPU busy for the given parts of it. */
function after(
  monoMs: number,
  busy: { readonly loop: number; readonly cpu: number },
  sleptMs = 0,
): StallSample {
  return {
    wallMs: START.wallMs + monoMs + sleptMs,
    monoMs: START.monoMs + monoMs,
    loopActiveMs: START.loopActiveMs + monoMs * busy.loop,
    cpuMs: START.cpuMs + monoMs * busy.cpu,
  };
}

const idleMachine = (): MachineLoad => ({ average1m: 2, cpuCount: 14, reported: true });
const overloadedMachine = (): MachineLoad => ({ average1m: 219.4, cpuCount: 18, reported: true });
const windowsMachine = (): MachineLoad => ({ average1m: 0, cpuCount: 8, reported: false });

describe("classifyStall", () => {
  it("names what stopped the server", () => {
    // Its own synchronous work (a slow query): the loop and its CPU both busy.
    expect(classifyStall(START, after(7_000, { loop: 0.98, cpu: 0.95 }), idleMachine)).toEqual({
      cause: "busy",
      durationMs: 7_000,
    });
    // Stuck mid-callback on a computer whose CPU others took.
    expect(classifyStall(START, after(12_000, { loop: 0.9, cpu: 0.1 }), overloadedMachine)).toEqual(
      {
        cause: "overloaded",
        durationMs: 12_000,
        load: { average1m: 219.4, cpuCount: 18 },
      },
    );
    // Starved while idle: the loop never got the CPU to wake up.
    expect(classifyStall(START, after(9_000, { loop: 0.05, cpu: 0 }), overloadedMachine)).toEqual({
      cause: "overloaded",
      durationMs: 9_000,
      load: { average1m: 219.4, cpuCount: 18 },
    });
    // Occupied without the CPU to show for it, on a quiet computer: a slow disk, say.
    expect(classifyStall(START, after(6_000, { loop: 0.9, cpu: 0.1 }), idleMachine)).toEqual({
      cause: "unknown",
      durationMs: 6_000,
    });
  });

  it("says nothing when the server could answer, or when it slept", () => {
    expect(classifyStall(START, after(500, { loop: 0.2, cpu: 0.1 }), idleMachine)).toBeNull();
    // The wall clock ran on while the monotonic one stood still: a Linux sleep,
    // or the clock being set. No freeze.
    expect(
      classifyStall(START, after(500, { loop: 0, cpu: 0 }, 3_600_000), idleMachine),
    ).toBeNull();
    // An hour unexplained by its own CPU time is a sleep (macOS from Node 24 and
    // Windows keep the monotonic clock running), even mid-callback or under load.
    expect(classifyStall(START, after(3_600_000, { loop: 1, cpu: 0 }), idleMachine)).toBeNull();
    expect(
      classifyStall(START, after(3_600_000, { loop: 0, cpu: 0 }), overloadedMachine),
    ).toBeNull();
    // A late timer on a quiet computer is throttling (App Nap), not a freeze.
    expect(classifyStall(START, after(8_000, { loop: 0.01, cpu: 0 }), idleMachine)).toBeNull();
    // CPU from the process's other threads while the loop sat idle isn't its own work.
    expect(classifyStall(START, after(12_000, { loop: 0.1, cpu: 0.7 }), idleMachine)).toBeNull();
    // Windows reports no load, so an idle late timer there stays unexplained, and unreported.
    expect(classifyStall(START, after(60_000, { loop: 0, cpu: 0 }), windowsMachine)).toBeNull();
  });
});

describe("reportableStall", () => {
  const recorded = {
    id: "run-1",
    cause: "busy" as const,
    durationMs: 7_000,
    endedAtMonoMs: 1_000,
    endedAtWallMs: 5_000_000,
  };

  it("reports a freeze for ten minutes after it ended, with how long ago", () => {
    expect(reportableStall(recorded, { monoMs: 61_000, wallMs: 5_060_000 })).toEqual({
      id: "run-1",
      cause: "busy",
      durationMs: 7_000,
      agoMs: 60_000,
    });
    expect(
      reportableStall(recorded, {
        monoMs: 1_000 + STALL_REPORT_WINDOW_MS + 1,
        wallMs: 5_000_000 + STALL_REPORT_WINDOW_MS + 1,
      }),
    ).toBeNull();
  });

  it("ages a freeze by the wall clock too, so a sleep since doesn't make it fresh", () => {
    // Asked right after an hour of Linux sleep: the monotonic clock barely moved.
    expect(reportableStall(recorded, { monoMs: 2_000, wallMs: 5_000_000 + 3_600_000 })).toBeNull();
  });
});
