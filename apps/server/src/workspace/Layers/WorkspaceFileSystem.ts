import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import {
  PROJECT_WRITE_FILE_MAX_BYTES,
  type ProjectReadFileResult,
  type ProjectRestoreOriginalResult,
  type ProjectWriteFileResult,
} from "@threadlines/contracts";

import { ServerConfig } from "../../config.ts";
import { makeFileOriginals } from "../fileOriginals.ts";
import {
  detectRasterImageMimeType,
  IMAGE_MIME_TYPE_BY_EXTENSION,
  SAFE_IMAGE_FILE_EXTENSIONS,
} from "../../imageMime.ts";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePathOutsideRootError, WorkspacePaths } from "../Services/WorkspacePaths.ts";

/** Text reads beyond this many bytes return a truncated, read-only prefix. */
export const WORKSPACE_TEXT_READ_MAX_BYTES = 1_048_576;
/** Images beyond this many bytes are reported as binary instead of inlined. */
export const WORKSPACE_IMAGE_READ_MAX_BYTES = 10_485_760;
/** PDFs beyond this many bytes are reported as binary instead of inlined. */
export const WORKSPACE_DOCUMENT_READ_MAX_BYTES = 20_971_520;

const SVG_EXTENSION = ".svg";
const PDF_EXTENSION = ".pdf";
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Text as the editor holds it. A BOM stays in, so a save writes it back. */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Whether the editor can hold these bytes and a save write the same bytes
 * back. Anything else (Windows-1252, Shift JIS, invalid UTF-8) would come back
 * garbled from the first save.
 */
function roundTripsAsUtf8(bytes: Uint8Array): boolean {
  return Buffer.from(decodeText(bytes), "utf8").equals(Buffer.from(bytes));
}

