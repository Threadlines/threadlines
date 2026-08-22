import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

describe("layerPlainText", () => {
  it.effect("round-trips a secret without touching the OS keychain", () =>
    Effect.gen(function* () {
      const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
      const encrypted = yield* safeStorage.encryptString("relay-token-123");
      expect(yield* safeStorage.decryptString(encrypted)).toBe("relay-token-123");
    }).pipe(Effect.provide(ElectronSafeStorage.layerPlainText)),
  );

  it.effect("rejects payloads that are not in the dev plain-text format", () =>
    Effect.gen(function* () {
      const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
      const exit = yield* safeStorage
        .decryptString(new TextEncoder().encode("v10 keychain-encrypted-bytes"))
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(ElectronSafeStorage.layerPlainText)),
  );
});
