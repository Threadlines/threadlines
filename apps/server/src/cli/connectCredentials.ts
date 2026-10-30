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
 * token. The token is never printed. Every change is made under a lock, so
 * commands running at once never undo each other's.
 *
 * A key for another computer's Threadlines, reached through the assistants
 * door (`connect --url <address> --key <key>`, docs/design/assistants.md),
 * is kept the same way under that address, with no registration: forgetting
 * it forgets the entry.
 */
import { randomBytes } from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export const ConnectCredential = Schema.Struct({
  /** The command's registration; absent for a key, which has none. */
  clientId: Schema.optional(Schema.String),
  accessToken: Schema.optional(Schema.String),
  /** What the user allowed at sign-in: `threads:read`, maybe with `threads:start`. */
  scope: Schema.optional(Schema.String),
  /**
   * The MCP session the last command opened with this token. The next
   * command picks it up instead of opening another, since the server keeps
   * every session it opened until it restarts.
   */
  sessionId: Schema.optional(Schema.String),
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

/** A lock left by a process that died in the milliseconds it holds one. */
const STALE_LOCK_MS = 5_000;

const isAlreadyExists = (error: PlatformError.PlatformError) =>
  error.reason._tag === "AlreadyExists";

/**
 * Runs `effect` with the file to itself. Two commands changing it at once
 * (a `connect` finishing while an older command forgets its refused token)
 * would each write back what they read and lose the other's change. The lock
 * is a file created exclusively beside it, holding a token so only its owner
 * removes it; one older than STALE_LOCK_MS is broken.
 */
const withFileLock = <A, E, R>(filePath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockPath = `${filePath}.lock`;
    const token = randomBytes(8).toString("hex");
    const acquire = Effect.gen(function* () {
      while (true) {
        const created = yield* fs
          .writeFileString(lockPath, token, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.as(true),
            Effect.catchIf(isAlreadyExists, () => Effect.succeed(false)),
          );
        if (created) return;
        const info = yield* fs.stat(lockPath).pipe(Effect.option);
        const now = yield* Clock.currentTimeMillis;
        const madeAt = Option.flatMap(info, (stat) => stat.mtime);
        if (Option.isSome(madeAt) && now - madeAt.value.getTime() > STALE_LOCK_MS) {
          yield* fs.remove(lockPath, { force: true }).pipe(Effect.ignore);
        } else {
          yield* Effect.sleep("20 millis");
        }
      }
    });
    const release = fs.readFileString(lockPath).pipe(
      Effect.flatMap((held) =>
        held === token ? fs.remove(lockPath, { force: true }) : Effect.void,
      ),
      Effect.ignore,
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      () => effect,
      () => release,
    );
  });

/**
 * Changes the stored entries under the lock: `change` gets what is stored
 * now and returns what to store. The folder is made, or tightened, to 0700
 * first, so a token never sits in a folder others can list.
 */
const updateCredentials = Effect.fn("cli.connect.updateCredentials")(function* (
  filePath: string,
  change: (resources: ConnectCredentialsFile["resources"]) => ConnectCredentialsFile["resources"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.dirname(filePath);
  yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
  yield* fs.chmod(folder, 0o700);
  yield* withFileLock(
    filePath,
    Effect.gen(function* () {
      const current = (yield* readFile(filePath)).resources;
      const resources = change(current);
      if (resources === current) return;
      yield* writeFileStringAtomically({
        filePath,
        contents: `${JSON.stringify({ version: 1, resources } satisfies ConnectCredentialsFile, null, 2)}\n`,
        mode: 0o600,
      });
    }),
  );
});

/** Stores one resource's sign-in. */
export const writeConnectCredential = (
  filePath: string,
  resource: string,
  credential: ConnectCredential,
) => updateCredentials(filePath, (resources) => ({ ...resources, [resource]: credential }));

/** Stores a key for a Threadlines reached through the assistants door, at its address. */
export const writeConnectKey = (filePath: string, resource: string, key: string) =>
  updateCredentials(filePath, (resources) => ({ ...resources, [resource]: { accessToken: key } }));

/** What is left of an entry once its token is forgotten: its registration, or nothing for a key. */
const withoutToken = (
  resources: ConnectCredentialsFile["resources"],
  resource: string,
  credential: ConnectCredential,
): ConnectCredentialsFile["resources"] => {
  const { [resource]: _forgotten, ...others } = resources;
  return credential.clientId === undefined
    ? others
    : { ...others, [resource]: { clientId: credential.clientId } };
};

/** Keeps a new registration for `resource`, unless one is already kept there. */
export const keepConnectRegistration = (filePath: string, resource: string, clientId: string) =>
  updateCredentials(filePath, (resources) =>
    resources[resource] === undefined ? { ...resources, [resource]: { clientId } } : resources,
  );

/** Keeps the MCP session a command opened, for the next command with the same token. */
export const rememberConnectSession = (
  filePath: string,
  resource: string,
  token: string,
  sessionId: string,
) =>
  updateCredentials(filePath, (resources) => {
    const existing = resources[resource];
    if (existing?.accessToken !== token || existing.sessionId === sessionId) return resources;
    return { ...resources, [resource]: { ...existing, sessionId } };
  });

/**
 * After a 401: forgets `token`, keeping the registration so the next
 * sign-in is the same agent. Only that token: a newer one a later `connect`
 * stored stays.
 */
export const forgetConnectToken = (filePath: string, resource: string, token: string) =>
  updateCredentials(filePath, (resources) => {
    const existing = resources[resource];
    if (existing?.accessToken !== token) return resources;
    return withoutToken(resources, resource, existing);
  });

/** `disconnect`: forgets every token kept here, whichever port it was for; true when there was one. */
export const forgetAllConnectTokens = Effect.fn("cli.connect.forgetAllTokens")(function* (
  filePath: string,
) {
  let forgot = false;
  yield* updateCredentials(filePath, (resources) => {
    const signedIn = Object.values(resources).some(
      (credential) => credential.accessToken !== undefined,
    );
    if (!signedIn) return resources;
    forgot = true;
    let kept: ConnectCredentialsFile["resources"] = resources;
    for (const [resource, credential] of Object.entries(resources)) {
      if (credential.accessToken !== undefined) kept = withoutToken(kept, resource, credential);
    }
    return kept;
  });
  return forgot;
});
