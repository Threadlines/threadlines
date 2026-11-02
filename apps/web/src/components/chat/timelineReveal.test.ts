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

  /**
   * A list whose row sits `rowInContent` px down its content, scrolled
   * `scrollTop`; on screen the row is at their difference, its place at 100.
   * `place` puts it there, at once or once `land` runs (a scroll the list
   * puts off).
   */
  const makeList = (options: { readonly deferred: boolean }) => {
    const state = { rowInContent: 1_000, scrollTop: 0 };
    const node = {
      getBoundingClientRect: () => ({ top: 0 }),
      get scrollTop() {
        return state.scrollTop;
      },
    };
    const row = { getBoundingClientRect: () => ({ top: state.rowInContent - state.scrollTop }) };
    const placedAt: number[] = [];
    let pending: (() => void) | null = null;
    const place = () => {
      placedAt.push(state.rowInContent - state.scrollTop);
      const scroll = () => {
        state.scrollTop = state.rowInContent - 100;
      };
      if (options.deferred) pending = scroll;
      else scroll();
    };
    const reveal = () =>
      revealTimelineRow({
        getList: () =>
          ({
            scrollToIndex: () => Promise.resolve(),
            getScrollableNode: () => node,
          }) as unknown as LegendListRef,
        resolveIndex: () => 5,
        findRow: () => row as HTMLElement,
        viewPosition: 0.2,
        animated: () => false,
        scrollAttempts: 1,
        renderAttempts: 1,
        onRow: place,
        hold: {
          durationMs: 60_000,
          isPlaced: () => Math.abs(state.rowInContent - state.scrollTop - 100) < 4,
        },
      });
    const land = () => {
      pending?.();
      pending = null;
    };
    return { state, placedAt, reveal, land };
  };

  it("waits for a late placement, puts the row back when a row above moves it, and lets go once it keeps still", async () => {
    const list = makeList({ deferred: true });
    list.reveal();
    await frame(); // scrolls to the row
    await frame(); // finds it and asks to place it; the list puts that off
    expect(list.placedAt).toEqual([1_000]);
    await frame();
    await frame();
    await frame();
    expect(frames).toHaveLength(1); // not in place yet: still held

    list.land();
    await frame();
    list.state.rowInContent = 1_012; // a row above it is measured late
    await frame();
    expect(list.placedAt).toEqual([1_000, 112]);
    list.land();

    await frame();
    await frame();
    await frame(); // in place and still for three frames: the hold ends
    expect(frames).toEqual([]);
  });

  it("never fights a scroll, and stops holding once cancelled", async () => {
    const list = makeList({ deferred: false });
    const cancel = list.reveal();
    await frame();
    await frame();
    expect(list.placedAt).toEqual([1_000]);

    // The reader scrolls, however: the row keeps its place in the content.
    for (let step = 1; step <= 5; step++) {
      list.state.scrollTop += 40;
      await frame();
    }
    expect(list.placedAt).toEqual([1_000]);
    expect(frames).toHaveLength(1);

    cancel();
    list.state.rowInContent = 1_050;
    await frame();
    expect(list.placedAt).toEqual([1_000]);
  });
});
