/**
 * Moving the window from a header control that is also a button (the
 * project name and the thread title open menus on a click). Their
 * buttons can't be part of the window's drag area, and Electron has no way
 * to start a native drag from page content, so the app moves the window
 * itself: the page says when a press turned into a drag (`setWindowDragging`
 * on the desktop bridge) and when it ended.
 *
 * While a drag lasts, about 60 times a second the window follows the cursor,
 * keeping the offset it had when the drag started. Whole pixels, position
 * only (never `setBounds`), so the window can't change size, which matters
 * on Windows across monitors with different scaling. The loop runs only
 * during a drag: it ends on the page's stop, when the window loses focus, or
 * after 10 s without a stop, in case one never comes. A maximized or
 * full-screen window doesn't move.
 *
 * Under Wayland the app can't read the cursor's place on screen or move its
 * window, so there the drag isn't offered at all (`canMoveWindow`): the
 * page's buttons stay plain buttons.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";

export const DRAG_FRAME_MS = 16;

/**
 * Whether this app can move its own window: everywhere but Linux under
 * Wayland, where Electron supports neither `screen.getCursorScreenPoint()`
 * nor `setPosition()`. Chromium picks Wayland when asked to
 * (`--ozone-platform=wayland`), or, left to choose, when the session has a
 * Wayland display; `--ozone-platform=x11` (or the hint) keeps it on X11.
 */
export function canMoveOwnWindow(input: {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--ozone-platform`, or "" when not given. */
  readonly ozonePlatform: string;
  /** `--ozone-platform-hint`, or "" when not given. */
  readonly ozonePlatformHint: string;
}): boolean {
  if (input.platform !== "linux") return true;
  const chosen = input.ozonePlatform || input.ozonePlatformHint;
  if (chosen === "x11") return true;
  if (chosen === "wayland") return false;
  const waylandSession =
    (input.env.WAYLAND_DISPLAY ?? "") !== "" || input.env.XDG_SESSION_TYPE === "wayland";
  return !waylandSession;
}
/** A drag with no stop after this long ends on its own. */
export const DRAG_SAFETY_MS = 10_000;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** What the loop needs of a window. */
export interface DraggableWindow {
  readonly getPosition: () => number[];
  readonly setPosition: (x: number, y: number) => void;
  readonly isMaximized: () => boolean;
  readonly isFullScreen: () => boolean;
  readonly isDestroyed: () => boolean;
  readonly once: (event: "blur", listener: () => void) => unknown;
  readonly removeListener: (event: "blur", listener: () => void) => unknown;
}

export interface WindowDragClock {
  readonly setInterval: (run: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/** One drag at a time: `start` follows the cursor, `stop` ends it. */
export function makeWindowDragLoop(input: {
  readonly cursor: () => Point;
  readonly clock: WindowDragClock;
}) {
  const { cursor, clock } = input;
  let current: { readonly stop: () => void } | null = null;

  const stop = () => {
    current?.stop();
    current = null;
  };

  const start = (window: DraggableWindow) => {
    stop();
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    const [windowX = 0, windowY = 0] = window.getPosition();
    const from = cursor();
    const offset = { x: from.x - windowX, y: from.y - windowY };
    let last = { x: windowX, y: windowY };

    const follow = () => {
      if (window.isDestroyed()) {
        stop();
        return;
      }
      const at = cursor();
      const next = { x: Math.round(at.x - offset.x), y: Math.round(at.y - offset.y) };
      if (next.x === last.x && next.y === last.y) return;
      last = next;
      window.setPosition(next.x, next.y);
    };

    const frame = clock.setInterval(follow, DRAG_FRAME_MS);
    const safety = clock.setTimeout(stop, DRAG_SAFETY_MS);
    const onBlur = () => stop();
    window.once("blur", onBlur);
    current = {
      stop: () => {
        clock.clearInterval(frame);
        clock.clearTimeout(safety);
        if (!window.isDestroyed()) window.removeListener("blur", onBlur);
      },
    };
  };

  return { start, stop, isDragging: () => current !== null };
}

export interface DesktopWindowDragShape {
  /** Whether a drag can move this window here (canMoveOwnWindow); the page offers it only then. */
  readonly canMoveWindow: boolean;
  /** A press on a header control became a drag (true), or ended (false). */
  readonly setDragging: (dragging: boolean) => Effect.Effect<void>;
}

export class DesktopWindowDrag extends Context.Service<DesktopWindowDrag, DesktopWindowDragShape>()(
  "threadlines/desktop/WindowDrag",
) {}

export const layer = Layer.effect(
  DesktopWindowDrag,
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const canMoveWindow = canMoveOwnWindow({
      platform: process.platform,
      env: process.env,
      ozonePlatform: Electron.app.commandLine.getSwitchValue("ozone-platform"),
      ozonePlatformHint: Electron.app.commandLine.getSwitchValue("ozone-platform-hint"),
    });
    const loop = makeWindowDragLoop({
      cursor: () => Electron.screen.getCursorScreenPoint(),
      clock: {
        setInterval: (run, ms) => setInterval(run, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(loop.stop));
    return DesktopWindowDrag.of({
      canMoveWindow,
      setDragging: (dragging) =>
        Effect.gen(function* () {
          if (!canMoveWindow) return;
          if (!dragging) {
            loop.stop();
            return;
          }
          // The press happened in the window that has focus.
          const window = yield* electronWindow.focusedMainOrFirst;
          if (window._tag === "None") return;
          loop.start(window.value);
        }).pipe(Effect.withSpan("desktop.windowDrag.setDragging")),
    });
  }),
);
