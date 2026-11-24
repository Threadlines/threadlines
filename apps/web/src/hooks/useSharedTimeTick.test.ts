import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { sharedClock } from "./useSharedTimeTick";

describe("sharedClock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a reader that starts mid-interval the same time as one already reading, and ticks them together", () => {
    const clock = sharedClock(30_001);
    const first = vi.fn();
    const stopFirst = clock.subscribe(first);
    const startedAt = clock.getSnapshot();

    vi.advanceTimersByTime(20_000);
    const second = vi.fn();
    const stopSecond = clock.subscribe(second);
    expect(clock.getSnapshot()).toBe(startedAt);

    vi.advanceTimersByTime(10_001);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(clock.getSnapshot()).toBe(startedAt + 30_001);
    stopFirst();
    stopSecond();
  });

  it("stops ticking when nobody reads it, and never hands out a time older than one interval", () => {
    const clock = sharedClock(30_002);
    const reader = vi.fn();
    clock.subscribe(reader)();

    vi.advanceTimersByTime(120_000);
    expect(reader).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(clock.getSnapshot()).toBe(Date.now());
  });

  it("catches up a late tick for every reader at the first read", async () => {
    const clock = sharedClock(30_003);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = clock.subscribe(first);
    const stopSecond = clock.subscribe(second);
    // A sleeping computer: the clock moves on but the timer hasn't run.
    vi.setSystemTime(Date.now() + 120_000);
    expect(clock.getSnapshot()).toBe(Date.now());
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  });
});
