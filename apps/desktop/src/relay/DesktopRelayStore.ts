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
 * Persisted phone-link pairing session, with the relay desktop token held in
 * plain text only in memory; on disk it is encrypted with Electron's safe
 * storage. Persisting the session lets a desktop restart re-attach to the
 * same relay session, so paired phones reconnect without re-scanning a QR.
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
});

const RelayPairingSessionDocumentJson = fromLenientJson(RelayPairingSessionDocumentSchema);
const decodeRelayPairingSessionDocumentJson = Schema.decodeEffect(RelayPairingSessionDocumentJson);
const encodeRelayPairingSessionDocumentJson = Schema.encodeEffect(RelayPairingSessionDocumentJson);

export interface DesktopRelayStoreShape {
  /** Returns none when nothing is persisted or the payload cannot be read. */
  readonly load: Effect.Effect<Option.Option<PersistedRelayPairingSession>>;
  /** Returns false when safe storage is unavailable and nothing was saved. */
  readonly save: (session: PersistedRelayPairingSession) => Effect.Effect<boolean>;
  readonly clear: Effect.Effect<void>;
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

    return DesktopRelayStore.of({
      load: Effect.gen(function* () {
        const raw = yield* fileSystem.readFileString(sessionPath).pipe(Effect.option);
        if (Option.isNone(raw)) {
          return Option.none<PersistedRelayPairingSession>();
        }

        const document = yield* decodeRelayPairingSessionDocumentJson(raw.value).pipe(
          Effect.option,
        );
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

      save: (session) =>
        Effect.gen(function* () {
          if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)))) {
            return false;
          }
          const encryptedDesktopToken = Encoding.encodeBase64(
            yield* safeStorage.encryptString(session.desktopToken),
          );
          yield* writeDocument({
            version: 1,
            session: {
              sessionId: session.sessionId,
              pairingUrl: session.pairingUrl,
              relayOrigin: session.relayOrigin,
              desktopSocketUrl: session.desktopSocketUrl,
              expiresAt: session.expiresAt,
              encryptedDesktopToken,
            },
          });
          return true;
        }).pipe(
          Effect.orElseSucceed(() => false),
          Effect.withSpan("desktop.relayStore.save"),
        ),

      clear: fileSystem
        .remove(sessionPath)
        .pipe(Effect.ignore, Effect.withSpan("desktop.relayStore.clear")),
    });
  }),
);

export const layerTest = (input?: { readonly session?: PersistedRelayPairingSession }) =>
  Layer.effect(
    DesktopRelayStore,
    Effect.gen(function* () {
      const sessionRef = yield* Ref.make(Option.fromNullishOr(input?.session));
      return DesktopRelayStore.of({
        load: Ref.get(sessionRef),
        save: (session) => Ref.set(sessionRef, Option.some(session)).pipe(Effect.as(true)),
        clear: Ref.set(sessionRef, Option.none()),
      });
    }),
  );
