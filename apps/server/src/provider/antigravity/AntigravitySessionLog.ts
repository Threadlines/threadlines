// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the agent's own session log.
/**
 * Reads the error that ended an Antigravity turn from the agent's own session
 * log. THIS READS A PRIVATE FORMAT: Google documents none of it, and a CLI
 * update can change it without notice. With `AntigravityChildRecords` (its
 * subagents' records) it is where Threadlines reads the CLI's session files,
 * and only for what ACP gives no word of.
 *
 * `agy acp` reports an upstream failure (a 5xx, an exhausted quota, a history
 * the model refuses) as a chat message and a normal `end_turn`. The CLI keeps
 * each conversation in `<profile>/antigravity-acp/conversations/<id>.db`, an
 * SQLite file whose `steps` table holds one row per step: `step_type` 17 is
 * an error (its payload starts with the API's error text), 15 a model reply.
 * The read looks only at steps the current turn added, opens the file
 * read-only, and refuses a path that is a link or anything but a plain file
 * inside the profile Threadlines made.
 *
 * What this can't rule out, and accepts: SQLite opens the database by its
 * path, on its own, so a folder swapped and swapped back within that one
 * open isn't seen (the file is held open meanwhile and checked again after,
 * which catches a swap that stays). Folder listings (`AntigravityChildRecords`)
 * read names by path the same way; every file named is then opened through
 * `openAntigravityProfileFile`, so a swapped listing yields only names. Both
 * need write access to the agent's own profile and a swap timed inside one
 * open. The worst result is one wrong failure reading: a turn failed with
 * words read from another SQLite file.
 *
 * Layout as of `agy` 1.5.14, matching T3 Code's reader
 * (apps/server/src/provider/acp/AntigravityTurnOutcome.ts).
 *
 * @module provider/antigravity/AntigravitySessionLog
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";

import { openRegularFile } from "./AntigravityFileReads.ts";
import { ANTIGRAVITY_APP_DATA_DIR } from "./AntigravityRelease.ts";

/** CORTEX_STEP_TYPE_ERROR_MESSAGE. */
const ERROR_STEP_TYPE = 17;
/** CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within the turn. */
const MODEL_REPLY_STEP_TYPE = 15;
/** The error text leads the payload; a stack trace follows it. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
/** A conversation id as the CLI names its files: nothing that walks a path. */
const SESSION_ID = /^[\w-]{1,128}$/u;
const utf8Decoder = new TextDecoder();
/** Async retry delays (ms) when SQLite reports BUSY/LOCKED, ~100ms total without blocking the event loop. */
const SQLITE_BUSY_RETRY_DELAYS_MS = [5, 10, 15, 20, 25, 25] as const;

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as {
    readonly errcode?: unknown;
    readonly errstr?: unknown;
    readonly message?: unknown;
  };
  if (record.errcode === 5 || record.errcode === 6) return true;
  if (typeof record.errstr === "string") {
    const lower = record.errstr.toLowerCase();
    if (lower.includes("locked") || lower.includes("busy")) return true;
  }
  if (typeof record.message === "string") {
    const lower = record.message.toLowerCase();
    if (
      lower.includes("database is locked") ||
      lower.includes("database table is locked") ||
      lower.includes("sqlite_busy") ||
      lower.includes("sqlite_locked")
    ) {
      return true;
    }
  }
  return false;
}

/** How a turn's steps ended, as far as the log says. */
export interface AntigravityTurnSteps {
  /** The error text when the turn's last step is an error. */
  readonly errorText: string | undefined;
  /** The model answered at least once in the turn. */
  readonly reachedModel: boolean;
}

/**
 * An entry of the CLI's own data in the profile (`antigravity-acp/...`), when
 * every step of its path exists with the expected type and none is a link,
 * with its size. Otherwise `missing` (nothing there) or `refused` (a link,
 * or not the expected type): a reader must not take a refused entry for an
 * empty one. A link could point at another session's records, or out of
 * the profile. Shared by every reader of the CLI's private files (this one
 * and `AntigravityChildRecords`).
 */
export async function antigravityProfileEntry(
  profileDir: string,
  segments: ReadonlyArray<string>,
  kind: "file" | "directory",
): Promise<{ readonly path: string; readonly size: number } | "missing" | "refused"> {
  return profileEntry(profileDir, segments, kind);
}

/** The entry, or whether it is missing or not what the layout says (a link, another type). */
async function profileEntry(
  profileDir: string,
  segments: ReadonlyArray<string>,
  kind: "file" | "directory",
): Promise<{ readonly path: string; readonly size: number } | "missing" | "refused"> {
  const root = await NodeFSP.realpath(profileDir).catch(() => undefined);
  if (root === undefined) return "missing";
  let current = root;
  let size = 0;
  const path = [ANTIGRAVITY_APP_DATA_DIR, ...segments];
  for (const [index, segment] of path.entries()) {
    current = NodePath.join(current, segment);
    const info = await NodeFSP.lstat(current).catch(() => undefined);
    const last = index === path.length - 1;
    if (info === undefined) return "missing";
    if (info.isSymbolicLink()) return "refused";
    if (last && kind === "file" ? !info.isFile() : !info.isDirectory()) return "refused";
    size = info.size;
  }
  return { path: current, size };
}

/** A file of the CLI's, open, and proven to be the one at its place in the profile. */
export interface AntigravityProfileFile {
  readonly path: string;
  readonly handle: NodeFSP.FileHandle;
  readonly size: number;
  /** Whether the file at `path` is still the one this holds (nothing swapped since). */
  readonly stillHeld: () => Promise<boolean>;
}

