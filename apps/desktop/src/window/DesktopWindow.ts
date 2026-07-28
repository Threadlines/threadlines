import type { DesktopMenuActionPayload } from "@threadlines/contracts";
import { PREVIEW_PARTITION } from "@threadlines/shared/preview";
import { fromJsonStringPretty } from "@threadlines/shared/schemaJson";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronGlobalShortcut from "../electron/ElectronGlobalShortcut.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronSpelling from "../electron/ElectronSpelling.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";

const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
/**
 * The first window, on a machine that has never opened one.
 *
 * A fraction of the screen rather than a fixed size, because 1100x780 was set
 * when this was a chat with a sidebar, and it now opens onto four columns --
 * sidebar, chat, browser, source control. At that size they arrive already
 * fighting for width, and the first thing anyone does is drag the window
 * bigger. Better to open at the size people end up at.
 *
 * Capped so a 6K display does not get a window the size of a wall, and floored
 * by the minimums so a small laptop still gets something usable.
 */
const DEFAULT_MAIN_WINDOW_SCREEN_FRACTION = 0.9;
const MAX_DEFAULT_MAIN_WINDOW_WIDTH = 2200;
const MAX_DEFAULT_MAIN_WINDOW_HEIGHT = 1400;
const MIN_MAIN_WINDOW_WIDTH = 840;
const MIN_MAIN_WINDOW_HEIGHT = 620;
const MAX_RESTORED_MAIN_WINDOW_DIMENSION = 10_000;
const MAIN_WINDOW_STATE_FILE_NAME = "window-state.json";
const PRINT_SCREEN_ACCELERATOR = "PrintScreen";
const PRINT_SCREEN_KEYS = new Set(["print", "printscreen"]);
export const OPEN_SCREEN_CLIP_MENU_ACTION = "open-screen-clip";

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopServerExposure.DesktopServerExposure
  | DesktopState.DesktopState
  | FileSystem.FileSystem
  | ElectronMenu.ElectronMenu
  | ElectronGlobalShortcut.ElectronGlobalShortcut
  | ElectronShell.ElectronShell
  | ElectronSpelling.ElectronSpelling
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | Path.Path;

export class DesktopWindowDevServerUrlMissingError extends Data.TaggedError(
  "DesktopWindowDevServerUrlMissingError",
)<{}> {
  override get message() {
    return "VITE_DEV_SERVER_URL is required in desktop development.";
  }
}

export type DesktopWindowError =
  | DesktopWindowDevServerUrlMissingError
  | ElectronWindow.ElectronWindowCreateError;

export interface DesktopWindowShape {
  readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
  readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
  readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
  readonly activate: Effect.Effect<void, DesktopWindowError>;
  readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
  readonly handleBackendReady: Effect.Effect<void, DesktopWindowError>;
  readonly dispatchMenuAction: (
    action: string,
    payload?: DesktopMenuActionPayload,
  ) => Effect.Effect<void, DesktopWindowError>;
  readonly syncAppearance: Effect.Effect<void>;
}

export class DesktopWindow extends Context.Service<DesktopWindow, DesktopWindowShape>()(
  "threadlines/desktop/Window",
) {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  DesktopObservability.makeComponentLogger("desktop-window");

interface PersistedMainWindowState {
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
}

const PersistedMainWindowStateDocument = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  isMaximized: Schema.optionalKey(Schema.Boolean),
});
type PersistedMainWindowStateDocument = typeof PersistedMainWindowStateDocument.Type;

const PersistedMainWindowStateJson = fromJsonStringPretty(PersistedMainWindowStateDocument);
const decodePersistedMainWindowStateJson = Schema.decodeEffect(PersistedMainWindowStateJson);
const encodePersistedMainWindowStateJson = Schema.encodeEffect(PersistedMainWindowStateJson);

function resolveDesktopDevServerUrl(
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): Effect.Effect<string, DesktopWindowDevServerUrlMissingError> {
  return Option.match(environment.devServerUrl, {
    onNone: () => Effect.fail(new DesktopWindowDevServerUrlMissingError()),
    onSome: (url) => Effect.succeed(url.href),
  });
}

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function getWindowTitleBarOptions(shouldUseDarkColors: boolean): WindowTitleBarOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

