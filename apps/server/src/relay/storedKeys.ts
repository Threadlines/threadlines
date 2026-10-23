import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { generateStoredKeyPair, utf8 } from "@threadlines/shared/relaySecure";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";

const StoredKeyPairJson = Schema.fromJsonString(
  Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String }),
);
const decodeStoredKeyPair = Schema.decodeUnknownOption(StoredKeyPairJson);
const encodeStoredKeyPair = Schema.encodeSync(StoredKeyPairJson);

/**
 * A P-256 key pair this server keeps in its secret store under `name`, made
 * the first time it's asked for: the end-to-end key (`relay-host-e2e-key`)
 * and the event task hook key (`relay-hook-key`). Callers serialize their
 * own calls, so two can't both make one.
 */
export const loadOrCreateStoredKeyPair = (secrets: ServerSecretStoreShape, name: string) =>
  Effect.gen(function* () {
    const existing = yield* secrets.get(name);
    const stored = existing
      ? Option.getOrNull(decodeStoredKeyPair(new TextDecoder().decode(existing)))
      : null;
    if (stored) return stored;
    const made = yield* Effect.promise(() => generateStoredKeyPair());
    yield* secrets.set(name, utf8(encodeStoredKeyPair(made)));
    return made;
  });
