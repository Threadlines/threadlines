import { useCallback, useEffect, useRef } from "react";
import type * as React from "react";

/** How long a finger rests on a row before its menu opens. */
export const TOUCH_HOLD_MS = 500;
/** How far a finger may drift (a scroll starting) before the hold is off. */
const TOUCH_HOLD_SLOP_PX = 10;

interface HoldState {
  timer: ReturnType<typeof setTimeout> | null;
  x: number;
  y: number;
  /** The hold opened the menu: the click that ends it must not also open the row. */
  opened: boolean;
  /** Until when a browser's own long-press menu event is taken as this hold's. */
  nativeMenuUntil: number;
}

/**
 * Press and hold on a touch screen opens what a right-click opens. iOS sends
 * no `contextmenu` for a held element, so the hold times itself; Android
 * sends one anyway, and whichever comes first wins, so the menu opens once.
 * The click that ends a hold is swallowed, so the row doesn't open too.
 *
 * Spread the handlers on the row; `onContextMenu` wraps the row's own
 * right-click handler.
 */
export function useTouchHoldMenu<E extends Element>(input: {
  readonly open: (position: { readonly x: number; readonly y: number }) => void;
  readonly onContextMenu: (event: React.MouseEvent<E>) => void;
}) {
  const { open, onContextMenu } = input;
  const state = useRef<HoldState>({ timer: null, x: 0, y: 0, opened: false, nativeMenuUntil: 0 });

  const cancel = useCallback(() => {
    if (state.current.timer !== null) {
      clearTimeout(state.current.timer);
      state.current.timer = null;
    }
  }, []);
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<E>) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      cancel();
      const x = event.clientX;
      const y = event.clientY;
      state.current.x = x;
      state.current.y = y;
      state.current.opened = false;
      state.current.timer = setTimeout(() => {
        state.current.timer = null;
        state.current.opened = true;
        state.current.nativeMenuUntil = performance.now() + 1000;
        open({ x, y });
      }, TOUCH_HOLD_MS);
    },
    [cancel, open],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<E>) => {
      if (state.current.timer === null) return;
      if (
        Math.abs(event.clientX - state.current.x) > TOUCH_HOLD_SLOP_PX ||
        Math.abs(event.clientY - state.current.y) > TOUCH_HOLD_SLOP_PX
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const onClickCapture = useCallback((event: React.MouseEvent<E>) => {
    if (!state.current.opened) return;
    state.current.opened = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<E>) => {
      if (performance.now() < state.current.nativeMenuUntil) {
        // The hold already opened it.
        event.preventDefault();
        return;
      }
      cancel();
      onContextMenu(event);
    },
    [cancel, onContextMenu],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture,
    onContextMenu: handleContextMenu,
  };
}
