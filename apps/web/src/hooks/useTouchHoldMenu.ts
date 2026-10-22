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
  /**
   * When the hold opened the menu: the click that ends that same press must
   * not also open the row. Any new press, or a second gone by, ends it.
   */
  openedAt: number | null;
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
  const state = useRef<HoldState>({ timer: null, x: 0, y: 0, openedAt: null, nativeMenuUntil: 0 });

  const cancel = useCallback(() => {
    if (state.current.timer !== null) {
      clearTimeout(state.current.timer);
      state.current.timer = null;
    }
  }, []);
  useEffect(() => cancel, [cancel]);

  // On the way down (capture), so a control in the row that stops the press
  // (Wrap up) still starts a new gesture here.
  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent<E>) => {
      cancel();
      state.current.openedAt = null;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const x = event.clientX;
      const y = event.clientY;
      state.current.x = x;
      state.current.y = y;
      state.current.timer = setTimeout(() => {
        state.current.timer = null;
        const now = performance.now();
        state.current.openedAt = now;
        state.current.nativeMenuUntil = now + 1000;
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
    const openedAt = state.current.openedAt;
    state.current.openedAt = null;
    if (openedAt === null || performance.now() - openedAt > 1000) return;
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
    onPointerDownCapture,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture,
    onContextMenu: handleContextMenu,
  };
}