/**
 * Opens a file of the CLI's data in the profile (`antigravity-acp/...`). The
 * path is checked step by step first (no links, the expected types), then
 * opened without following a link or blocking, and then checked again from
 * the handle: the path must still resolve to itself inside the profile, and
 * the file held must be the one at that path now. A directory on the way
 * that was swapped for a link between the check and the open would
 * otherwise hand over a file from anywhere. `missing` when there is no such
 * file; `refused` for anything else that isn't it. Close the handle.
 */
export async function openAntigravityProfileFile(
  profileDir: string,
  segments: ReadonlyArray<string>,
  /** Runs between the path check and the open: tests swap a folder here. */
  beforeOpen?: () => Promise<void>,
): Promise<AntigravityProfileFile | "missing" | "refused"> {
  const entry = await profileEntry(profileDir, segments, "file");
  if (typeof entry === "string") return entry;
  await beforeOpen?.();
  const opened = await openRegularFile(entry.path, { followLink: false });
  if (opened === undefined) return "refused";
  const held = await opened.handle.stat().catch(() => undefined);
  const stillHeld = async () => {
    const [real, now] = await Promise.all([
      NodeFSP.realpath(entry.path).catch(() => undefined),
      NodeFSP.lstat(entry.path).catch(() => undefined),
    ]);
    // `entry.path` is built on the profile's real path, so resolving to
    // itself means it is inside the profile with no link anywhere on it.
    return (
      held !== undefined &&
      real === entry.path &&
      now !== undefined &&
      now.dev === held.dev &&
      now.ino === held.ino
    );
  };
  if (!(await stillHeld())) {
    await opened.handle.close();
    return "refused";
  }
  return { path: entry.path, handle: opened.handle, size: opened.size, stillHeld };
}

/**
 * Reads the session's log, holding the file open meanwhile and confirming
 * afterwards that SQLite read the file that was checked (it opens the path
 * itself). `missing` when there is no log yet, `refused` when the file
 * can't be trusted; `read` gets `undefined` for a log with no steps yet.
 */
async function withSessionLog<A>(
  profileDir: string,
  sessionId: string,
  read: (database: DatabaseSync) => A,
): Promise<{ readonly value: A | undefined } | "missing" | "refused"> {
  const file = await openAntigravityProfileFile(profileDir, ["conversations", `${sessionId}.db`]);
  if (typeof file === "string") return file;
  try {
    const value = await readLogAsync(file.path, read);
    return (await file.stillHeld()) ? { value } : "refused";
  } finally {
    await file.handle.close();
  }
}

function readLogOnce<A>(file: string, read: (database: DatabaseSync) => A): A | undefined {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    const hasSteps =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
        .get() !== undefined;
    return hasSteps ? read(database) : undefined;
  } finally {
    database.close();
  }
}

async function readLogAsync<A>(
  file: string,
  read: (database: DatabaseSync) => A,
): Promise<A | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readLogOnce(file, read);
    } catch (error) {
      const delayMs = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isSqliteBusyError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

/**
 * Where the session's log stands before a prompt goes out: the index of its
 * last step (-1 for a log not written yet), or `undefined` when it can't be
 * read and the turn's end can't be told from it.
 */
export const antigravityLogPosition = (profileDir: string, sessionId: string) =>
  Effect.tryPromise(async () => {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const index = await withSessionLog(profileDir, sessionId, (database) => {
      const value = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
      return typeof value === "number" ? value : -1;
    });
    if (index === "missing") return -1;
    return index === "refused" ? undefined : (index.value ?? -1);
  }).pipe(Effect.orElseSucceed(() => undefined));

/** How the steps after `afterIndex` ended; `undefined` when the log can't be read. */
export const antigravityTurnSteps = (profileDir: string, sessionId: string, afterIndex: number) =>
  Effect.tryPromise(async (): Promise<AntigravityTurnSteps | undefined> => {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const steps = await withSessionLog(profileDir, sessionId, (database) => {
      const last = database
        .prepare(
          `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
           FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
        )
        .get(MAX_ERROR_PAYLOAD_BYTES, afterIndex);
      if (typeof last?.type !== "number") return { errorText: undefined, reachedModel: false };
      const reachedModel =
        database
          .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
          .get(afterIndex, MODEL_REPLY_STEP_TYPE) !== undefined;
      const payload = last.payload;
      const errorText =
        last.type === ERROR_STEP_TYPE
          ? payload instanceof Uint8Array
            ? utf8Decoder.decode(payload)
            : typeof payload === "string"
              ? payload
              : ""
          : undefined;
      return { errorText, reachedModel };
    });
    return typeof steps === "string" ? undefined : steps.value;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Removes the CLI's on-disk files for one throwaway session (model discovery,
 * sign-in verification, text generation) once its process has exited. Every
 * path is verified inside the profile with no symlinks via
 * `antigravityProfileEntry`.
 */
export const removeAntigravitySessionFiles = (profileDir: string, sessionId: string) =>
  Effect.promise(async () => {
    if (!SESSION_ID.test(sessionId)) return;
    const files: ReadonlyArray<ReadonlyArray<string>> = [
      ["conversations", `${sessionId}.db`],
      ["conversations", `${sessionId}.db-wal`],
      ["conversations", `${sessionId}.db-shm`],
      ["conversations", `${sessionId}.db-journal`],
      ["annotations", `${sessionId}.pbtxt`],
    ];
    for (const segments of files) {
      const entry = await antigravityProfileEntry(profileDir, segments, "file");
      if (typeof entry !== "string") {
        await NodeFSP.rm(entry.path, { force: true }).catch(() => undefined);
      }
    }
    const brainEntry = await antigravityProfileEntry(profileDir, ["brain", sessionId], "directory");
    if (typeof brainEntry !== "string") {
      await NodeFSP.rm(brainEntry.path, { recursive: true, force: true }).catch(() => undefined);
    }
  });
