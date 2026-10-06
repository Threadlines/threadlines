// @effect-diagnostics nodeBuiltinImport:off - one JSON file, replaced atomically
/**
 * AcpRegistryTrust — `trust.json` in an agent's folder: the recipes the user
 * confirmed, and what the first install of each one turned out to be. A
 * later install of the same recipe must turn out the same.
 *
 * It outlives the versions it describes. Version folders come and go with
 * updates, repairs and pruning; this file is deleted only when the agent is
 * removed. A recipe it doesn't list was never confirmed, whatever is on
 * disk: missing data never makes an install a "first install" again.
 *
 * Callers write it only while they hold the agent's install lock.
 *
 * @module provider/acpRegistry/AcpRegistryTrust
 */
import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MANAGED_RELEASE_ID_PATTERN } from "../managedRuntime/ManagedRuntimeStore.ts";
import { AcpRegistryRecipe, acpRegistryRecipeDigest } from "./AcpRegistryRecipe.ts";

const TRUST_FILE = "trust.json";
const TEMP_INFIX = ".tmp-";
const IN_USE_ATTEMPTS = 10;
const IN_USE_RETRY_MS = 100;
/** A write takes milliseconds; a temp file this old was abandoned. */
const LEFTOVER_AGE_MS = 60_000;

/**
 * `trust.json` is there but isn't this agent's trust record, whole and
 * valid. Nothing is read from such a file and nothing is written over it:
 * what it recorded can't be told, so it can't be carried forward.
 */
export class AcpRegistryTrustDamagedError extends Error {
  override readonly name = "AcpRegistryTrustDamagedError";
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/**
 * A Node.js release as `ManagedNode` pins one, with the id of its installed
 * copy. Everything needed to lease that copy, or to download it again after
 * Threadlines has moved on to a newer release.
 */
export const AcpRegistryNodeRelease = Schema.Struct({
  /** Without the leading `v`. */
  version: Schema.String,
  /** Sixteen hex digits: names the installed copy in the Node store. */
  releaseId: Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN)),
  assetKey: Schema.Literals([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]),
  asset: Schema.Struct({
    url: Schema.String,
    sha256: Schema.String,
    archiveBytes: Schema.Int,
    unpackedBytes: Schema.Int,
    kind: Schema.Literals(["tar.gz", "zip"]),
  }),
});
export type AcpRegistryNodeRelease = typeof AcpRegistryNodeRelease.Type;

const TrustedRecipe = Schema.Struct({
  recipeDigest: Sha256,
  recipe: AcpRegistryRecipe,
  /** ISO time of the confirm that made this the newest recipe. */
  confirmedAt: Schema.String,
  /** Downloads: sha256 of the archive the first install unpacked. Null until one has. */
  archiveSha256: Schema.NullOr(Sha256),
  /**
   * npm: the `package.json` and `package-lock.json` the first install wrote,
   * byte for byte, and the Node.js it ran with. Null until one has.
   */
  npm: Schema.NullOr(
    Schema.Struct({
      packageJson: Schema.String,
      packageLock: Schema.String,
      node: AcpRegistryNodeRelease,
    }),
  ),
});
export type AcpRegistryTrustedRecipe = typeof TrustedRecipe.Type;

const TrustFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  agentId: Schema.String,
  /** In the order they were confirmed, newest last. */
  recipes: Schema.Array(TrustedRecipe),
});
const TrustFileJson = Schema.fromJsonString(TrustFile);
const decodeTrustFile = Schema.decodeUnknownOption(TrustFileJson);
const encodeTrustFile = Schema.encodeSync(TrustFileJson);

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

/** Windows: a reader, a writer or a virus scanner has the file open for a moment. */
const isBrieflyInUse = (cause: unknown) => {
  const code = errnoCode(cause);
  return (
    process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")
  );
};

/**
 * Deletes what a `writeTrust` left when it was cut off. Call it holding the
 * install lock. Only old files: one that is being written is left alone
 * whoever holds the lock.
 */
export async function deleteTrustLeftovers(root: string): Promise<void> {
  const names = await NodeFS.readdir(root).catch(() => [] as Array<string>);
  for (const name of names) {
    if (!name.startsWith(`${TRUST_FILE}${TEMP_INFIX}`)) continue;
    const path = NodePath.join(root, name);
    const stats = await NodeFS.stat(path).catch(() => undefined);
    if (stats && Date.now() - stats.mtimeMs > LEFTOVER_AGE_MS) {
      await NodeFS.rm(path, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * The recipes confirmed for `agentId`, newest last. None when there is no
 * file. Throws when the file is there but can't be read, and
 * `AcpRegistryTrustDamagedError` when it isn't this agent's record or any
 * entry of it is invalid: a caller about to rewrite the file never takes
 * either for empty, so one bad entry can't cost the others.
 */
export async function readTrust(
  root: string,
  agentId: string,
): Promise<ReadonlyArray<AcpRegistryTrustedRecipe>> {
  let raw: string;
  for (let attempt = 1; ; attempt += 1) {
    try {
      raw = await NodeFS.readFile(NodePath.join(root, TRUST_FILE), "utf8");
      break;
    } catch (cause) {
      const code = errnoCode(cause);
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      if (!isBrieflyInUse(cause) || attempt >= IN_USE_ATTEMPTS) throw cause;
      await new Promise((resolve) => setTimeout(resolve, IN_USE_RETRY_MS));
    }
  }
  const file = Option.getOrUndefined(decodeTrustFile(raw));
  const valid =
    file !== undefined &&
    file.agentId === agentId &&
    file.recipes.every(
      (entry) =>
        entry.recipe.agentId === agentId &&
        acpRegistryRecipeDigest(entry.recipe) === entry.recipeDigest,
    );
  if (!valid) throw new AcpRegistryTrustDamagedError(`${TRUST_FILE} is not a valid trust record`);
  return file.recipes;
}

/** Replaces the record: written beside it and flushed, then renamed over it. */
export async function writeTrust(
  root: string,
  agentId: string,
  recipes: ReadonlyArray<AcpRegistryTrustedRecipe>,
): Promise<void> {
  const target = NodePath.join(root, TRUST_FILE);
  const temp = `${target}${TEMP_INFIX}${randomBytes(4).toString("hex")}`;
  try {
    const file = await NodeFS.open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${encodeTrustFile({ schemaVersion: 1, agentId, recipes })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await NodeFS.rename(temp, target);
        break;
      } catch (cause) {
        if (!isBrieflyInUse(cause) || attempt >= IN_USE_ATTEMPTS) throw cause;
        await new Promise((resolve) => setTimeout(resolve, IN_USE_RETRY_MS));
      }
    }
  } catch (cause) {
    await NodeFS.rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
}
