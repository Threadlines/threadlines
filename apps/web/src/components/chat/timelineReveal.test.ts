import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { revealTimelineRow } from "./timelineReveal";

describe("revealTimelineRow", () => {
  let frames: Array<() => void> = [];
  /** Runs one frame's callbacks, then lets the promises they settled run. */
  const frame = async () => {
    const due = frames;
    frames = [];
    for (const callback of due) callback();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };

  beforeEach(() => {
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      cancelAnimationFrame: () => undefined,
    });
  });
  afterEach(() => {
    frames = [];
    vi.unstubAllGlobals();
  });

  it("puts a held row back when the list moves it, until it keeps still", async () => {
    // Where the row is on screen; placing it puts it at 100.
    let top = 300;
    const row = { getBoundingClientRect: () => ({ top }) } as HTMLElement;
    const placed: number[] = [];
    const cancel = revealTimelineRow({
      getList: () => ({ scrollToIndex: () => Promise.resolve() }) as unknown as LegendListRef,
      resolveIndex: () => 5,
      findRow: () => row,
      viewPosition: 0.2,
      animated: () => false,
      scrollAttempts: 1,
      renderAttempts: 1,
      holdFrames: 30,
      onRow: () => {
        placed.push(top);
        top = 100;
      },
    });

    await frame(); // scrolls to the row
    await frame(); // finds it and places it
    expect(placed).toEqual([300]);

    await frame(); // still
    top = 112; // a row above it is measured late
    await frame();
    expect(placed).toEqual([300, 112]);

    await frame();
    await frame();
    await frame(); // three still frames end the hold
    top = 140;
    await frame();
    expect(placed).toEqual([300, 112]);
    expect(frames).toEqual([]);
    cancel();
  });

  it("stops holding once cancelled, as when the reader scrolls", async () => {
    let top = 300;
    const row = { getBoundingClientRect: () => ({ top }) } as HTMLElement;
    const placed: number[] = [];
    const cancel = revealTimelineRow({
      getList: () => ({ scrollToIndex: () => Promise.resolve() }) as unknown as LegendListRef,
      resolveIndex: () => 5,
      findRow: () => row,
      viewPosition: 0.2,
      animated: () => false,
      scrollAttempts: 1,
      renderAttempts: 1,
      holdFrames: 30,
      onRow: () => {
        placed.push(top);
        top = 100;
      },
    });
    await frame();
    await frame();
    cancel();
    top = 160;
    await frame();
    expect(placed).toEqual([300]);
  });
});
