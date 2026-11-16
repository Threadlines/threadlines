// @effect-diagnostics nodeBuiltinImport:off
/**
 * A Pi session carried with a moved thread (docs/design/fleet.md, Part 3d):
 * the session file its cursor names, from Pi's own folder
 * (`<agent dir>/sessions/<slug>/<timestamp>_<id>.jsonl`), with the cursor's
 * `sessionFile` made relative to that folder.
 *
 * On the other computer the file goes under that Pi folder's sessions, in
 * the new checkout's slug, and the cursor names it there with the old `cwd`.
 * The cwd differs from the new checkout, so Pi forks it into the new folder
 * on its first start, as it does for a thread moved to another checkout.
 *
 * @module provider/pi/PiNativeSession
 */
import { ProviderDriverKind } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import {
  type NativeSessionExport,
  type NativeSessionImportInput,
  type NativeSessionImportResult,
  placeSessionFiles,
  relativeToHome,
  statSessionFile,
} from "../nativeSession.ts";
import { makePiResumeCursor, parsePiResumeCursor } from "./PiCursor.ts";

const DRIVER = ProviderDriverKind.make("pi");

/** `<timestamp>_<session id>.jsonl`, as Pi names a session file. */
const SESSION_NAME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Pi's folder name for a cwd's sessions (its `getDefaultSessionDirPath`). */
export const piSessionSlug = (cwd: string) =>
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** The session file the cursor names, when it lies in this Pi folder's sessions; null otherwise. */
export const exportPiNativeSession = Effect.fn("exportPiNativeSession")(function* (input: {
  readonly agentDir: string;
  readonly resumeCursor: unknown;
}): Effect.fn.Return<NativeSessionExport | null, never, never> {
  const cursor = parsePiResumeCursor(input.resumeCursor);
  if (cursor === undefined) return null;
  const relPath = relativeToHome(input.agentDir, cursor.sessionFile);
  const parts = relPath?.split("/") ?? [];
  if (relPath === null || parts.length !== 3 || parts[0] !== "sessions") return null;
  if (!SESSION_NAME.test(parts[2]!)) return null;
  const absolutePath = path.join(input.agentDir, ...parts);
  const stat = yield* statSessionFile(absolutePath);
  if (stat === null) return null;
  return {
    driver: DRIVER,
    cursor: { ...cursor, sessionFile: relPath },
    files: [{ relPath, absolutePath, size: stat.size }],
  };
});

/** Writes a carried session file into `agentDir` and returns the cursor that opens it here. */
export const importPiNativeSession = Effect.fn("importPiNativeSession")(function* (
  input: NativeSessionImportInput & { readonly agentDir: string },
): Effect.fn.Return<NativeSessionImportResult, never, never> {
  const cursor = parsePiResumeCursor(input.cursor);
  if (cursor === undefined) return { refused: "its Pi cursor isn't one" };
  const name = cursor.sessionFile.split("/").at(-1) ?? "";
  if (!SESSION_NAME.test(name)) return { refused: "its Pi session file isn't one" };
  const [file, ...more] = input.files;
  if (file === undefined || more.length > 0 || file.relPath !== cursor.sessionFile) {
    return { refused: "it doesn't hold exactly the session file its cursor names" };
  }
  const destination = path.join(
    input.agentDir,
    "sessions",
    piSessionSlug(input.worktreePath),
    name,
  );
  const placed = yield* placeSessionFiles(
    [{ destination, bytes: file.bytes }],
    input.transferKey,
    input.journal,
  );
  if ("refused" in placed) return placed;
  return {
    cursor: makePiResumeCursor({
      sessionFile: destination,
      cwd: cursor.cwd,
      defaultModel: cursor.defaultModel,
    }),
    written: placed.written,
  };
});
