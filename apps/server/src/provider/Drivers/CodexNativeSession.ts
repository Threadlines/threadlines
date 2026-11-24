// @effect-diagnostics nodeBuiltinImport:off
/**
 * A Codex session carried with a moved thread (docs/design/fleet.md, Part
 * 3d): its rollout, `sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`
 * (or `.jsonl.zst` as found), and the cursor `{ threadId }`.
 *
 * On the other computer the rollout goes under that home's `sessions/` on
 * the date its own name says, and the cursor gains its path: the first start
 * resumes it by path with the new checkout as its cwd, and Codex learns it
 * from that resume.
 *
 * @module provider/Drivers/CodexNativeSession
 */
import { ProviderDriverKind } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import {
  isSessionUuid,
  listFolder,
  type NativeSessionExport,
  type NativeSessionImportInput,
  type NativeSessionImportResult,
  placeSessionFiles,
  statSessionFile,
} from "../nativeSession.ts";

const DRIVER = ProviderDriverKind.make("codex");

/** `rollout-YYYY-MM-DDTHH-MM-SS-<threadId>.jsonl[.zst]`, with the date and the thread id. */
const ROLLOUT_NAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;

const readThreadId = (cursor: unknown): string | null => {
  if (cursor === null || typeof cursor !== "object") return null;
  const threadId = (cursor as Record<string, unknown>).threadId;
  return isSessionUuid(threadId) ? threadId : null;
};

/** The days a UUIDv7 thread id was made on, around its own timestamp (local and UTC can differ by one). */
function likelyDays(threadId: string): ReadonlyArray<readonly [string, string, string]> {
  const hex = threadId.replaceAll("-", "").slice(0, 12);
  if (threadId[14] !== "7") return [];
  const ms = Number.parseInt(hex, 16);
  if (!Number.isFinite(ms)) return [];
  const days: Array<readonly [string, string, string]> = [];
  for (const offset of [0, -1, 1]) {
    const date = new Date(ms + offset * 24 * 60 * 60 * 1000);
    days.push([
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ]);
  }
  return days;
}

/** The rollout of `threadId` under `home`'s `sessions/`: its day first, then every day. */
export const findCodexRolloutFile = Effect.fn("findCodexRolloutFile")(function* (input: {
  readonly home: string;
  readonly threadId: string;
}): Effect.fn.Return<
  { readonly relPath: string; readonly absolutePath: string; readonly size: number } | null,
  never,
  never
> {
  const sessions = path.join(input.home, "sessions");
  const wanted = input.threadId.toLowerCase();
  const inDay = (year: string, month: string, day: string) =>
    Effect.gen(function* () {
      let best: { name: string; size: number; mtimeMs: number } | null = null;
      for (const entry of yield* listFolder(path.join(sessions, year, month, day))) {
        const match = ROLLOUT_NAME.exec(entry.name);
        if (!entry.isFile() || match?.[4]?.toLowerCase() !== wanted) continue;
        const stat = yield* statSessionFile(path.join(sessions, year, month, day, entry.name));
        if (stat !== null && (best === null || stat.mtimeMs > best.mtimeMs)) {
          best = { name: entry.name, ...stat };
        }
      }
      return best === null
        ? null
        : {
            relPath: `sessions/${year}/${month}/${day}/${best.name}`,
            absolutePath: path.join(sessions, year, month, day, best.name),
            size: best.size,
          };
    });
  const tried = new Set<string>();
  for (const [year, month, day] of likelyDays(input.threadId)) {
    tried.add(`${year}/${month}/${day}`);
    const found = yield* inDay(year, month, day);
    if (found !== null) return found;
  }
  const numeric = (entry: { readonly name: string; isDirectory(): boolean }) =>
    entry.isDirectory() && /^\d+$/.test(entry.name);
  for (const year of (yield* listFolder(sessions)).filter(numeric)) {
    for (const month of (yield* listFolder(path.join(sessions, year.name))).filter(numeric)) {
      for (const day of (yield* listFolder(path.join(sessions, year.name, month.name))).filter(
        numeric,
      )) {
        if (tried.has(`${year.name}/${month.name}/${day.name}`)) continue;
        const found = yield* inDay(year.name, month.name, day.name);
        if (found !== null) return found;
      }
    }
  }
  return null;
});

/** The session's rollout in `home`, or null when it has none here. */
export const exportCodexNativeSession = Effect.fn("exportCodexNativeSession")(function* (input: {
  readonly home: string;
  readonly resumeCursor: unknown;
}): Effect.fn.Return<NativeSessionExport | null, never, never> {
  const threadId = readThreadId(input.resumeCursor);
  if (threadId === null) return null;
  const rollout = yield* findCodexRolloutFile({ home: input.home, threadId });
  if (rollout === null) return null;
  return { driver: DRIVER, cursor: { threadId }, files: [rollout] };
});

/** Where a received rollout goes under `home`, from its own name; null for anything else. */
export function codexRolloutDestination(input: {
  readonly home: string;
  readonly threadId: string;
  readonly relPath: string;
}): string | null {
  const parts = input.relPath.split("/");
  const name = parts.at(-1) ?? "";
  const match = ROLLOUT_NAME.exec(name);
  if (
    parts.length !== 5 ||
    parts[0] !== "sessions" ||
    match === null ||
    match[4]!.toLowerCase() !== input.threadId.toLowerCase()
  ) {
    return null;
  }
  const [, year, month, day] = match;
  return path.join(input.home, "sessions", year!, month!, day!, name);
}

/** Writes a carried rollout into `home` and returns the cursor that resumes it here by path. */
export const importCodexNativeSession = Effect.fn("importCodexNativeSession")(function* (
  input: NativeSessionImportInput & { readonly home: string },
): Effect.fn.Return<NativeSessionImportResult, never, never> {
  const threadId = readThreadId(input.cursor);
  if (threadId === null) return { refused: "its Codex thread id isn't one" };
  const [file, ...more] = input.files;
  if (file === undefined || more.length > 0) {
    return { refused: "it doesn't hold exactly one rollout" };
  }
  const destination = codexRolloutDestination({
    home: input.home,
    threadId,
    relPath: file.relPath,
  });
  if (destination === null) return { refused: `"${file.relPath}" isn't the session's rollout` };
  const placed = yield* placeSessionFiles(
    [{ destination, bytes: file.bytes }],
    input.transferKey,
    input.journal,
  );
  return "refused" in placed
    ? placed
    : { cursor: { threadId, rolloutPath: destination }, written: placed.written };
});