/** An SVG is text: only the start of one that says so counts as a picture. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, 4096)).toLowerCase();
  return head.includes("<svg");
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;
  const config = yield* ServerConfig;
  const originals = yield* makeFileOriginals(path.join(config.stateDir, "file-originals"));
  // Saves and restores take turns, so a conflict check and the write that
  // follows it see the same file. (A program outside the app can still write
  // in between; the hash check narrows that to a moment.)
  const writeLock = yield* Semaphore.make(1);

  const failWith =
    (input: { cwd: string; relativePath: string }, operation: string) =>
    (cause: { readonly message: string }) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation,
        detail: cause.message,
        cause,
      });

  const readError = (input: { cwd: string; relativePath: string }, operation: string) =>
    Effect.mapError(failWith(input, operation));

  const refuse = (
    input: { cwd: string; relativePath: string },
    operation: string,
    detail: string,
  ) =>
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation,
      detail,
    });

  const realPathOrNull = (target: string) =>
    fileSystem
      .realPath(target)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
      );

  /** Whether `candidate` lies under `root` (the root itself only when `allowRoot`). */
  const isUnder = (root: string, candidate: string, allowRoot: boolean) => {
    const relative = path.relative(root, candidate);
    if (relative.length === 0) return allowRoot;
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  /** The real location of the nearest folder at or above `start` that exists. */
  const nearestExistingRealPath = Effect.fn("WorkspaceFileSystem.nearestExistingRealPath")(
    function* (start: string) {
      let current = start;
      while (true) {
        const real = yield* realPathOrNull(current);
        if (real !== null) return real;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    },
  );

  /**
   * Where a read or write lands, and whether that is inside the project.
   * Inside is judged by real paths, so a symlink in the project that points
   * elsewhere counts as outside and gets the outside rules (an original kept
   * before the first save). A file that doesn't exist yet is judged by where
   * its path really leads: through a dangling link, or a folder link that
   * leaves the project, it is outside. A caller names a file outside the
   * project by an absolute path or one that climbs out with `..`.
   */
  const resolveTarget = Effect.fn("WorkspaceFileSystem.resolveTarget")(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) {
    const lexical = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      })
      .pipe(Effect.option);
    const absolutePath = Option.isSome(lexical)
      ? lexical.value.absolutePath
      : path.resolve(input.cwd, input.relativePath.trim());
    const rootRealPath = yield* fileSystem
      .realPath(input.cwd)
      .pipe(readError(input, "workspaceFileSystem.resolveRootRealPath"));
    // A vanished target is an expected state, not an IO fault: agents
    // delete and rename files while chat references keep pointing at the old
    // path. Callers report it as `missing` so clients don't retry.
    const realPath = yield* realPathOrNull(absolutePath).pipe(
      readError(input, "workspaceFileSystem.resolveTargetRealPath"),
    );
    let inside: boolean;
    if (realPath !== null) {
      inside = isUnder(rootRealPath, realPath, false);
    } else if (Option.isNone(lexical)) {
      inside = false;
    } else {
      const danglingLink = yield* fileSystem.readLink(absolutePath).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      const folder = danglingLink
        ? null
        : yield* nearestExistingRealPath(path.dirname(absolutePath)).pipe(
            readError(input, "workspaceFileSystem.resolveTargetRealPath"),
          );
      inside = folder !== null && isUnder(rootRealPath, folder, true);
    }
    return {
      absolutePath,
      realPath,
      inside,
      // Results name a project file by its project path and anything else
      // the way the caller did.
      relativePath:
        inside && Option.isSome(lexical) ? lexical.value.relativePath : input.relativePath,
    };
  });

  /** Up to `maxBytes` of an open file, from where it was left. */
  const readFrom = (file: FileSystem.File, maxBytes: number) =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      let bytesRead = 0;
      while (bytesRead < maxBytes) {
        const chunk = yield* file.readAlloc(maxBytes - bytesRead);
        if (Option.isNone(chunk) || chunk.value.length === 0) {
          break;
        }
        chunks.push(chunk.value);
        bytesRead += chunk.value.length;
      }
      return Buffer.concat(chunks, bytesRead);
    });

  const readFilePrefix = (absolutePath: string, maxBytes: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(absolutePath);
        return yield* readFrom(file, maxBytes);
      }),
    );

  /**
   * Replaces an open file's bytes in place and flushes them to disk, so the
   * file keeps its mode, owner and links.
   */
  const replaceOpenFile = (file: FileSystem.File, bytes: Uint8Array) =>
    Effect.gen(function* () {
      yield* file.truncate(0);
      yield* file.seek(0n, "start");
      yield* file.writeAll(bytes);
      yield* file.sync;
    });

  /**
   * Opens a file outside the project for a save or a restore. Everything
   * after this works on the one open file, so whatever sits at the path when
   * it is checked is what gets kept and replaced, even if the path is swapped
   * for a link in between.
   */
  const openForChange = (input: { cwd: string; relativePath: string }, realPath: string) =>
    Effect.gen(function* () {
      const file = yield* fileSystem
        .open(realPath, { flag: "r+" })
        .pipe(readError(input, "workspaceFileSystem.openForChange"));
      const info = yield* file.stat.pipe(readError(input, "workspaceFileSystem.statFile"));
      if (info.type !== "File") {
        return yield* refuse(
          input,
          "workspaceFileSystem.writeFile",
          `Cannot save over an entry of type '${info.type}'.`,
        );
      }
      const current = yield* readFrom(file, PROJECT_WRITE_FILE_MAX_BYTES + 1).pipe(
        readError(input, "workspaceFileSystem.readForChange"),
      );
      return { file, current };
    });

  /**
   * Refuses a save over bytes this app may not save over: more than
   * {@link PROJECT_WRITE_FILE_MAX_BYTES} (so the editor never had them whole)
   * or text that UTF-8 doesn't carry exactly.
   */
  const checkSavable = (input: { cwd: string; relativePath: string }, bytes: Uint8Array) => {
    if (bytes.length > PROJECT_WRITE_FILE_MAX_BYTES) {
      return refuse(
        input,
        "workspaceFileSystem.saveTooLarge",
        "Files larger than 1 MB can't be saved here.",
      );
    }
    if (bytes.includes(0) || !roundTripsAsUtf8(bytes)) {
      return refuse(
        input,
        "workspaceFileSystem.saveEncoding",
        "This file isn't UTF-8 text, so saving it here would garble it.",
      );
    }
    return Effect.void;
  };

  const conflictWith = (relativePath: string, bytes: Uint8Array) =>
    ({
      kind: "conflict",
      relativePath,
      content: decodeText(bytes),
      contentHash: sha256Hex(bytes),
      size: bytes.length,
    }) satisfies ProjectWriteFileResult;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const contents = Buffer.from(input.contents, "utf8");
    if (contents.length > PROJECT_WRITE_FILE_MAX_BYTES) {
      return yield* refuse(
        input,
        "workspaceFileSystem.saveTooLarge",
        "Files larger than 1 MB can't be saved here.",
      );
    }
    const target = yield* resolveTarget(input);

    if (!target.inside) {
      // Outside the project the app only changes a file that is already
      // there, against the exact bytes the editor started from, and keeps
      // what it replaces first.
      if (target.realPath === null) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
      }
      const realPath = target.realPath;
      const expectedContentHash = input.expectedContentHash;
      if (expectedContentHash === undefined) {
        return yield* refuse(
          input,
          "workspaceFileSystem.saveOutsideWithoutBaseline",
          "Saving a file outside the project needs the version it was edited from.",
        );
      }
      const stat = yield* fileSystem
        .stat(realPath)
        .pipe(readError(input, "workspaceFileSystem.statFile"));
      if (stat.type !== "File") {
        return yield* refuse(
          input,
          "workspaceFileSystem.writeFile",
          `Cannot save over an entry of type '${stat.type}'.`,
        );
      }
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const { file, current } = yield* openForChange(input, realPath);
          yield* checkSavable(input, current);
          if (sha256Hex(current) !== expectedContentHash) {
            return conflictWith(target.relativePath, current);
          }
          const savedAt = yield* originals
            .keep(realPath, current)
            .pipe(readError(input, "workspaceFileSystem.keepOriginal"));
          // The original above is the way back if this write is cut short.
          yield* replaceOpenFile(file, contents).pipe(
            readError(input, "workspaceFileSystem.writeFile"),
          );
          return {
            kind: "written",
            relativePath: target.relativePath,
            contentHash: sha256Hex(contents),
            original: { savedAt },
          } satisfies ProjectWriteFileResult;
        }),
      );
    }

    // Optimistic-concurrency check: refuse to clobber content another writer
    // (typically an agent) changed since the caller's baseline read. A file
    // that vanished entirely is NOT a conflict — the caller is actively
    // editing it, so the write simply recreates it.
    if (target.realPath !== null) {
      const current = yield* readFilePrefix(target.realPath, PROJECT_WRITE_FILE_MAX_BYTES + 1).pipe(
        readError(input, "workspaceFileSystem.readForSave"),
      );
      yield* checkSavable(input, current);
      if (
        input.expectedContentHash !== undefined &&
        sha256Hex(current) !== input.expectedContentHash
      ) {
        return conflictWith(target.relativePath, current);
      }
    }

    yield* fileSystem
      .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
      .pipe(readError(input, "workspaceFileSystem.makeDirectory"));
    yield* fileSystem
      .writeFile(target.absolutePath, contents)
      .pipe(readError(input, "workspaceFileSystem.writeFile"));
    yield* workspaceEntries.invalidate(input.cwd);
    return {
      kind: "written",
      relativePath: target.relativePath,
      contentHash: sha256Hex(contents),
    } satisfies ProjectWriteFileResult;
  }, writeLock.withPermits(1));

  const restoreOriginal: WorkspaceFileSystemShape["restoreOriginal"] = Effect.fn(
    "WorkspaceFileSystem.restoreOriginal",
  )(function* (input) {
    const target = yield* resolveTarget(input);
    const unavailable = {
      kind: "unavailable",
      relativePath: target.relativePath,
    } satisfies ProjectRestoreOriginalResult;
    if (target.inside || target.realPath === null) return unavailable;
    const realPath = target.realPath;
    // Keyed by the resolved file: a symlink retargeted since the save finds
    // nothing here, so one file's original never lands in another.
    const original = yield* originals
      .read(realPath)
      .pipe(readError(input, "workspaceFileSystem.readOriginal"));
    if (original === null) return unavailable;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const { file, current } = yield* openForChange(input, realPath);
        if (sha256Hex(current) !== input.expectedContentHash) {
          return conflictWith(target.relativePath, current);
        }
        yield* replaceOpenFile(file, original.bytes).pipe(
          readError(input, "workspaceFileSystem.restoreOriginal"),
        );
        // Let the kept copy go only once the original is back on disk.
        yield* originals.discard(realPath).pipe(Effect.ignore);
        return {
          kind: "restored",
          relativePath: target.relativePath,
          content: decodeText(original.bytes),
          contentHash: sha256Hex(original.bytes),
          size: original.bytes.length,
        } satisfies ProjectRestoreOriginalResult;
      }),
    );
  }, writeLock.withPermits(1));

  /** Why a whole text file can't be edited here, if it can't. */
  const editBlockFor = Effect.fn("WorkspaceFileSystem.editBlockFor")(function* (
    realPath: string,
    bytes: Uint8Array,
  ) {
    if (!roundTripsAsUtf8(bytes)) return "encoding" as const;
    const writable = yield* fileSystem.access(realPath, { writable: true }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    return writable ? undefined : ("read-only" as const);
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* resolveTarget(input);
      const missing = {
        kind: "missing",
        relativePath: target.relativePath,
      } satisfies ProjectReadFileResult;
      if (target.realPath === null) return missing;
      const realPath = target.realPath;
      const binary = (size: number) =>
        ({
          kind: "binary",
          relativePath: target.relativePath,
          size,
        }) satisfies ProjectReadFileResult;

      // Same NotFound handling as above: the file can vanish between the
      // realpath resolution and this stat under concurrent deletes.
      const targetStat = yield* fileSystem.stat(realPath).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
        readError(input, "workspaceFileSystem.statFile"),
      );
      if (targetStat === null) return missing;
      if (targetStat.type !== "File") {
        return yield* refuse(
          input,
          "workspaceFileSystem.readFile",
          `Cannot read entry of type '${targetStat.type}' as a file.`,
        );
      }
      const size = Number(targetStat.size);
      const extension = path.extname(target.absolutePath).toLowerCase();

      if (extension === PDF_EXTENSION && input.documents === true) {
        if (size > WORKSPACE_DOCUMENT_READ_MAX_BYTES) return binary(size);
        // The cap holds while reading too: the file can grow after the stat.
        const bytes = yield* readFilePrefix(realPath, WORKSPACE_DOCUMENT_READ_MAX_BYTES + 1).pipe(
          readError(input, "workspaceFileSystem.readDocument"),
        );
        if (
          bytes.length > WORKSPACE_DOCUMENT_READ_MAX_BYTES ||
          !bytes.subarray(0, 5).equals(PDF_MAGIC)
        ) {
          return binary(bytes.length);
        }
        return {
          kind: "document",
          relativePath: target.relativePath,
          mimeType: "application/pdf",
          base64: bytes.toString("base64"),
          size: bytes.length,
        } satisfies ProjectReadFileResult;
      }

      const wantsSource = input.as === "text" && extension === SVG_EXTENSION;
      if (SAFE_IMAGE_FILE_EXTENSIONS.has(extension) && !wantsSource) {
        if (size > WORKSPACE_IMAGE_READ_MAX_BYTES) return binary(size);
        const bytes = yield* readFilePrefix(realPath, WORKSPACE_IMAGE_READ_MAX_BYTES + 1).pipe(
          readError(input, "workspaceFileSystem.readImage"),
        );
        if (bytes.length > WORKSPACE_IMAGE_READ_MAX_BYTES) return binary(bytes.length);
        // A project file is trusted by its extension. From anywhere else only
        // bytes that really are a picture are served as one; a renamed script
        // falls through and reads as the text it is.
        const mimeType = target.inside
          ? (IMAGE_MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream")
          : (detectRasterImageMimeType(bytes) ??
            (extension === SVG_EXTENSION && looksLikeSvg(bytes) ? "image/svg+xml" : null));
        if (mimeType !== null) {
          return {
            kind: "image",
            relativePath: target.relativePath,
            mimeType,
            base64: bytes.toString("base64"),
            size: bytes.length,
          } satisfies ProjectReadFileResult;
        }
      }

      const prefix = yield* readFilePrefix(realPath, WORKSPACE_TEXT_READ_MAX_BYTES).pipe(
        readError(input, "workspaceFileSystem.readText"),
      );
      if (prefix.includes(0)) return binary(size);
      const truncated = size > prefix.length;
      // A truncated file is never editable, so it needs no reason.
      const editBlock = truncated ? undefined : yield* editBlockFor(realPath, prefix);
      const originalSavedAt = target.inside
        ? null
        : yield* originals.savedAt(realPath).pipe(Effect.catch(() => Effect.succeed(null)));
      return {
        kind: "text",
        relativePath: target.relativePath,
        content: decodeText(prefix),
        size,
        truncated,
        contentHash: sha256Hex(prefix),
        ...(editBlock !== undefined ? { editBlock } : {}),
        ...(originalSavedAt !== null ? { original: { savedAt: originalSavedAt } } : {}),
      } satisfies ProjectReadFileResult;
    },
  );

  return { readFile, writeFile, restoreOriginal } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
