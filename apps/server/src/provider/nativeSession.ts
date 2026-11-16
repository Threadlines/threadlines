// @effect-diagnostics nodeBuiltinImport:off
/**
 * Carrying an agent's own session to another computer with a moved thread
 * (docs/design/fleet.md, Part 3d). A driver whose sessions are files
 * (Claude, Codex, Pi) exports the files a session needs and its resume
 * cursor; the driver on the other computer writes them into its own
 * instance's home and returns the cursor that resumes them there.
 *
 * The sending computer's paths are never used to write. The importing
 * driver takes the session id from the cursor, checks its shape, and names
 * every destination itself with its own layout; anything it can't place
 * refuses the whole session (the agent then gets a summary). Every file a
 * transfer writes is marked as that transfer's. A destination that exists
 * is replaced only when the same transfer wrote it (a retry), or when it is
 * an older copy of the same session log the carried one carries on from (a
 * thread that moved away and back); someone else's file is never replaced.
 * A move that doesn't land takes back exactly what it wrote.
 *
 * @module provider/nativeSession
 */
import { createHash, randomUUID } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type { ProviderDriverKind } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

/** The most one session may be to travel with a move. */
export const NATIVE_SESSION_MAX_BYTES = 50 * 1024 * 1024;

/** One file of a session as its computer has it. */
export interface NativeSessionFile {
  /** Its path in the agent's home, `/`-separated. */
  readonly relPath: string;
  /** Where to read it. */
  readonly absolutePath: string;
  readonly size: number;
}

/** A session ready to travel: which driver wrote it, its files, and the cursor to send. */
export interface NativeSessionExport {
  readonly driver: ProviderDriverKind;
  readonly cliVersion?: string | undefined;
  /** The driver's cursor as the other computer needs it (no local paths). */
  readonly cursor: unknown;
  readonly files: ReadonlyArray<NativeSessionFile>;
}

/** One received file of a session, as the other computer named it. */
export interface NativeSessionReceivedFile {
  /** The sender's path in its agent's home; only read to tell the files apart. */
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

export interface NativeSessionImportInput {
  /** The cursor the other computer sent. */
  readonly cursor: unknown;
  readonly files: ReadonlyArray<NativeSessionReceivedFile>;
  /** The checkout the moved thread works in here. */
  readonly worktreePath: string;
  /** The move writing it: every file it writes is marked as this transfer's (placeSessionFiles). */
  readonly transferKey: string;
}

/**
 * The cursor that resumes the session here and the files this transfer
 * wrote (for discardSessionFiles and releaseSessionFiles), or why it can't
 * be carried.
 */
export type NativeSessionImportResult =
  | { readonly cursor: unknown; readonly written: ReadonlyArray<string> }
  | { readonly refused: string };

/** A destination the importing driver named, and what goes there. */
export interface NativeSessionPlacement {
  /** Absolute, under the instance's home. */
  readonly destination: string;
  readonly bytes: Uint8Array;
}

/** A canonical UUID, any version (Claude session ids, Codex thread ids, Pi session ids). */
export const isSessionUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Whether a carried session's failed turn says its contents can't be used on
 * this account or version (docs/design/fleet.md, Part 3d), from the
 * providers' own errors. Only signatures checked against a source:
 *
 * - Codex: OpenAI's `invalid_encrypted_content`, for encrypted reasoning made
 *   under another organization. Codex passes the API's body through as the
 *   turn's error text (codex-api `api_bridge.rs`, `CodexErr::InvalidRequest`,
 *   reported as `codexErrorInfo: "other"`); the code is from public reports
 *   of that error, not OpenAI's docs.
 * - Claude: a thinking block whose signature the API won't take: "Invalid
 *   `signature` in `thinking` block", and "The block is bound to a different
 *   conversation" (Anthropic's docs on preserved thinking). Claude Code
 *   strips such blocks and retries itself, so these reach us only when it
 *   has nothing left to strip.
 *
 * Anything else is an ordinary failed turn.
 */
