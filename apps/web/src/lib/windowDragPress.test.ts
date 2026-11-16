import { describe, expect, it, vi } from "vite-plus/test";

import { createWindowDragPress, DRAG_START_PX } from "./windowDragPress";

/** A press on a button: down at (10, 10), moves, up, then the click the browser sends. */
function press(moves: ReadonlyArray<readonly [number, number]>) {
  const setDragging = vi.fn(async (_dragging: boolean) => undefined);
  const handlers = createWindowDragPress(setDragging);
  const captured = vi.fn();
  const pointer = (x: number, y: number) => ({ pointerId: 1, clientX: x, clientY: y });
  handlers.onPointerDown({
    ...pointer(10, 10),
    button: 0,
    isPrimary: true,
    currentTarget: { setPointerCapture: captured },
    preventDefault: () => undefined,
  });
  for (const [x, y] of moves) handlers.onPointerMove(pointer(x, y));
  const last = moves.at(-1) ?? [10, 10];
  handlers.onPointerUp(pointer(last[0], last[1]));
  handlers.onLostPointerCapture(pointer(last[0], last[1]));
  const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  handlers.onClickCapture(click);
  return { setDragging, captured, clickSwallowed: click.stopPropagation.mock.calls.length > 0 };
}

describe("createWindowDragPress", () => {
  it("leaves a press that barely moves a click: the menu opens, the window stays", () => {
    const { setDragging, captured, clickSwallowed } = press([
      [12, 11],
      [10 + DRAG_START_PX, 10],
    ]);
    expect(captured).toHaveBeenCalledWith(1);
    expect(setDragging).not.toHaveBeenCalled();
    expect(clickSwallowed).toBe(false);
  });

  it("turns a press that moves further into a window drag, and swallows its click", () => {
    const { setDragging, clickSwallowed } = press([
      [12, 11],
      [20, 14],
      [60, 40],
    ]);
    // Started once, stopped once.
    expect(setDragging.mock.calls).toEqual([[true], [false]]);
    expect(clickSwallowed).toBe(true);
  });

  it("stops the window on a cancel, and the next click goes through", () => {
    const setDragging = vi.fn(async (_dragging: boolean) => undefined);
    const handlers = createWindowDragPress(setDragging);
    handlers.onPointerDown({
      pointerId: 7,
      clientX: 0,
      clientY: 0,
      button: 0,
      isPrimary: true,
      currentTarget: { setPointerCapture: () => undefined },
      preventDefault: () => undefined,
    });
    handlers.onPointerMove({ pointerId: 7, clientX: 30, clientY: 0 });
    handlers.onPointerCancel({ pointerId: 7, clientX: 30, clientY: 0 });
    expect(setDragging.mock.calls).toEqual([[true], [false]]);
    // A keyboard click afterwards is still a click.
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handlers.onClickCapture(click);
    expect(click.stopPropagation).not.toHaveBeenCalled();
  });

  it("ignores presses of other buttons", () => {
    const setDragging = vi.fn(async (_dragging: boolean) => undefined);
    const handlers = createWindowDragPress(setDragging);
    const captured = vi.fn();
    handlers.onPointerDown({
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      button: 2,
      isPrimary: true,
      currentTarget: { setPointerCapture: captured },
      preventDefault: () => undefined,
    });
    handlers.onPointerMove({ pointerId: 1, clientX: 50, clientY: 50 });
    expect(captured).not.toHaveBeenCalled();
    expect(setDragging).not.toHaveBeenCalled();
  });
});
