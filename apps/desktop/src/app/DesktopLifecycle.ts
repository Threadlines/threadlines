import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export interface DesktopShutdownShape {
  readonly request: Effect.Effect<void>;
  readonly awaitRequest: Effect.Effect<void>;
  readonly markComplete: Effect.Effect<void>;
  readonly awaitComplete: Effect.Effect<void>;
  readonly isComplete: Effect.Effect<boolean>;
}

export class DesktopShutdown extends Context.Service<DesktopShutdown, DesktopShutdownShape>()(
  "threadlines/desktop/Shutdown",
) {}

const makeShutdown = Effect.gen(function* () {
  const requested = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const completedRef = yield* Ref.make(false);

  return DesktopShutdown.of({
    request: Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    awaitRequest: Deferred.await(requested),
    markComplete: Ref.set(completedRef, true).pipe(
      Effect.andThen(Deferred.succeed(completed, undefined)),
      Effect.asVoid,
    ),
    awaitComplete: Deferred.await(completed),
    isComplete: Ref.get(completedRef),
  });
});

export const layerShutdown = Layer.effect(DesktopShutdown, makeShutdown);

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | ElectronTheme.ElectronTheme;

export interface DesktopLifecycleShape {
  readonly relaunch: (reason: string) => Effect.Effect<void>;
  readonly register: Effect.Effect<void, never, Scope.Scope>;
}

export class DesktopLifecycle extends Context.Service<DesktopLifecycle, DesktopLifecycleShape>()(
  "threadlines/desktop/Lifecycle",
) {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  DesktopObservability.makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

/**
 * How long a quit may wait for the backend to stop before we stop asking
 * nicely. A shutdown that never completes leaves a windowless process holding
 * the single-instance lock, which makes every later launch look like a dead
 * app, so the failsafe has to win eventually.
 */
export const DESKTOP_SHUTDOWN_FAILSAFE_DURATION = Duration.seconds(15);

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (): Effect.fn.Return<void, never, DesktopShutdown> {
    const shutdown = yield* DesktopShutdown;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

/** Threads on other computers run on their own servers and keep going. */
const QUIT_STOPS_LOCAL_WORK_DETAIL =
  "Quitting now will stop the local Threadlines server and the work running on it.";

/**
 * The counts come from the open window and cover only this computer's
 * threads and terminals. With every window closed (the app keeps running on
 * macOS) they are what the last window saw, which can be long out of date, so
 * the dialog says what it knows rather than what it guesses.
 */
export function describeRunningWorkForNativeQuit(
  work: { readonly threadCount: number; readonly terminalCount: number },
  windowOpen: boolean,
): string {
  const parts: string[] = [];
  if (work.threadCount > 0) {
    parts.push(work.threadCount === 1 ? "an agent session" : `${work.threadCount} agent sessions`);
  }
  if (work.terminalCount > 0) {
    parts.push(
      work.terminalCount === 1 ? "a terminal command" : `${work.terminalCount} terminal commands`,
    );
  }
  const single = work.threadCount + work.terminalCount === 1;
  const verb = windowOpen ? (single ? "is still" : "are still") : "may still be";
  const sentence = `${parts.join(" and ")} ${verb} running.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function countOrZero(count: number): number {
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** What quitting does to this computer's scheduled tasks, or null when it has none. */
function describeScheduledTasksForNativeQuit(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "A scheduled task won't run until you open Threadlines again."
    : `${count} scheduled tasks won't run until you open Threadlines again.`;
}

export const confirmQuitWithRunningAgentSessions = Effect.fn(
  "desktop.lifecycle.confirmQuitWithRunningAgentSessions",
)(function* (): Effect.fn.Return<
  boolean,
  never,
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const state = yield* DesktopState.DesktopState;
  if (yield* Ref.get(state.quitting)) {
    return true;
  }

  // Only this computer's work: quitting leaves threads and terminals on other
  // computers running, so they are no reason to ask.
  const runningThreadCount = countOrZero(yield* Ref.get(state.localRunningThreadCount));
  const busyTerminalCount = countOrZero(yield* Ref.get(state.localBusyTerminalCount));
  // Scheduled tasks stop running while the app is closed. That alone asks
  // only where the user chose to keep the app running in the background
  // (Windows and Linux): there quitting is a deliberate stop; elsewhere the
  // question would come at every quit.
  const activeScheduledTaskCount = countOrZero(yield* Ref.get(state.activeScheduledTaskCount));
  const schedulesAsk = (yield* Ref.get(state.runInBackground)) && activeScheduledTaskCount > 0;
  if (runningThreadCount <= 0 && busyTerminalCount <= 0 && !schedulesAsk) return true;

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  return yield* desktopWindow
    .requestQuitConfirmation({ runningThreadCount, busyTerminalCount, activeScheduledTaskCount })
    .pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* logLifecycleInfo("asking to quit with a native dialog", {
            reason: String(error.cause),
          });
          const electronDialog = yield* ElectronDialog.ElectronDialog;
          const electronApp = yield* ElectronApp.ElectronApp;
          // A quit from the Dock or the menu bar leaves the app in the back,
          // where a dialog with no window would open unseen.
          yield* electronApp.focus;
          const message = [
            runningThreadCount > 0 || busyTerminalCount > 0
              ? describeRunningWorkForNativeQuit(
                  { threadCount: runningThreadCount, terminalCount: busyTerminalCount },
                  error.windowOpen,
                )
              : null,
            describeScheduledTasksForNativeQuit(activeScheduledTaskCount),
          ]
            .filter((line) => line !== null)
            .join(" ");
          const result = yield* electronDialog.showMessageBox({
            type: "warning",
            title: "Quit Threadlines?",
            message,
            detail: QUIT_STOPS_LOCAL_WORK_DETAIL,
            buttons: ["Keep Running", "Quit Anyway"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return result.response === 1;
        }),
      ),
    );
});

