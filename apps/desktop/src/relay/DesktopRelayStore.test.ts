import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopRelayStore from "./DesktopRelayStore.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const pairingSession: DesktopRelayStore.PersistedRelayPairingSession = {
  sessionId: "session-1",
  pairingUrl: "https://app.threadlines.dev/pair?relay=https://relay.example.com&session=session-1",
  relayOrigin: "https://relay.example.com",
  desktopSocketUrl: "wss://relay.example.com/v1/sessions/session-1/connect?role=desktop",
  expiresAt: "2099-01-01T00:00:00.000Z",
  desktopToken: "desktop-token-1",
};

function makeSafeStorageLayer(input: { readonly available: boolean }) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(input.available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`enc:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid secret"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
  } satisfies ElectronSafeStorage.ElectronSafeStorageShape);
}

function makeLayer(baseDir: string, options?: { readonly availableSecretStorage?: boolean }) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  return DesktopRelayStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(
      makeSafeStorageLayer({ available: options?.availableSecretStorage ?? true }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withRelayStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopRelayStore.DesktopRelayStore>,
  options?: { readonly availableSecretStorage?: boolean },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-relay-store-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, options)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** Writes what an older desktop left on disk: a phone-link session with its encrypted token. */
const writeLeftoverPhoneLink = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
  yield* fileSystem.writeFileString(
    environment.relayPairingSessionPath,
    JSON.stringify({
      version: 1,
      session: {
        sessionId: pairingSession.sessionId,
        pairingUrl: pairingSession.pairingUrl,
        relayOrigin: pairingSession.relayOrigin,
        desktopSocketUrl: pairingSession.desktopSocketUrl,
        expiresAt: pairingSession.expiresAt,
        encryptedDesktopToken: Encoding.encodeBase64(
          textEncoder.encode(`enc:${pairingSession.desktopToken}`),
        ),
      },
    }),
  );
});

describe("DesktopRelayStore", () => {
  it.effect("reads back an old phone link with its decrypted desktop token", () =>
    withRelayStore(
      Effect.gen(function* () {
        yield* writeLeftoverPhoneLink;
        const store = yield* DesktopRelayStore.DesktopRelayStore;
        assert.deepEqual(yield* store.load, Option.some(pairingSession));
        assert.isFalse(yield* store.notice);
      }),
    ),
  );

  it.effect("forgets a retired link and shows the notice until dismissed", () =>
    withRelayStore(
      Effect.gen(function* () {
        yield* writeLeftoverPhoneLink;
        const store = yield* DesktopRelayStore.DesktopRelayStore;
        yield* store.markRetired("2026-10-03T00:00:00.000Z");
        assert.deepEqual(yield* store.load, Option.none());
        assert.isTrue(yield* store.notice);
        yield* store.dismissNotice;
        assert.isFalse(yield* store.notice);
      }),
    ),
  );

  it.effect("loads nothing when no link was ever saved", () =>
    withRelayStore(
      Effect.gen(function* () {
        const store = yield* DesktopRelayStore.DesktopRelayStore;
        assert.deepEqual(yield* store.load, Option.none());
        assert.isFalse(yield* store.notice);
      }),
    ),
  );

  it.effect("loads nothing when safe storage can't decrypt the token", () =>
    withRelayStore(
      Effect.gen(function* () {
        yield* writeLeftoverPhoneLink;
        const store = yield* DesktopRelayStore.DesktopRelayStore;
        assert.deepEqual(yield* store.load, Option.none());
      }),
      { availableSecretStorage: false },
    ),
  );

  it.effect("loads nothing when the persisted document is corrupt", () =>
    withRelayStore(
      Effect.gen(function* () {
        const store = yield* DesktopRelayStore.DesktopRelayStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.relayPairingSessionPath, "{not-json");
        assert.deepEqual(yield* store.load, Option.none());
      }),
    ),
  );
});