export function isCarriedSessionRejection(errorText: string): boolean {
  const text = errorText.toLowerCase().replaceAll("`", "");
  return (
    text.includes("invalid_encrypted_content") ||
    text.includes("signature in thinking block") ||
    text.includes("bound to a different conversation")
  );
}

/** `relPath` of `absolute` under `home`, `/`-separated, or null when it isn't under it. */
export function relativeToHome(home: string, absolute: string): string | null {
  const relative = NodePath.relative(NodePath.resolve(home), NodePath.resolve(absolute));
  if (relative.length === 0 || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return null;
  }
  return relative.split(NodePath.sep).join("/");
}

/** The regular file at `path` with its size, or null (missing, a link, a folder). */
export const statSessionFile = (path: string) =>
  Effect.promise(async () => {
    try {
      const stat = await NodeFs.lstat(path);
      return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
      return null;
    }
  });

/** The entries of a folder, or none when it can't be read. */
export const listFolder = (path: string) =>
  Effect.promise(async () => {
    try {
      return await NodeFs.readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
  });

/**
 * Beside each file a transfer writes: which transfer wrote it, what it wrote,
 * and the length the file had before (null: the transfer made it). Written
 * before the file itself, so a retry after a crash knows the file as its
 * own, and an abort can take back exactly what it wrote.
 */
interface SessionFileMarker {
  readonly transferKey: string;
  readonly sha256: string;
  readonly priorLength: number | null;
}

const markerPath = (destination: string) =>
  NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.threadlines-move`,
  );

async function readMarker(destination: string): Promise<SessionFileMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await NodeFs.readFile(markerPath(destination), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.transferKey === "string" &&
      typeof record.sha256 === "string" &&
      (record.priorLength === null || typeof record.priorLength === "number")
      ? {
          transferKey: record.transferKey,
          sha256: record.sha256,
          priorLength: record.priorLength as number | null,
        }
      : null;
  } catch {
    return null;
  }
}

const writeMarker = (destination: string, marker: SessionFileMarker) =>
  NodeFs.writeFile(markerPath(destination), JSON.stringify(marker));

/** Replaces `destination` with `bytes` in one rename, so no reader sees half of it. */
async function replaceWhole(destination: string, bytes: Uint8Array) {
  const temp = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${randomUUID()}.threadlines-move-tmp`,
  );
  await NodeFs.writeFile(temp, bytes, { flag: "wx" });
  try {
    await NodeFs.rename(temp, destination);
  } finally {
    await NodeFs.rm(temp, { force: true });
  }
}

/** `there` is `bytes` cut short: an append-only session log this one carries on from. */
const isPrefixOf = (there: Uint8Array, bytes: Uint8Array) =>
  there.length < bytes.length && Buffer.from(bytes.subarray(0, there.length)).equals(there);

type PlaceOutcome = "ours" | "same" | "clash";

/**
 * Writes one file, never replacing another's: a new file goes in by hard
 * link from a temp file (else an exclusive copy). An existing one is
 * replaced only when this transfer wrote it (its marker), or when it is an
 * older copy of the same session log that these bytes carry on from (a
 * thread that moved away and back): its bytes stay a prefix of the new ones,
 * and an abort cuts it back to them. The same bytes already there are left
 * as they are.
 */
