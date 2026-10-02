/**
 * The browser sessions behind the in-app preview.
 *
 * One persistent partition per project (see `previewPartitions.ts`), so a
 * sign-in to the app you are building happens once per project, every tab and
 * thread of that project shares it, and the agent driving a tab works inside
 * that same signed-in session rather than a blank one. Two projects never
 * share cookies or storage, even when their dev servers use the same port.
 *
 * Kept separate from the app's own session: preview content is untrusted, and
 * it has no business reading Threadlines' cookies. `getSession` refuses any
 * partition that is not a preview partition, so nothing reachable from here
 * can configure or clear the app's session.
 *
 * Each session is configured the first time it is asked for, synchronously, and
 * `will-attach-webview` asks before the guest is created. A guest therefore
 * never loads a page in a session without the user agent, permission handlers
 * and spellchecker below.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Electron from "electron";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { isPreviewPartition } from "./previewPartitions.ts";
import { isPreviewPermissionAllowed } from "./previewPermissions.ts";

export class PreviewSessionCreationError extends Schema.TaggedError<PreviewSessionCreationError>()(
  "PreviewSessionCreationError",
  { partition: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to create the preview browser session (partition ${this.partition}).`;
  }
}

export class PreviewPartitionRejectedError extends Schema.TaggedError<PreviewPartitionRejectedError>()(
  "PreviewPartitionRejectedError",
  { partition: Schema.String },
) {
  override get message(): string {
    return `Not a preview browser partition: ${this.partition}.`;
  }
}

export type PreviewSessionError = PreviewSessionCreationError | PreviewPartitionRejectedError;

export interface PreviewSessionShape {
  /**
   * The configured session for a preview partition. Synchronous, so it can run
   * inside `will-attach-webview`; configuration happens once per partition.
   */
  readonly getSession: (partition: string) => Effect.Effect<Electron.Session, PreviewSessionError>;
  /** Clears the HTTP cache only. The caller reloads whatever it is showing. */
  readonly clearCache: (partition: string) => Effect.Effect<void, PreviewSessionError>;
  /**
   * Signs out: clears cookies and site storage, then reloads every open tab in
   * the partition so none keeps showing a signed-in page from memory.
   */
  readonly clearBrowsingData: (partition: string) => Effect.Effect<void, PreviewSessionError>;
  /**
   * Clears everything the partition holds (all storage types, cache, HTTP
   * auth) and reloads its open tabs. For forgetting a profile and for clearing
   * all browser data.
   */
  readonly clearAllData: (partition: string) => Effect.Effect<void, PreviewSessionError>;
  /**
   * Preview partitions with data on disk, whether or not anything remembers
   * handing them out: what "clear all" must reach even when a record of one
   * was never written.
   */
  readonly storedPartitions: Effect.Effect<ReadonlyArray<string>>;
}

export class PreviewSession extends Context.Service<PreviewSession, PreviewSessionShape>()(
  "@threadlines/desktop/preview/PreviewSession",
) {}

function configurePreviewSession(previewSession: Electron.Session): void {
  // Present as an ordinary Chrome build. Sites that sniff for Electron serve
  // degraded or blocked experiences, which would make the preview disagree
  // with the browser the user checks against.
  previewSession.setUserAgent(
    previewSession
      .getUserAgent()
      .replace(/Electron\/[\d.]+ /, "")
      .replace(/\s*Threadlines\/[\d.]+/, ""),
  );
  previewSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPreviewPermissionAllowed(permission, details.requestingUrl));
  });
  // Async clipboard writes consult the *check* handler rather than the request
  // handler, so both have to agree or copy buttons fail.
  previewSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPreviewPermissionAllowed(permission, requestingOrigin),
  );
  // The partitioned session starts without any spellchecker configuration of
  // its own, so the note fields the annotate overlay injects never showed a
  // squiggle. The user's languages, narrowed to dictionaries that exist, with
  // US English as the fallback.
  previewSession.setSpellCheckerEnabled(true);
  const dictionaries = new Set(previewSession.availableSpellCheckerLanguages);
  const preferred = Electron.app
    .getPreferredSystemLanguages()
    .filter((language) => dictionaries.has(language));
  previewSession.setSpellCheckerLanguages(
    preferred.length > 0 ? preferred : dictionaries.has("en-US") ? ["en-US"] : [],
  );
}

/**
 * Guest pages running in this session.
 *
 * Compared by storage path as well as identity: every preview partition is
 * persistent, so the path names the partition even if Electron ever hands out
 * a second wrapper for the same session.
 */
function previewGuestsIn(previewSession: Electron.Session): Electron.WebContents[] {
  return Electron.webContents.getAllWebContents().filter((contents) => {
    if (contents.isDestroyed() || contents.getType() !== "webview") {
      return false;
    }
    const guestSession = contents.session;
    return (
      guestSession === previewSession ||
      (previewSession.storagePath !== null &&
        guestSession.storagePath === previewSession.storagePath)
    );
  });
}

export const make = Effect.sync(() => {
  const configured = new Map<string, Electron.Session>();

  const getSession = Effect.fn("PreviewSession.getSession")(function* (partition: string) {
    if (!isPreviewPartition(partition)) {
      return yield* new PreviewPartitionRejectedError({ partition });
    }
    const existing = configured.get(partition);
    if (existing !== undefined) {
      return existing;
    }
    return yield* Effect.try({
      try: () => {
        const previewSession = Electron.session.fromPartition(partition);
        configurePreviewSession(previewSession);
        configured.set(partition, previewSession);
        return previewSession;
      },
      catch: (cause) => new PreviewSessionCreationError({ partition, cause }),
    });
  });

  const run = (partition: string, action: () => Promise<void>) =>
    Effect.tryPromise({
      try: action,
      catch: (cause) => new PreviewSessionCreationError({ partition, cause }),
    });

  const reloadGuests = (previewSession: Electron.Session) =>
    Effect.sync(() => {
      for (const guest of previewGuestsIn(previewSession)) {
        guest.reload();
      }
    });

  return PreviewSession.of({
    getSession,
    clearCache: Effect.fn("PreviewSession.clearCache")(function* (partition: string) {
      // Cache only: a stale bundle is a different complaint from being signed
      // in, and clearing both when asked for one loses work.
      const previewSession = yield* getSession(partition);
      yield* run(partition, () => previewSession.clearCache());
    }),
    clearBrowsingData: Effect.fn("PreviewSession.clearBrowsingData")(function* (partition: string) {
      const previewSession = yield* getSession(partition);
      yield* run(partition, () =>
        previewSession.clearStorageData({
          storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
        }),
      );
      yield* reloadGuests(previewSession);
    }),
    storedPartitions: Effect.sync(() => {
      try {
        // Electron keeps a persistent partition's data in a directory named
        // after it, under the app's user data.
        const directory = join(Electron.app.getPath("userData"), "Partitions");
        return readdirSync(directory)
          .map((name) => `persist:${name}`)
          .filter((partition) => isPreviewPartition(partition));
      } catch {
        return [];
      }
    }),
    clearAllData: Effect.fn("PreviewSession.clearAllData")(function* (partition: string) {
      const previewSession = yield* getSession(partition);
      yield* run(partition, () => previewSession.clearStorageData());
      yield* run(partition, () => previewSession.clearCache());
      yield* run(partition, () => previewSession.clearAuthCache());
      yield* reloadGuests(previewSession);
    }),
  });
}).pipe(Effect.withSpan("PreviewSession.make"));

export const layer = Layer.effect(PreviewSession, make);