/**
 * The opening size for a given screen.
 *
 * Pure, and exported, because "does this land somewhere sensible on a laptop
 * and on a big monitor" is the whole question and it should not need a running
 * Electron to answer.
 */
export function defaultMainWindowSize(workArea: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const fit = (available: number, fraction: number, minimum: number, maximum: number): number => {
    const scaled = Math.round(available * fraction);
    // The minimum wins over the cap and over the screen: a window smaller than
    // its own minimum size is one Electron will silently enlarge anyway.
    return Math.max(minimum, Math.min(maximum, scaled));
  };
  return {
    width: fit(
      workArea.width,
      DEFAULT_MAIN_WINDOW_SCREEN_FRACTION,
      MIN_MAIN_WINDOW_WIDTH,
      MAX_DEFAULT_MAIN_WINDOW_WIDTH,
    ),
    height: fit(
      workArea.height,
      DEFAULT_MAIN_WINDOW_SCREEN_FRACTION,
      MIN_MAIN_WINDOW_HEIGHT,
      MAX_DEFAULT_MAIN_WINDOW_HEIGHT,
    ),
  };
}

function normalizeRestoredDimension(value: unknown, minimum: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value);
  if (rounded < minimum || rounded > MAX_RESTORED_MAIN_WINDOW_DIMENSION) {
    return null;
  }

  return rounded;
}

function normalizePersistedMainWindowState(
  rawState: PersistedMainWindowStateDocument,
): Option.Option<PersistedMainWindowState> {
  const width = normalizeRestoredDimension(rawState.width, MIN_MAIN_WINDOW_WIDTH);
  const height = normalizeRestoredDimension(rawState.height, MIN_MAIN_WINDOW_HEIGHT);
  if (width === null || height === null) {
    return Option.none();
  }

  return Option.some({
    width,
    height,
    isMaximized: rawState.isMaximized === true,
  });
}

export function getPersistableMainWindowBounds(
  window: Electron.BrowserWindow,
): Pick<Electron.Rectangle, "width" | "height"> {
  return window.isMaximized() ? window.getNormalBounds() : window.getBounds();
}

