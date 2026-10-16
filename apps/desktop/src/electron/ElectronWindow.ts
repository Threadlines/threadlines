import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

export class ElectronWindowCreateError extends Data.TaggedError("ElectronWindowCreateError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Failed to create Electron BrowserWindow.";
  }
}

export interface ElectronWindowShape {
  /**
   * The usable area of the primary display, menu bar and dock excluded.
   *
   * Here rather than read from `Electron.screen` at the call site so window
   * sizing stays testable without a display attached.
   */
  readonly workAreaSize: Effect.Effect<{ width: number; height: number }>;
  readonly create: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => Effect.Effect<Electron.BrowserWindow, ElectronWindowCreateError>;
  readonly main: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  readonly currentMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  readonly focusedMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  readonly setMain: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly clearMain: (window: Option.Option<Electron.BrowserWindow>) => Effect.Effect<void>;
  readonly reveal: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  /**
   * The browser panel's pages in a window: its webview guests and their
   * sign-in pop-ups. Here rather
   * than read from `Electron.webContents` at the call site so what the window
   * does to them stays testable.
   */
  readonly guestsOf: (
    window: Electron.BrowserWindow,
  ) => Effect.Effect<ReadonlyArray<Electron.WebContents>>;
  readonly sendAll: (channel: string, ...args: readonly unknown[]) => Effect.Effect<void>;
  readonly destroyAll: Effect.Effect<void>;
  readonly syncAllAppearance: <E, R>(
    sync: (window: Electron.BrowserWindow) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, E, R>;
}

export class ElectronWindow extends Context.Service<ElectronWindow, ElectronWindowShape>()(
  "threadlines/desktop/electron/Window",
) {}

/**
 * Whether a window is the app's own rather than a page's.
 *
 * The app makes one kind of window, and its page runs in the default session.
 * The browser panel's sign-in pop-ups are windows too, but their pages run in
 * a preview profile's session and are as untrusted as any page in the panel,
 * so nothing meant for the app goes to one: menu actions, app messages,
 * dialogs the app owns.
 */
export function isAppWindow(window: Electron.BrowserWindow): boolean {
  return !window.isDestroyed() && window.webContents.session === Electron.session.defaultSession;
}

const appWindows = () => Electron.BrowserWindow.getAllWindows().filter(isAppWindow);

const make = Effect.gen(function* () {
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

  const liveMain = Ref.get(mainWindowRef).pipe(
    Effect.map(Option.filter((value) => !value.isDestroyed())),
  );

  const currentMainOrFirst = Effect.gen(function* () {
    const main = yield* liveMain;
    if (Option.isSome(main)) {
      return main;
    }

    return Option.fromNullishOr(appWindows()[0] ?? null);
  });

  // A focused sign-in pop-up is not where a menu action or a dialog belongs:
  // the app window behind it is.
  const focusedMainOrFirst = Effect.sync(() =>
    Option.fromNullishOr(Electron.BrowserWindow.getFocusedWindow() ?? null).pipe(
      Option.filter(isAppWindow),
    ),
  ).pipe(
    Effect.flatMap((focused) =>
      Option.isSome(focused) ? Effect.succeed(focused) : currentMainOrFirst,
    ),
  );

  return ElectronWindow.of({
    workAreaSize: Effect.sync(() => Electron.screen.getPrimaryDisplay().workAreaSize),
    create: (options) =>
      Effect.try({
        try: () => new Electron.BrowserWindow(options),
        catch: (cause) => new ElectronWindowCreateError({ cause }),
      }),
    main: liveMain,
    currentMainOrFirst,
    focusedMainOrFirst,
    setMain: (window) => Ref.set(mainWindowRef, Option.some(window)),
    clearMain: (window) =>
      Ref.update(mainWindowRef, (current) => {
        if (Option.isNone(current)) {
          return current;
        }
        if (Option.isSome(window) && current.value !== window.value) {
          return current;
        }
        return Option.none();
      }),
    reveal: (window) =>
      Effect.sync(() => {
        if (window.isDestroyed()) {
          return;
        }

        if (window.isMinimized()) {
          window.restore();
        }

        if (!window.isVisible()) {
          window.show();
        }

        if (process.platform === "darwin") {
          Electron.app.focus({ steal: true });
        }

        window.focus();
      }),
    guestsOf: (window) =>
      Effect.sync(() => {
        if (window.isDestroyed()) return [];
        const hostId = window.webContents.id;
        const guests = Electron.webContents
          .getAllWebContents()
          .filter(
            (contents) =>
              !contents.isDestroyed() &&
              contents.getType() === "webview" &&
              contents.hostWebContents?.id === hostId,
          );
        const popups = window
          .getChildWindows()
          .filter((child) => !child.isDestroyed() && !isAppWindow(child))
          .map((child) => child.webContents);
        return [...guests, ...popups];
      }),
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        for (const window of appWindows()) {
          window.webContents.send(channel, ...args);
        }
      }),
    destroyAll: Effect.sync(() => {
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        window.destroy();
      }
    }),
    syncAllAppearance: Effect.fn("desktop.electron.window.syncAllAppearance")(function* <E, R>(
      sync: (window: Electron.BrowserWindow) => Effect.Effect<void, E, R>,
    ) {
      for (const window of appWindows()) {
        yield* sync(window);
      }
    }),
  });
});

export const layer = Layer.effect(ElectronWindow, make);
