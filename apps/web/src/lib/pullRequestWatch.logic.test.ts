import { describe, expect, it } from "vite-plus/test";

import {
  PULL_REQUEST_WATCH_BUSY_MS,
  PULL_REQUEST_WATCH_CLOSED_MS,
  PULL_REQUEST_WATCH_QUIET_MS,
  duePullRequestWatches,
  pullRequestWatchIntervalMs,
} from "./pullRequestWatch.logic";

const QUIET_OPEN = {
  state: "open",
  autoMergeEnabled: false,
  checksState: "success",
  busy: false,
  updatedAgoMs: 60 * 60_000,
} as const;

describe("pullRequestWatchIntervalMs", () => {
  it("reads faster what has something going on, and a merge never again", () => {
    expect(pullRequestWatchIntervalMs(QUIET_OPEN)).toBe(PULL_REQUEST_WATCH_QUIET_MS);
    for (const moving of [
      { busy: true },
      { autoMergeEnabled: true },
      { checksState: "pending" },
      { updatedAgoMs: 2 * 60_000 },
    ] as const) {
      expect(pullRequestWatchIntervalMs({ ...QUIET_OPEN, ...moving })).toBe(
        PULL_REQUEST_WATCH_BUSY_MS,
      );
    }
    // Closed can be reopened, rarely; merged is final, whatever else is going on.
    expect(pullRequestWatchIntervalMs({ ...QUIET_OPEN, state: "closed" })).toBe(
      PULL_REQUEST_WATCH_CLOSED_MS,
    );
    expect(pullRequestWatchIntervalMs({ ...QUIET_OPEN, state: "merged", busy: true })).toBeNull();
  });
});

describe("duePullRequestWatches", () => {
  it("sends a repository's reads together once one is due, and nothing before", () => {
    const entry = (value: string, batchKey: string, intervalMs: number, ageMs: number) => ({
      value,
      batchKey,
      intervalMs,
      ageMs,
    });
    expect(
      duePullRequestWatches([
        // Due now.
        entry("alpha#1", "alpha", 30_000, 31_000),
        // Halfway to due: goes along rather than costing a request of its own later.
        entry("alpha#2", "alpha", 90_000, 50_000),
        // Read moments ago: waits.
        entry("alpha#3", "alpha", 90_000, 10_000),
        // Another repository with nothing due yet.
        entry("beta#4", "beta", 90_000, 80_000),
      ]),
    ).toEqual(["alpha#1", "alpha#2"]);
    // Never read at all is due.
    expect(duePullRequestWatches([entry("beta#5", "beta", 90_000, Infinity)])).toEqual(["beta#5"]);
  });
});
