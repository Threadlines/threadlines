/**
 * The `threadlines` command's sign-ins on this computer
 * (docs/design/outside-agents.md, "The token"): `cli/connections.json` in the
 * data folder, readable only by the user (folder 0700, file 0600), one entry
 * per resource.
 *
 * An entry keeps the command's registration (`clientId`) apart from its
 * token. Every `connect` signs in again with the same registration, which
 * Threadlines treats as the same agent: the new approval replaces the old
 * connection instead of adding one. Disconnecting or a 401 forgets only the
 * token. The token is never printed.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export const ConnectCredential = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.optional(Schema.String),
  /** What the user allowed at sign-in: `threads:read`, maybe with `threads:start`. */
  scope: Schema.optional(Schema.String),
});
export type ConnectCredential = typeof ConnectCredential.Type;

const ConnectCredentialsFile = Schema.Struct({
  version: Schema.Literal(1),
  resources: Schema.Record(Schema.String, ConnectCredential),
});
type ConnectCredentialsFile = typeof ConnectCredentialsFile.Type;

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectCredentialsFile));

const EMPTY: ConnectCredentialsFile = { version: 1, resources: {} };

/** Everything stored; empty when the file is missing or unreadable. */
const readFile = Effect.fn("cli.connect.readCredentials")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return EMPTY;
  return yield* decodeFile(raw).pipe(Effect.orElseSucceed(() => EMPTY));
});

export const readConnectCredential = Effect.fn("cli.connect.readCredential")(function* (
  filePath: string,
  resource: string,
) {
  const file = yield* readFile(filePath);
  return file.resources[resource] ?? null;
});

/**
 * Sets (or with null, deletes) one resource's entry. The folder is made, or
 * tightened, to 0700 first, so the token never sits in a folder others can
 * list.
 */
export const writeConnectCredential = Effect.fn("cli.connect.writeCredential")(function* (
  filePath: string,
  resource: string,
  credential: ConnectCredential | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.dirname(filePath);
  yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
  yield* fs.chmod(folder, 0o700);
  const file = yield* readFile(filePath);
  const { [resource]: _previous, ...others } = file.resources;
  const resources = credential === null ? others : { ...others, [resource]: credential };
  yield* writeFileStringAtomically({
    filePath,
    contents: `${JSON.stringify({ version: 1, resources } satisfies ConnectCredentialsFile, null, 2)}\n`,
    mode: 0o600,
  });
});

/** Forgets the token and keeps the registration, so the next sign-in is the same agent. */
export const forgetConnectToken = Effect.fn("cli.connect.forgetToken")(function* (
  filePath: string,
  resource: string,
) {
  const existing = yield* readConnectCredential(filePath, resource);
  if (existing === null || existing.accessToken === undefined) return false;
  yield* writeConnectCredential(filePath, resource, { clientId: existing.clientId });
  return true;
});

/** `disconnect`: forgets every token kept here, whichever port it was for; true when there was one. */
export const forgetAllConnectTokens = Effect.fn("cli.connect.forgetAllTokens")(function* (
  filePath: string,
) {
  const file = yield* readFile(filePath);
  const signedIn = Object.entries(file.resources).filter(
    ([, credential]) => credential.accessToken !== undefined,
  );
  for (const [resource, credential] of signedIn) {
    yield* writeConnectCredential(filePath, resource, { clientId: credential.clientId });
  }
  return signedIn.length > 0;
});