/**
 * Requests shutdown and waits for it, but never forever: on timeout the process
 * is forced down so it cannot linger holding the single-instance lock. A
 * shutdown that completes in time is untouched.
 */
export const requestDesktopShutdownAndWaitWithFailsafe = Effect.fn(
  "desktop.lifecycle.requestShutdownAndWaitWithFailsafe",
)(function* (): Effect.fn.Return<void, never, DesktopShutdown | ElectronApp.ElectronApp> {
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* requestDesktopShutdownAndWait().pipe(
    Effect.timeoutOrElse({
      duration: DESKTOP_SHUTDOWN_FAILSAFE_DURATION,
      orElse: () =>
        logLifecycleError("shutdown did not complete before the failsafe; forcing exit", {
          failsafeMs: Duration.toMillis(DESKTOP_SHUTDOWN_FAILSAFE_DURATION),
        }).pipe(Effect.andThen(electronApp.exit(1))),
    }),
  );
});

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
  quitRequestPending: () => boolean,
  markQuitRequestPending: (pending: boolean) => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  if (quitRequestPending()) {
    // Asking again must never be a dead key: it brings the question back,
    // the window's or, when that one gave way to it, the native dialog.
    void runEffect(
      Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const repeated = yield* desktopWindow.repeatQuitConfirmation;
        const state = yield* DesktopState.DesktopState;
        if (!repeated && !(yield* Ref.get(state.quitting))) {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.focus;
        }
        yield* logLifecycleInfo("quit asked for again while confirming", { repeated });
      }).pipe(Effect.withSpan("desktop.lifecycle.repeatQuit")),
    );
    return;
  }
  markQuitRequestPending(true);
  void runEffect(
    Effect.gen(function* () {
      const shouldQuit = yield* confirmQuitWithRunningAgentSessions();
      if (!shouldQuit) {
        yield* logLifecycleInfo("before-quit canceled because agent sessions are running");
        return false;
      }
      const state = yield* DesktopState.DesktopState;
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWaitWithFailsafe();
      return true;
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  )
    .then((shouldQuit) => {
      if (!shouldQuit) return;
      markQuitAllowed();
      void runEffect(
        Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* desktopWindow.allowMainWindowClose;
          yield* electronApp.quit;
        }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
      );
    })
    .catch(() => {
      // A dialog failure should leave the app open; the original quit event was
      // already canceled.
    })
    .finally(() => {
      markQuitRequestPending(false);
    });
}