async function placeOne(
  placement: NativeSessionPlacement,
  transferKey: string,
): Promise<PlaceOutcome> {
  const { destination, bytes } = placement;
  const hash = sha256(bytes);
  const existing = await NodeFs.lstat(destination).catch(() => null);
  if (existing !== null) {
    if (!existing.isFile()) return "clash";
    const there = await NodeFs.readFile(destination);
    const marker = await readMarker(destination);
    const mine = marker !== null && marker.transferKey === transferKey;
    if (sha256(there) === hash) return mine ? "ours" : "same";
    if (mine && marker !== null) {
      await writeMarker(destination, { ...marker, sha256: hash });
      await replaceWhole(destination, bytes);
      return "ours";
    }
    if (!isPrefixOf(there, bytes)) return "clash";
    await writeMarker(destination, { transferKey, sha256: hash, priorLength: there.length });
    await replaceWhole(destination, bytes);
    return "ours";
  }
  await NodeFs.mkdir(NodePath.dirname(destination), { recursive: true });
  await writeMarker(destination, { transferKey, sha256: hash, priorLength: null });
  const temp = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${randomUUID()}.threadlines-move-tmp`,
  );
  await NodeFs.writeFile(temp, bytes, { flag: "wx" });
  try {
    try {
      await NodeFs.link(temp, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // A filesystem without hard links: an exclusive copy still never replaces.
        await NodeFs.copyFile(temp, destination, NodeFs.constants.COPYFILE_EXCL);
        return "ours";
      }
      // Someone else's appeared meanwhile: it isn't ours to mark.
      await NodeFs.rm(markerPath(destination), { force: true });
      const there = await NodeFs.readFile(destination);
      return sha256(there) === hash ? "same" : "clash";
    }
    return "ours";
  } finally {
    await NodeFs.rm(temp, { force: true });
  }
}

/**
 * Takes back what `transferKey` wrote at `destination`: a file it made goes,
 * a log it carried on from is cut back to its old length. Only while the
 * file still holds exactly what the transfer wrote; anything else is left
 * as it is. True once nothing of the transfer is left there.
 */
async function discardOne(destination: string, transferKey: string): Promise<boolean> {
  const marker = await readMarker(destination);
  if (marker === null || marker.transferKey !== transferKey) return true;
  const there = await NodeFs.readFile(destination).catch(() => null);
  if (there !== null && sha256(there) === marker.sha256) {
    if (marker.priorLength === null) await NodeFs.rm(destination, { force: true });
    else await NodeFs.truncate(destination, marker.priorLength);
  }
  await NodeFs.rm(markerPath(destination), { force: true });
  return true;
}

/**
 * Writes every placement as `transferKey`'s, or takes back all it wrote: a
 * destination someone else's file holds (other bytes, not an older copy
 * these carry on from) refuses the whole session. `written` lists the files
 * the transfer now owns, for discardSessionFiles and releaseSessionFiles.
 */
export const placeSessionFiles = (
  placements: ReadonlyArray<NativeSessionPlacement>,
  transferKey: string,
): Effect.Effect<{ readonly written: ReadonlyArray<string> } | { readonly refused: string }> =>
  Effect.promise(async () => {
    const written: Array<string> = [];
    const takeBack = async () => {
      for (const path of written) await discardOne(path, transferKey).catch(() => false);
    };
    try {
      for (const placement of placements) {
        // Marked before it is written: a failure partway still knows it.
        written.push(placement.destination);
        const outcome = await placeOne(placement, transferKey);
        if (outcome === "same") written.pop();
        if (outcome === "clash") {
          written.pop();
          await takeBack();
          return {
            refused: `${NodePath.basename(placement.destination)} is already there with other contents`,
          };
        }
      }
      return { written };
    } catch (error) {
      await takeBack();
      return { refused: `its files couldn't be written (${String(error)})` };
    }
  });

/**
 * A move that carried a session didn't land: what it wrote goes (a file it
 * made) or is cut back (a log it carried on from), file by file, only where
 * its own marker still matches. True once all of it is taken back.
 */
export const discardSessionFiles = (paths: ReadonlyArray<string>, transferKey: string) =>
  Effect.promise(async () => {
    let done = true;
    for (const path of paths) {
      done = (await discardOne(path, transferKey).catch(() => false)) && done;
    }
    return done;
  });

/** A move that carried a session landed: its files are the thread's now, and its markers go. */
export const releaseSessionFiles = (paths: ReadonlyArray<string>, transferKey: string) =>
  Effect.promise(async () => {
    for (const path of paths) {
      const marker = await readMarker(path);
      if (marker?.transferKey === transferKey) {
        await NodeFs.rm(markerPath(path), { force: true }).catch(() => undefined);
      }
    }
  });
