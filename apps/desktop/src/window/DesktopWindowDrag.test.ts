import { assert, describe, it } from "@effect/vitest";

import {
  DRAG_FRAME_MS,
  DRAG_SAFETY_MS,
  makeWindowDragLoop,
  type DraggableWindow,
} from "./DesktopWindowDrag.ts";

/** A clock the test moves by hand: intervals and one-shot timers, in ms. */
function makeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  return {
    clock: {
      setInterval: (run: () => void, ms: number) => {
        nextId += 1;
        timers.set(nextId, { at: now + ms, every: ms, run });
        return nextId;
      },
      clearInterval: (handle: unknown) => void timers.delete(handle as number),
      setTimeout: (run: () => void, ms: number) => {
        nextId += 1;
        timers.set(nextId, { at: now + ms, every: null, run });
        return nextId;
      },
      clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .toSorted(([, left], [, right]) => left.at - right.at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.run();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function makeWindow(input?: { maximized?: boolean; fullScreen?: boolean }) {
  let position: [number, number] = [100, 200];
  const moves: Array<[number, number]> = [];
  const blurListeners = new Set<() => void>();
  const window: DraggableWindow = {
    getPosition: () => [...position],
    setPosition: (x, y) => {
      position = [x, y];
      moves.push([x, y]);
    },
    isMaximized: () => input?.maximized ?? false,
    isFullScreen: () => input?.fullScreen ?? false,
    isDestroyed: () => false,
    once: (_event, listener) => blurListeners.add(listener),
    removeListener: (_event, listener) => blurListeners.delete(listener),
  };
  return {
    window,
    moves,
    blur: () => {
      for (const listener of blurListeners) listener();
    },
  };
}

describe("makeWindowDragLoop", () => {
  it("moves the window by how far the cursor moved, in whole pixels, only when it changed", () => {
    const time = makeClock();
    let cursor = { x: 150, y: 210 };
    const loop = makeWindowDragLoop({ cursor: () => cursor, clock: time.clock });
    const target = makeWindow();

    loop.start(target.window);
    time.advance(DRAG_FRAME_MS * 3);
    assert.deepStrictEqual(target.moves, []);

    cursor = { x: 180.4, y: 195.6 };
    time.advance(DRAG_FRAME_MS * 3);
    assert.deepStrictEqual(target.moves, [[130, 186]]);

    loop.stop();
    cursor = { x: 400, y: 400 };
    time.advance(DRAG_FRAME_MS * 3);
    assert.deepStrictEqual(target.moves, [[130, 186]]);
    // Nothing runs once it stopped.
    assert.strictEqual(time.pending(), 0);
  });

  it("stops when the window loses focus, or after a while with no stop", () => {
    const time = makeClock();
    let cursor = { x: 0, y: 0 };
    const loop = makeWindowDragLoop({ cursor: () => cursor, clock: time.clock });

    const blurred = makeWindow();
    loop.start(blurred.window);
    blurred.blur();
    assert.isFalse(loop.isDragging());
    assert.strictEqual(time.pending(), 0);

    const forgotten = makeWindow();
    loop.start(forgotten.window);
    time.advance(DRAG_SAFETY_MS);
    assert.isFalse(loop.isDragging());
    assert.strictEqual(time.pending(), 0);
    cursor = { x: 50, y: 50 };
    time.advance(DRAG_FRAME_MS * 3);
    assert.deepStrictEqual(forgotten.moves, []);
  });

  it("leaves a maximized or full-screen window where it is", () => {
    const time = makeClock();
    let cursor = { x: 0, y: 0 };
    const loop = makeWindowDragLoop({ cursor: () => cursor, clock: time.clock });

    for (const target of [makeWindow({ maximized: true }), makeWindow({ fullScreen: true })]) {
      loop.start(target.window);
      assert.isFalse(loop.isDragging());
      cursor = { x: cursor.x + 40, y: cursor.y + 40 };
      time.advance(DRAG_FRAME_MS * 3);
      assert.deepStrictEqual(target.moves, []);
    }
    assert.strictEqual(time.pending(), 0);
  });
});
