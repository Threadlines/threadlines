/**
 * The browser session behind the in-app preview.
 *
 * One persistent partition, shared by every preview tab, so signing in to the
 * app you are building is something you do once rather than once per thread —
 * and so the agent driving a tab operates inside that same signed-in session
 * rather than a blank one it cannot authenticate.
 *
 * Kept separate from the app's own session: preview content is untrusted, and
 * it has no business reading Threadlines' cookies.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import { session, type Session } from "electron";
import { PREVIEW_PARTITION } from "@threadlines/shared/preview";

export { PREVIEW_PARTITION };

/**
 * Permissions preview content may use. Deliberately short: a page under
 * development has no reason to reach the microphone or camera, and the
 * default-deny keeps a mistyped URL from prompting for hardware.
 *
 * `clipboard-sanitized-write` (not `clipboard-write`, which Electron does not
 * recognise) is what `navigator.clipboard.writeText()` checks, so framework
 * error overlays with a "copy" button keep working.
 */
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
]);

export class PreviewSessionCreationError extends Schema.TaggedErrorClass<PreviewSessionCreationError>()(
  "PreviewSessionCreationError",
  { partition: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to create the preview browser session (partition ${this.partition}).`;
  }
}

export class PreviewSession extends Context.Service<
  PreviewSession,
  {
    readonly partition: string;
    readonly getSession: () => Effect.Effect<Session, PreviewSessionCreationError>;
    readonly clearBrowsingData: () => Effect.Effect<void, PreviewSessionCreationError>;
  }
>()("@threadlines/desktop/preview/PreviewSession") {}

export const make = Effect.gen(function* PreviewSessionMake() {
  let cached: Session | null = null;

  const getSession = Effect.fn("PreviewSession.getSession")(function* () {
    if (cached !== null) {
      return cached;
    }
    return yield* Effect.try({
      try: () => {
        const previewSession = session.fromPartition(PREVIEW_PARTITION);
        // Present as an ordinary Chrome build. Sites that sniff for Electron
        // serve degraded or blocked experiences, which would make the preview
        // disagree with the browser the user checks against.
        previewSession.setUserAgent(
          previewSession
            .getUserAgent()
            .replace(/Electron\/[\d.]+ /, "")
            .replace(/\s*Threadlines\/[\d.]+/, ""),
        );
        previewSession.setPermissionRequestHandler((_contents, permission, callback) => {
          callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission));
        });
        // Async clipboard writes consult the *check* handler rather than the
        // request handler, so both have to agree or copy buttons fail.
        previewSession.setPermissionCheckHandler((_contents, permission) =>
          ALLOWED_PREVIEW_PERMISSIONS.has(permission),
        );
        cached = previewSession;
        return previewSession;
      },
      catch: (cause) => new PreviewSessionCreationError({ partition: PREVIEW_PARTITION, cause }),
    });
  });

  return PreviewSession.of({
    partition: PREVIEW_PARTITION,
    getSession,
    clearBrowsingData: Effect.fn("PreviewSession.clearBrowsingData")(function* () {
      const previewSession = yield* getSession();
      yield* Effect.tryPromise({
        try: () =>
          previewSession.clearStorageData({
            storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
          }),
        catch: (cause) => new PreviewSessionCreationError({ partition: PREVIEW_PARTITION, cause }),
      });
    }),
  });
}).pipe(Effect.withSpan("PreviewSession.make"));

export const layer = Layer.effect(PreviewSession, make);
