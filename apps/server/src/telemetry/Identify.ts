import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";
import { ServerConfig } from "../config.ts";

class IdentifyUserError extends Schema.TaggedErrorClass<IdentifyUserError>()("IdentifyUserError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const hash = (value: string) =>
  Effect.try({
    try: () => Crypto.createHash("sha256").update(value).digest("hex"),
    catch: (error) =>
      new IdentifyUserError({
        message: "Failed to hash identifier",
        cause: error,
      }),
  });

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig;

  const anonymousId = yield* fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const randomId = yield* Random.nextUUIDv4;
        yield* fileSystem.writeFileString(anonymousIdPath, randomId);
        return randomId;
      }),
    ),
  );

  return anonymousId;
});

/**
 * getTelemetryIdentifier - Users are identified by a random Threadlines install
 * id stored in the server state directory, then hashed before it is sent.
 */
export const getTelemetryIdentifier = Effect.gen(function* () {
  const anonymousId = yield* Effect.result(upsertAnonymousId);
  if (anonymousId._tag === "Success") {
    return yield* hash(anonymousId.success);
  }

  return null;
}).pipe(
  Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
  Effect.orElseSucceed(() => null),
);
