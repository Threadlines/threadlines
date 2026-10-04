import { fromLenientJson } from "@threadlines/shared/schemaJson";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

/**
 * What older desktops left behind when they had a phone link: the relay
 * session and its desktop token (encrypted on disk with Electron's safe
 * storage). Current desktops never create these; they only read one back so
 * {@link DesktopRelayRetirement} can end it at the relay, then record that it
 * happened so Connections can say so once.
 */
export interface PersistedRelayPairingSession {
  readonly sessionId: string;
  readonly pairingUrl: string;
  readonly relayOrigin: string;
  readonly desktopSocketUrl: string;
  readonly expiresAt: string;
  readonly desktopToken: string;
}

const StoredRelayPairingSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  pairingUrl: Schema.String,
  relayOrigin: Schema.String,
  desktopSocketUrl: Schema.String,
  expiresAt: Schema.String,
  encryptedDesktopToken: Schema.String,
});

const RelayPairingSessionDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  session: Schema.optionalKey(StoredRelayPairingSessionSchema),
  /** Set once the old link was ended; the notice shows until dismissed. */
  retiredAt: Schema.optionalKey(Schema.String),
  noticeDismissed: Schema.optionalKey(Schema.Boolean),
});

const RelayPairingSessionDocumentJson = fromLenientJson(RelayPairingSessionDocumentSchema);
const decodeRelayPairingSessionDocumentJson = Schema.decodeEffect(RelayPairingSessionDocumentJson);
const encodeRelayPairingSessionDocumentJson = Schema.encodeEffect(RelayPairingSessionDocumentJson);

export interface DesktopRelayStoreShape {
  /** The leftover old phone link, if any. None when absent, unreadable, or already retired. */
  readonly load: Effect.Effect<Option.Option<PersistedRelayPairingSession>>;
  /** Forgets the old link and remembers to tell the user once. */
  readonly markRetired: (retiredAt: string) => Effect.Effect<void>;
  /** True after a retirement until the user dismisses the notice. */
  readonly notice: Effect.Effect<boolean>;
  readonly dismissNotice: Effect.Effect<void>;
}

export class DesktopRelayStore extends Context.Service<DesktopRelayStore, DesktopRelayStoreShape>()(
  "t3/desktop/RelayStore",
) {}

export const layer = Layer.effect(
  DesktopRelayStore,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const sessionPath = environment.relayPairingSessionPath;

    const writeDocument = (document: typeof RelayPairingSessionDocumentSchema.Type) =>
      Effect.gen(function* () {
        const suffix = (yield* randomUUIDv4).replace(/-/g, "");
        const tempPath = `${sessionPath}.${process.pid}.${suffix}.tmp`;
        const encoded = yield* encodeRelayPairingSessionDocumentJson(document);
        yield* fileSystem.makeDirectory(path.dirname(sessionPath), { recursive: true });
        yield* fileSystem.writeFileString(tempPath, `${encoded}\n`);
        yield* fileSystem.rename(tempPath, sessionPath);
      });

    const readDocument = Effect.gen(function* () {
      const raw = yield* fileSystem.readFileString(sessionPath).pipe(Effect.option);
      if (Option.isNone(raw)) {
        return Option.none<typeof RelayPairingSessionDocumentSchema.Type>();
      }
      return yield* decodeRelayPairingSessionDocumentJson(raw.value).pipe(Effect.option);
    });

    return DesktopRelayStore.of({
      load: Effect.gen(function* () {
        const document = yield* readDocument;
        const stored = Option.isSome(document) ? document.value.session : undefined;
        if (!stored) {
          return Option.none<PersistedRelayPairingSession>();
        }

        if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)))) {
          return Option.none<PersistedRelayPairingSession>();
        }
        const tokenBytes = yield* Effect.fromResult(
          Encoding.decodeBase64(stored.encryptedDesktopToken),
        ).pipe(Effect.option);
        if (Option.isNone(tokenBytes)) {
          return Option.none<PersistedRelayPairingSession>();
        }
        const desktopToken = yield* safeStorage.decryptString(tokenBytes.value).pipe(Effect.option);
        if (Option.isNone(desktopToken)) {
          return Option.none<PersistedRelayPairingSession>();
        }

        return Option.some<PersistedRelayPairingSession>({
          sessionId: stored.sessionId,
          pairingUrl: stored.pairingUrl,
          relayOrigin: stored.relayOrigin,
          desktopSocketUrl: stored.desktopSocketUrl,
          expiresAt: stored.expiresAt,
          desktopToken: desktopToken.value,
        });
      }).pipe(Effect.withSpan("desktop.relayStore.load")),

      markRetired: (retiredAt) =>
        writeDocument({ version: 2, retiredAt, noticeDismissed: false }).pipe(
          Effect.ignore,
          Effect.withSpan("desktop.relayStore.markRetired"),
        ),

      notice: readDocument.pipe(
        Effect.map((document) =>
          Option.isSome(document)
            ? document.value.retiredAt !== undefined && document.value.noticeDismissed !== true
            : false,
        ),
      ),

      dismissNotice: Effect.gen(function* () {
        const document = yield* readDocument;
        if (Option.isNone(document) || document.value.retiredAt === undefined) {
          return;
        }
        yield* writeDocument({ ...document.value, noticeDismissed: true });
      }).pipe(Effect.ignore, Effect.withSpan("desktop.relayStore.dismissNotice")),
    });
  }),
);

export const layerTest = (input?: {
  readonly session?: PersistedRelayPairingSession;
  readonly retired?: boolean;
}) =>
  Layer.effect(
    DesktopRelayStore,
    Effect.gen(function* () {
      const sessionRef = yield* Ref.make(Option.fromNullishOr(input?.session));
      const noticeRef = yield* Ref.make(input?.retired ?? false);
      return DesktopRelayStore.of({
        load: Ref.get(sessionRef),
        markRetired: () =>
          Ref.set(sessionRef, Option.none()).pipe(Effect.andThen(Ref.set(noticeRef, true))),
        notice: Ref.get(noticeRef),
        dismissNotice: Ref.set(noticeRef, false),
      });
    }),
  );
