import { assert, describe, it } from "@effect/vitest";

import {
  stepWatchdog,
  WATCHDOG_SAMPLE_MS,
  type WatchdogSample,
  type WatchdogState,
} from "./DesktopBackdropMonitor.ts";

/** Runs samples through the watchdog; the times it would have told the app. */
function run(samples: ReadonlyArray<WatchdogSample>): number[] {
  let state: WatchdogState = { overSince: null };
  const fired: number[] = [];
  for (const sample of samples) {
    const step = stepWatchdog(state, sample);
    state = step.state;
    if (step.tooHeavy) fired.push(sample.at);
  }
  return fired;
}

const every2s = (cpu: ReadonlyArray<number | null>): WatchdogSample[] =>
  cpu.map((cpuPercent, index) => ({ at: (index + 1) * WATCHDOG_SAMPLE_MS, cpuPercent }));

describe("backdrop CPU watchdog", () => {
  it("speaks up after 10 seconds over 15% of a core, not before", () => {
    assert.deepEqual(run(every2s([40, 40, 40, 40])), []);
    assert.deepEqual(run(every2s([40, 40, 40, 40, 40])), [10_000]);
  });

  it("starts over after a calm sample or one it can't attribute (a shared process)", () => {
    assert.deepEqual(run(every2s([40, 40, 40, 40, 10, 40, 40, 40, 40])), []);
    assert.deepEqual(run(every2s([40, 40, 40, 40, null, 40, 40, 40, 40])), []);
  });
});