function loadPersistedMainWindowState(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<Option.Option<PersistedMainWindowState>> {
  return fileSystem.readFileString(filePath, "utf-8").pipe(
    Effect.flatMap(decodePersistedMainWindowStateJson),
    Effect.map(normalizePersistedMainWindowState),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
}

function savePersistedMainWindowState(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  state: PersistedMainWindowState,
): Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError> {
  return Effect.gen(function* () {
    const encoded = yield* encodePersistedMainWindowStateJson(state);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, `${encoded}\n`);
  });
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

function isBarePrintScreenInput(input: Electron.Input): boolean {
  if (input.type !== "keyDown") {
    return false;
  }

  const normalizedKey = input.key.toLowerCase();
  const normalizedCode = input.code.toLowerCase();
  return (
    (PRINT_SCREEN_KEYS.has(normalizedKey) || normalizedCode === "printscreen") &&
    !input.alt &&
    !input.control &&
    !input.meta &&
    !input.shift
  );
}

function openWindowsScreenClip(
  electronShell: ElectronShell.ElectronShellShape,
): Effect.Effect<void> {
  return electronShell
    .openScreenClip()
    .pipe(
      Effect.flatMap((opened) =>
        opened ? Effect.void : logWindowWarning("failed to open Windows screen clipping overlay"),
      ),
    );
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const fileSystem = yield* FileSystem.FileSystem;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronGlobalShortcut = yield* ElectronGlobalShortcut.ElectronGlobalShortcut;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronSpelling = yield* ElectronSpelling.ElectronSpelling;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const path = yield* Path.Path;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const state = yield* DesktopState.DesktopState;
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (
    backendHttpUrl: URL,
  ): Effect.fn.Return<Electron.BrowserWindow, DesktopWindowError> {
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const windowStatePath = environment.path.join(
      environment.stateDir,
      MAIN_WINDOW_STATE_FILE_NAME,
    );
    const persistedWindowState = yield* loadPersistedMainWindowState(fileSystem, windowStatePath);
    const persistedWindowOptions = Option.isSome(persistedWindowState)
      ? {
          width: persistedWindowState.value.width,
          height: persistedWindowState.value.height,
        }
      : defaultMainWindowSize(yield* electronWindow.workAreaSize);
    const window = yield* electronWindow.create({
      ...persistedWindowOptions,
      minWidth: MIN_MAIN_WINDOW_WIDTH,
      minHeight: MIN_MAIN_WINDOW_HEIGHT,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors),
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The in-app browser preview is a <webview> in the renderer, which
        // keeps it inside normal CSS layout instead of a native view floating
        // over the window. `will-attach-webview` below is what makes enabling
        // this safe.
        webviewTag: true,
      },
    });

    // Preview content is untrusted: no Node, no custom preload, and it must run
    // in the preview partition rather than the app's own session.
    //
    // The partition is enforced, not assigned. Electron resolves the guest's
    // session from the element's `partition` attribute before this fires, so
    // assigning `params.partition` here silently does nothing and the guest
    // would inherit the default session -- sharing cookies with Threadlines.
    // Refusing the attach is the only way to make the renderer's attribute
    // load-bearing.
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      if (params.partition !== PREVIEW_PARTITION) {
        event.preventDefault();
      }
    });

    if (Option.isSome(persistedWindowState) && persistedWindowState.value.isMaximized) {
      window.maximize();
    }

    window.on("close", () => {
      const bounds = getPersistableMainWindowBounds(window);
      const width = normalizeRestoredDimension(bounds.width, MIN_MAIN_WINDOW_WIDTH);
      const height = normalizeRestoredDimension(bounds.height, MIN_MAIN_WINDOW_HEIGHT);
      if (width === null || height === null) {
        return;
      }

      void runPromise(
        savePersistedMainWindowState(fileSystem, path, windowStatePath, {
          width,
          height,
          isMaximized: window.isMaximized(),
        }).pipe(
          Effect.catch((error) =>
            logWindowWarning("failed to persist main window state", {
              error: String(error),
              path: windowStatePath,
            }),
          ),
        ),
      );
    });

    let contextMenuRequestVersion = 0;
    window.webContents.on("context-menu", (event, params) => {
      event.preventDefault();
      const requestVersion = ++contextMenuRequestVersion;

      void runPromise(
        Effect.gen(function* () {
          const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

          if (params.misspelledWord) {
            // Chromium hands us empty dictionarySuggestions for words the
            // macOS checker flags only from sentence context (capitalization,
            // contractions). Recover the OS spellchecker's own guesses before
            // settling for "No suggestions".
            const suggestions =
              params.dictionarySuggestions.length > 0
                ? params.dictionarySuggestions
                : yield* electronSpelling.platformSuggestionsFor(params.misspelledWord);
            if (requestVersion !== contextMenuRequestVersion) {
              return;
            }
            for (const suggestion of suggestions.slice(0, 5)) {
              menuTemplate.push({
                label: suggestion,
                click: () => {
                  if (requestVersion !== contextMenuRequestVersion) {
                    return;
                  }
                  window.webContents.replaceMisspelling(suggestion);
                  window.webContents.focus();
                },
              });
            }
            if (suggestions.length === 0) {
              menuTemplate.push({ label: "No suggestions", enabled: false });
            }
            menuTemplate.push({ type: "separator" });
          }

          if (window.isDestroyed()) {
            return;
          }

          if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
            menuTemplate.push(
              {
                label: "Copy Link",
                click: () => {
                  void runPromise(electronShell.copyText(params.linkURL));
                },
              },
              { type: "separator" },
            );
          }

          if (params.mediaType === "image") {
            menuTemplate.push({
              label: "Copy Image",
              click: () => window.webContents.copyImageAt(params.x, params.y),
            });
            menuTemplate.push({ type: "separator" });
          }

          menuTemplate.push(
            { role: "cut", enabled: params.editFlags.canCut },
            { role: "copy", enabled: params.editFlags.canCopy },
            { role: "paste", enabled: params.editFlags.canPaste },
            { role: "selectAll", enabled: params.editFlags.canSelectAll },
          );

          yield* electronMenu.popupTemplate({
            window,
            template: menuTemplate,
            frame: params.frame,
            sourceType: params.menuSourceType,
          });
        }),
      );
    });

    let printScreenShortcutRegistered = false;
    let printScreenShortcutRegistering = false;
    let printScreenShortcutFocused = false;

    window.webContents.on("before-input-event", (event, input) => {
      if (
        environment.platform !== "win32" ||
        printScreenShortcutRegistered ||
        !isBarePrintScreenInput(input)
      ) {
        return;
      }

      event.preventDefault();
      void runPromise(openWindowsScreenClip(electronShell));
    });

    if (environment.platform === "win32") {
      const unregisterPrintScreenShortcut = () => {
        printScreenShortcutFocused = false;
        if (!printScreenShortcutRegistered) {
          return;
        }

        printScreenShortcutRegistered = false;
        void runPromise(electronGlobalShortcut.unregister(PRINT_SCREEN_ACCELERATOR));
      };

      const registerPrintScreenShortcut = () => {
        printScreenShortcutFocused = true;
        if (printScreenShortcutRegistered || printScreenShortcutRegistering) {
          return;
        }

        printScreenShortcutRegistering = true;
        void runPromise(
          electronGlobalShortcut
            .register(PRINT_SCREEN_ACCELERATOR, () => {
              void runPromise(openWindowsScreenClip(electronShell));
            })
            .pipe(
              Effect.flatMap((registered) => {
                printScreenShortcutRegistering = false;
                if (!registered) {
                  return logWindowWarning("failed to register Windows PrintScreen shortcut");
                }

                if (!printScreenShortcutFocused) {
                  return electronGlobalShortcut.unregister(PRINT_SCREEN_ACCELERATOR);
                }

                printScreenShortcutRegistered = true;
                return Effect.void;
              }),
            ),
        );
      };

      window.on("focus", registerPrintScreenShortcut);
      window.on("blur", unregisterPrintScreenShortcut);
      window.on("closed", unregisterPrintScreenShortcut);
    }

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.webContents.on("did-finish-load", () => {
      window.setTitle(environment.displayName);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      void runPromise(
        logWindowWarning("main window render process gone", {
          reason: details.reason,
          exitCode: details.exitCode,
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
    if (process.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }
    bindFirstRevealTrigger(revealSubscribers, () => {
      void runPromise(electronWindow.reveal(window));
    });

    if (environment.isDevelopment) {
      const devServerUrl = yield* resolveDesktopDevServerUrl(environment);
      void window.loadURL(devServerUrl);
      if (environment.openDevToolsInDevelopment) {
        window.webContents.openDevTools({ mode: "detach" });
      }
    } else {
      void window.loadURL(backendHttpUrl.href);
    }

    window.on("closed", () => {
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return window;
  });

  const createMain = Effect.gen(function* () {
    const backendConfig = yield* serverExposure.backendConfig;
    const window = yield* createWindow(backendConfig.httpBaseUrl);
    yield* electronWindow.setMain(window);
    yield* logWindowInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const ensureMain = Effect.gen(function* () {
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) {
      return existingWindow.value;
    }
    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.ensureMain"));

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* electronWindow.reveal(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  const createMainIfBackendReady = Effect.gen(function* () {
    const backendReady = yield* Ref.get(state.backendReady);
    if (!backendReady) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  return DesktopWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    activate: Effect.gen(function* () {
      const existingWindow = yield* electronWindow.currentMainOrFirst;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);
      } else {
        yield* createMainIfBackendReady;
      }
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    handleBackendReady: Effect.gen(function* () {
      yield* Ref.set(state.backendReady, true);
      yield* logWindowInfo("backend ready", { source: "http" });
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.handleBackendReady")),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, payload) {
      if (action === OPEN_SCREEN_CLIP_MENU_ACTION) {
        yield* openWindowsScreenClip(electronShell);
        return;
      }

      yield* Effect.annotateCurrentSpan({ action });
      const existingWindow = yield* electronWindow.focusedMainOrFirst;
      const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* createMain;

      const send = () => {
        if (targetWindow.isDestroyed()) return;
        targetWindow.webContents.send(IpcChannels.MENU_ACTION_CHANNEL, action, payload);
        void runPromise(electronWindow.reveal(targetWindow));
      };

      if (targetWindow.webContents.isLoadingMainFrame()) {
        targetWindow.webContents.once("did-finish-load", send);
        return;
      }

      send();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