/**
 * A signal is a quit nobody is asked about. It is let through `before-quit`
 * explicitly: a quit question already open would otherwise take the signal's
 * own quit as a repeat, and the app would wait on an answer after its backend
 * had stopped.
 */
function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
  markQuitAllowed: () => void,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWaitWithFailsafe();
      markQuitAllowed();
      yield* desktopWindow.allowMainWindowClose;
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

const relaunch = Effect.fn("desktop.lifecycle.relaunch")(function* (reason: string) {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  yield* logLifecycleInfo("desktop relaunch requested", { reason });
  yield* Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* Ref.set(state.quitting, true);
    yield* requestDesktopShutdownAndWaitWithFailsafe();
    if (environment.isDevelopment) {
      yield* electronApp.exit(75);
      return;
    }
    yield* electronApp.relaunch({
      execPath: process.execPath,
      args: process.argv.slice(1),
    });
    yield* electronApp.exit(0);
  }).pipe(
    Effect.catchCause((cause) =>
      logLifecycleError("desktop relaunch failed", {
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.forkDetach,
    Effect.asVoid,
  );
});

const register = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopLifecycleRuntimeServices>();
  const runEffect = Effect.runPromiseWith(context);
  let quitAllowed = false;
  let quitRequestPending = false;
  yield* electronTheme.onUpdated(() => {
    void runEffect(
      desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
    );
  });
  yield* electronApp.on("before-quit", (event: Electron.Event) => {
    handleBeforeQuit(
      event,
      runEffect,
      () => quitAllowed,
      () => {
        quitAllowed = true;
      },
      () => quitRequestPending,
      (pending) => {
        quitRequestPending = pending;
      },
    );
  });
  yield* electronApp.on("activate", () => {
    void runEffect(desktopWindow.activate.pipe(Effect.withSpan("desktop.lifecycle.activate")));
  });
  // Only ever fires in the process holding the single-instance lock: a
  // second launch hands its argv over and exits, and we surface the window
  // it was asking for. `activate` is backend-ready-aware, so a launch
  // during startup no-ops and the window arrives at readiness.
  yield* electronApp.on("second-instance", () => {
    void runEffect(
      desktopWindow.activate.pipe(Effect.withSpan("desktop.lifecycle.secondInstance")),
    );
  });
  yield* electronApp.on("window-all-closed", () => {
    void runEffect(
      Effect.gen(function* () {
        const app = yield* ElectronApp.ElectronApp;
        const state = yield* DesktopState.DesktopState;
        if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
          yield* app.quit;
        }
      }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
    );
  });

  if (environment.platform !== "win32") {
    const allowSignalQuit = () => {
      quitAllowed = true;
    };
    yield* addScopedListener(process, "SIGINT", () => {
      quitFromSignal("SIGINT", runEffect, allowSignalQuit);
    });
    yield* addScopedListener(process, "SIGTERM", () => {
      quitFromSignal("SIGTERM", runEffect, allowSignalQuit);
    });
  }
}).pipe(Effect.withSpan("desktop.lifecycle.register"));

export const layer = Layer.effect(
  DesktopLifecycle,
  Effect.gen(function* () {
    // Taken once here, so callers need none of these services. Only these:
    // the whole context would carry the layer's own Scope over the caller's,
    // and register's listeners must end with the caller's scope.
    const services = Context.pick(
      DesktopEnvironment.DesktopEnvironment,
      DesktopShutdown,
      DesktopState.DesktopState,
      DesktopWindow.DesktopWindow,
      ElectronApp.ElectronApp,
      ElectronDialog.ElectronDialog,
      ElectronTheme.ElectronTheme,
    )(yield* Effect.context<DesktopLifecycleRuntimeServices>());
    return DesktopLifecycle.of({
      relaunch: (reason) => relaunch(reason).pipe(Effect.provideContext(services)),
      register: register.pipe(Effect.provideContext(services)),
    });
  }),
);
