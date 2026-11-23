// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the agent's own session log.
/**
 * Reads the error that ended an Antigravity turn from the agent's own session
 * log. THIS READS A PRIVATE FORMAT: Google documents none of it, and a CLI
 * update can change it without notice. It is the one place Threadlines reads
 * the CLI's session files, and only for what ACP gives no word of.
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
 * Layout as of `agy` 1.5.14, matching T3 Code's reader
 * (apps/server/src/provider/acp/AntigravityTurnOutcome.ts).
 *
 * @module provider/antigravity/AntigravitySessionLog
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";

import { ANTIGRAVITY_APP_DATA_DIR } from "./AntigravityRelease.ts";

/** CORTEX_STEP_TYPE_ERROR_MESSAGE. */
const ERROR_STEP_TYPE = 17;
/** CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within the turn. */
const MODEL_REPLY_STEP_TYPE = 15;
/** The error text leads the payload; a stack trace follows it. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
/** A conversation id as the CLI names its files: nothing that walks a path. */
const SESSION_ID = /^[\w-]{1,128}$/u;

/** How a turn's steps ended, as far as the log says. */
export interface AntigravityTurnSteps {
  /** The error text when the turn's last step is an error. */
  readonly errorText: string | undefined;
  /** The model answered at least once in the turn. */
  readonly reachedModel: boolean;
}

/**
 * The session's log file when it is a plain file in the profile (no link at
 * any step of the path), or `undefined` when there is none yet.
 */
async function sessionLogFile(profileDir: string, sessionId: string): Promise<string | undefined> {
  const root = await NodeFSP.realpath(profileDir).catch(() => undefined);
  if (root === undefined) return undefined;
  const segments = [ANTIGRAVITY_APP_DATA_DIR, "conversations", `${sessionId}.db`];
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = NodePath.join(current, segment);
    const info = await NodeFSP.lstat(current).catch(() => undefined);
    const last = index === segments.length - 1;
    if (info === undefined || info.isSymbolicLink()) return undefined;
    if (last ? !info.isFile() : !info.isDirectory()) return undefined;
  }
  return current;
}

function readLog<A>(file: string, read: (database: DatabaseSync) => A): A | undefined {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    const hasSteps =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
        .get() !== undefined;
    return hasSteps ? read(database) : undefined;
  } finally {
    database.close();
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
    const file = await sessionLogFile(profileDir, sessionId);
    if (file === undefined) return -1;
    const index = readLog(file, (database) => {
      const value = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
      return typeof value === "number" ? value : -1;
    });
    return index ?? -1;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** How the steps after `afterIndex` ended; `undefined` when the log can't be read. */
export const antigravityTurnSteps = (profileDir: string, sessionId: string, afterIndex: number) =>
  Effect.tryPromise(async (): Promise<AntigravityTurnSteps | undefined> => {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const file = await sessionLogFile(profileDir, sessionId);
    if (file === undefined) return undefined;
    return readLog(file, (database) => {
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
            ? new TextDecoder().decode(payload)
            : typeof payload === "string"
              ? payload
              : ""
          : undefined;
      return { errorText, reachedModel };
    });
  }).pipe(Effect.orElseSucceed(() => undefined));
