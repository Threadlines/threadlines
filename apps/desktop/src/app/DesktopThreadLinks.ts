import {
  APP_THREAD_LINK_SCHEMES,
  type AppLinkChannel,
  type AppThreadLinkTarget,
  parseAppThreadLink,
} from "@threadlines/shared/appThreadLinks";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

/**
 * Links that open a thread in this app (`threadlines://open/<env>/<thread>`,
 * see @threadlines/shared/appThreadLinks). The hosted app offers one to a
 * browser that isn't paired, on the computer that runs Threadlines.
 *
 * macOS hands a link over as an `open-url` event, the first one before
 * `ready` when the link launched the app. Windows and Linux start the app
 * with the link as an argument: the first launch's own, or a second launch's,
 * which the single-instance lock passes to the running app. Either way the
 * window brings up the thread through the app shell's open-thread action.
 */

/** The release channel whose links this build opens. */
export function desktopThreadLinkChannel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): AppLinkChannel {
  if (input.isDevelopment) return "dev";
  return isNightlyDesktopVersion(input.appVersion) ? "nightly" : "latest";
}

/**
 * The thread a launch asks to open: the last of `candidates` that is a link
 * for this channel. macOS hands over the link alone; Windows and Linux pass it
 * among a launch's arguments, wherever Chromium put it.
 */
export function threadLinkFromCandidates(
  candidates: ReadonlyArray<string>,
  channel: AppLinkChannel,
): AppThreadLinkTarget | null {
  for (const candidate of candidates.toReversed()) {
    const target = parseAppThreadLink(candidate, channel);
    if (target !== null) return target;
  }
  return null;
}

export type ThreadLinkRegistration =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "register";
      readonly launch?: { readonly path: string; readonly args: ReadonlyArray<string> };
    };

/**
 * How this run claims its scheme. A packaged app is itself what the system
 * starts: macOS finds the scheme in its bundle, Linux in its desktop file,
 * Windows in the registry entry this writes.
 *
 * A development run takes no single-instance lock, so on Windows and Linux a
 * link would start a second app from the checkout, outside development mode,
 * instead of reaching this one. macOS hands links to the running app, and
 * the dev launcher's bundle declares the dev scheme, so development claims it
 * there only.
 *
 * An unpackaged release-mode run (`start`) is Electron plus an entry script,
 * which Windows can be told to start. Its macOS launcher bundle declares no
 * scheme and it has no desktop file on Linux, so there it would only take the
 * scheme from the installed app.
 */
export function threadLinkRegistration(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly execPath: string;
  readonly entryScriptPath: string | undefined;
}): ThreadLinkRegistration {
  if (input.isPackaged) {
    return { kind: "register" };
  }
  if (input.isDevelopment) {
    return input.platform === "darwin"
      ? { kind: "register" }
      : {
          kind: "skip",
          reason:
            "development runs take no single-instance lock, so a link could not reach this one",
        };
  }
  if (input.platform !== "win32" || input.entryScriptPath === undefined) {
    return { kind: "skip", reason: "an unpackaged run has nothing that declares the scheme" };
  }
  return {
    kind: "register",
    launch: { path: input.execPath, args: [input.entryScriptPath] },
  };
}

/** The most launches kept for later; a link supersedes the ones before it anyway. */
const THREAD_LINK_INBOX_LIMIT = 4;

/**
 * Holds what arrives before the app can open a thread: main.ts fills it from
 * the process's first lines (macOS's early `open-url`, the first launch's
 * arguments), and the service drains it once the window can open.
 */
export interface ThreadLinkInbox {
  /** A link the system handed over, or every argument of a launch. */
  readonly receive: (candidates: ReadonlyArray<string>) => void;
  /** Hands `open` what arrived so far, then each later arrival. */
  readonly connect: (open: (candidates: ReadonlyArray<string>) => void) => void;
}

export function makeThreadLinkInbox(): ThreadLinkInbox {
  let held: Array<ReadonlyArray<string>> = [];
  let open: ((candidates: ReadonlyArray<string>) => void) | null = null;
  return {
    receive: (candidates) => {
      if (open !== null) {
        open(candidates);
        return;
      }
      held = [...held, [...candidates]].slice(-THREAD_LINK_INBOX_LIMIT);
    },
    connect: (nextOpen) => {
      open = nextOpen;
      const arrived = held;
      held = [];
      for (const candidates of arrived) nextOpen(candidates);
    },
  };
}

export interface DesktopThreadLinksShape {
  /** A link the system handed over, or a launch's arguments: opened once `start` has run. */
  readonly receive: (candidates: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Claims this build's scheme, then opens what arrived so far and each later link. */
  readonly start: Effect.Effect<void>;
}

export class DesktopThreadLinks extends Context.Service<
  DesktopThreadLinks,
  DesktopThreadLinksShape
>()("threadlines/desktop/ThreadLinks") {}

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-thread-links");

export const layer = (input: {
  readonly inbox: ThreadLinkInbox;
  readonly execPath: string;
  readonly entryScriptPath: string | undefined;
}) =>
  Layer.effect(
    DesktopThreadLinks,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const electronApp = yield* ElectronApp.ElectronApp;
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const channel = desktopThreadLinkChannel(environment);
      const scheme = APP_THREAD_LINK_SCHEMES[channel];

      const open = (candidates: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const target = threadLinkFromCandidates(candidates, channel);
          if (target === null) {
            // Most launches carry no link at all; one in this scheme that
            // names no thread is worth a line.
            if (candidates.some((candidate) => candidate.toLowerCase().startsWith(`${scheme}:`))) {
              yield* logWarning("ignored a link that names no thread", { scheme });
            }
            return;
          }
          yield* logInfo("opening a thread link", {
            environmentId: target.environmentId,
            threadId: target.threadId,
          });
          yield* desktopWindow.dispatchMenuAction(DesktopWindow.OPEN_THREAD_MENU_ACTION, target);
        }).pipe(
          Effect.catchCause((cause) =>
            logWarning("could not open a thread link", { cause: Cause.pretty(cause) }),
          ),
          Effect.withSpan("desktop.threadLinks.open"),
        );

      const register = Effect.gen(function* () {
        const registration = threadLinkRegistration({
          platform: environment.platform,
          isPackaged: environment.isPackaged,
          isDevelopment: environment.isDevelopment,
          execPath: input.execPath,
          entryScriptPath: input.entryScriptPath,
        });
        if (registration.kind === "skip") {
          yield* logInfo("not claiming the link scheme", { scheme, reason: registration.reason });
          return;
        }
        const registered = yield* electronApp.setAsDefaultProtocolClient(
          scheme,
          registration.launch,
        );
        yield* registered
          ? logInfo("claimed the link scheme", { scheme })
          : logWarning("the system kept another app for the link scheme", { scheme });
      });

      return DesktopThreadLinks.of({
        receive: (candidates) => Effect.sync(() => input.inbox.receive(candidates)),
        start: Effect.gen(function* () {
          yield* register;
          // Run in the caller's context, so links log where the app logs.
          const runFork = Effect.runForkWith(yield* Effect.context<never>());
          yield* Effect.sync(() =>
            input.inbox.connect((candidates) => {
              runFork(open(candidates));
            }),
          );
        }).pipe(Effect.withSpan("desktop.threadLinks.start")),
      });
    }),
  );
