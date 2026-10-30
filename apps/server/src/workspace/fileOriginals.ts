/**
 * The copies Threadlines keeps of files outside a project before it first
 * saves over them. A file outside the project has no git history the app can
 * fall back on, so the first save from the file viewer keeps the bytes it is
 * about to replace, and "Restore original" puts them back.
 *
 * One original per file, named by a hash of the file's resolved location: a
 * symlink retargeted elsewhere resolves somewhere new and finds no original,
 * so a restore can never write one file's bytes into another. Originals may
 * hold secrets (dotfiles, tokens), so the folder and files are private to the
 * user, and they expire after {@link FILE_ORIGINAL_RETENTION_MS}.
 */
import { createHash, randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const FILE_ORIGINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How old a leftover from a cut-short write must be before pruning removes it. */
const LEFTOVER_GRACE_MS = 60 * 60 * 1000;

const FileOriginalRecord = Schema.Struct({
  path: Schema.String,
  savedAt: Schema.String,
  contentHash: Schema.String,
  size: Schema.Number,
});
type FileOriginalRecord = typeof FileOriginalRecord.Type;

const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(FileOriginalRecord));

export interface FileOriginal {
  readonly savedAt: string;
  readonly bytes: Uint8Array;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const makeFileOriginals = Effect.fn("makeFileOriginals")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const filesFor = (realPath: string) => {
    const key = sha256Hex(realPath);
    return {
      bytes: path.join(directory, `${key}.orig`),
      record: path.join(directory, `${key}.json`),
    };
  };

  const isExpired = (record: FileOriginalRecord, now: number) => {
    const savedAt = Date.parse(record.savedAt);
    return !Number.isFinite(savedAt) || now - savedAt > FILE_ORIGINAL_RETENTION_MS;
  };

  const discard = (realPath: string) => {
    const files = filesFor(realPath);
    return Effect.all(
      [
        fileSystem.remove(files.record, { force: true }),
        fileSystem.remove(files.bytes, { force: true }),
      ],
      { discard: true },
    );
  };

  /** The record of a live original, or null (none, expired, or unreadable). */
  const recordOf = Effect.fn("FileOriginals.recordOf")(function* (realPath: string) {
    const files = filesFor(realPath);
    const raw = yield* fileSystem
      .readFileString(files.record)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (raw === null) return null;
    const record = yield* decodeRecord(raw).pipe(Effect.catch(() => Effect.succeed(null)));
    if (record === null || record.path !== realPath) return null;
    if (isExpired(record, Date.now())) {
      yield* discard(realPath).pipe(Effect.ignore);
      return null;
    }
    return record;
  });

  /**
   * Flushes the folder's entries, so a rename in it survives a power cut.
   * Best effort: Windows can't open a folder, and flushes renames itself.
   */
  const syncDirectory = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(directory, { flag: "r" });
      yield* handle.sync;
    }),
  ).pipe(Effect.ignore);

  /**
   * Writes `bytes` to `target` so that a crash leaves either nothing or the
   * whole file: a private temp file beside it, flushed, renamed over, and the
   * rename flushed too.
   */
  const writeDurably = Effect.fn("FileOriginals.writeDurably")(function* (
    target: string,
    bytes: Uint8Array,
  ) {
    const temp = `${target}.${randomUUID()}.tmp`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(temp, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(bytes);
        yield* file.sync;
      }),
    ).pipe(Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)));
    yield* fileSystem
      .rename(temp, target)
      .pipe(Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)));
    yield* syncDirectory;
  });

  /**
   * Drops every original past its retention, and what a cut-short write left
   * behind (a temp file, or a copy whose record never landed): those are
   * never offered and may hold secrets. Best effort.
   */
  const pruneExpired = Effect.fn("FileOriginals.pruneExpired")(function* () {
    const names = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
    const present = new Set(names);
    const now = Date.now();
    const remove = (name: string) =>
      fileSystem.remove(path.join(directory, name), { force: true }).pipe(Effect.ignore);
    for (const name of names) {
      if (name.endsWith(".json")) {
        const raw = yield* fileSystem
          .readFileString(path.join(directory, name))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const record =
          raw === null
            ? null
            : yield* decodeRecord(raw).pipe(Effect.catch(() => Effect.succeed(null)));
        if (record === null || isExpired(record, now)) {
          yield* remove(name);
          yield* remove(`${name.slice(0, -".json".length)}.orig`);
        }
        continue;
      }
      const leftover =
        name.endsWith(".tmp") ||
        (name.endsWith(".orig") && !present.has(`${name.slice(0, -".orig".length)}.json`));
      if (!leftover) continue;
      const modifiedAt = yield* fileSystem.stat(path.join(directory, name)).pipe(
        Effect.map((info) => Option.getOrNull(info.mtime)?.getTime() ?? 0),
        Effect.catch(() => Effect.succeed(now)),
      );
      if (now - modifiedAt > LEFTOVER_GRACE_MS) {
        yield* remove(name);
      }
    }
  });

  return {
    /** When the live original of a file was kept, or null. */
    savedAt: Effect.fn("FileOriginals.savedAt")(function* (realPath: string) {
      const record = yield* recordOf(realPath);
      return record?.savedAt ?? null;
    }),

    /**
     * Keeps `bytes` as the file's original unless one is already kept, and
     * returns when the kept one was saved. Must finish before the file is
     * changed: it is durable on disk by the time this returns.
     */
    keep: Effect.fn("FileOriginals.keep")(function* (realPath: string, bytes: Uint8Array) {
      const existing = yield* recordOf(realPath);
      if (existing !== null) return existing.savedAt;
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
      // An existing folder keeps its old mode; make it private either way.
      yield* fileSystem.chmod(directory, 0o700);
      yield* pruneExpired().pipe(Effect.ignore);
      const files = filesFor(realPath);
      const savedAt = new Date().toISOString();
      yield* writeDurably(files.bytes, bytes);
      // The record goes last: an original without its record is never offered.
      yield* writeDurably(
        files.record,
        new TextEncoder().encode(
          JSON.stringify({
            path: realPath,
            savedAt,
            contentHash: sha256Hex(bytes),
            size: bytes.length,
          } satisfies FileOriginalRecord),
        ),
      );
      return savedAt;
    }),

    /** The live original, checked against its recorded hash, or null. */
    read: Effect.fn("FileOriginals.read")(function* (realPath: string) {
      const record = yield* recordOf(realPath);
      if (record === null) return null;
      const bytes = yield* fileSystem
        .readFile(filesFor(realPath).bytes)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (bytes === null || sha256Hex(bytes) !== record.contentHash) return null;
      return { savedAt: record.savedAt, bytes } satisfies FileOriginal;
    }),

    discard,
  };
});

export type FileOriginals = Effect.Success<ReturnType<typeof makeFileOriginals>>;
