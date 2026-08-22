import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronSafeStorageAvailabilityError extends Data.TaggedError(
  "ElectronSafeStorageAvailabilityError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Data.TaggedError(
  "ElectronSafeStorageEncryptError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Data.TaggedError(
  "ElectronSafeStorageDecryptError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export interface ElectronSafeStorageShape {
  readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
  readonly encryptString: (
    value: string,
  ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
  readonly decryptString: (
    value: Uint8Array,
  ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
}

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  ElectronSafeStorageShape
>()("@threadlines/desktop/ElectronSafeStorage") {}

const make = ElectronSafeStorage.of({
  isEncryptionAvailable: Effect.try({
    try: () => Electron.safeStorage.isEncryptionAvailable(),
    catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
  }),
  encryptString: (value) =>
    Effect.try({
      try: () => Electron.safeStorage.encryptString(value),
      catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
    }),
  decryptString: (value) =>
    Effect.try({
      try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    }),
});

export const layer = Layer.succeed(ElectronSafeStorage, make);

/**
 * Marks plain-text payloads so they can never be mistaken for (or fed to) the
 * OS-encrypted format, and so real encrypted payloads fail cleanly here.
 */
const PLAIN_TEXT_PREFIX = "threadlines-dev-plaintext:";

const makePlainText = ElectronSafeStorage.of({
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) =>
    Effect.sync(() => new TextEncoder().encode(`${PLAIN_TEXT_PREFIX}${value}`)),
  decryptString: (value) =>
    Effect.suspend(() => {
      const decoded = new TextDecoder().decode(value);
      if (!decoded.startsWith(PLAIN_TEXT_PREFIX)) {
        return Effect.fail(
          new ElectronSafeStorageDecryptError({
            cause: new Error("Payload is not in the dev plain-text format."),
          }),
        );
      }
      return Effect.succeed(decoded.slice(PLAIN_TEXT_PREFIX.length));
    }),
});

/**
 * Dev-only substitute that skips the OS keychain. Development runs use the
 * ad-hoc-signed Electron binary from node_modules, which macOS cannot pin in
 * keychain ACLs, so every launch re-prompts for the login keychain password.
 * Dev secrets are confined to the isolated dev state directory, where plain
 * text is acceptable.
 */
export const layerPlainText = Layer.succeed(ElectronSafeStorage, makePlainText);
