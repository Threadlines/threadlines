import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProjectReadFileResult, ProjectWriteFileResult } from "@threadlines/contracts";

import { IMAGE_MIME_TYPE_BY_EXTENSION, SAFE_IMAGE_FILE_EXTENSIONS } from "../../imageMime.ts";
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readError = (input: { cwd: string; relativePath: string }, operation: string) =>
    Effect.mapError(
      (cause: { readonly message: string }) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation,
          detail: cause.message,
          cause,
        }),
    );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    // Optimistic-concurrency check: refuse to clobber content another writer
    // (typically an agent) changed since the caller's baseline read. A file
    // that vanished entirely is NOT a conflict — the caller is actively
    // editing it, so the write simply recreates it.
    if (input.expectedContentHash !== undefined) {
      const currentBytes = yield* fileSystem.readFile(target.absolutePath).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
        readError(input, "workspaceFileSystem.readForConflictCheck"),
      );
      if (currentBytes !== null) {
        const currentHash = sha256Hex(currentBytes);
        if (currentHash !== input.expectedContentHash) {
          return {
            kind: "conflict",
            relativePath: target.relativePath,
            content: new TextDecoder().decode(currentBytes),
            contentHash: currentHash,
            size: currentBytes.length,
          } satisfies ProjectWriteFileResult;
        }
      }
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return {
      kind: "written",
      relativePath: target.relativePath,
      contentHash: sha256Hex(Buffer.from(input.contents, "utf8")),
    } satisfies ProjectWriteFileResult;
  });

  const readFilePrefix = (absolutePath: string, maxBytes: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(absolutePath);
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
      }),
    );

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      // Lexical checks above cannot see symlinks; compare real paths so reads
      // never follow a link out of the workspace root.
      const rootRealPath = yield* fileSystem
        .realPath(input.cwd)
        .pipe(readError(input, "workspaceFileSystem.resolveRootRealPath"));
      // A vanished target is an expected state, not an IO fault: agents
      // delete and rename files while chat references keep pointing at the
      // old path. Report it as a `missing` result so clients don't retry.
      const targetRealPath = yield* fileSystem.realPath(target.absolutePath).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
        readError(input, "workspaceFileSystem.resolveTargetRealPath"),
      );
      if (targetRealPath === null) {
        return {
          kind: "missing",
          relativePath: target.relativePath,
        } satisfies ProjectReadFileResult;
      }
      const realRelativePath = path.relative(rootRealPath, targetRealPath);
      if (
        realRelativePath.length === 0 ||
        realRelativePath === ".." ||
        realRelativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelativePath)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
      }

      // Same NotFound handling as above: the file can vanish between the
      // realpath resolution and this stat under concurrent deletes.
      const targetStat = yield* fileSystem.stat(targetRealPath).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
        readError(input, "workspaceFileSystem.statFile"),
      );
      if (targetStat === null) {
        return {
          kind: "missing",
          relativePath: target.relativePath,
        } satisfies ProjectReadFileResult;
      }
      if (targetStat.type !== "File") {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: `Cannot read entry of type '${targetStat.type}' as a file.`,
        });
      }
      const size = Number(targetStat.size);

      const extension = path.extname(target.relativePath).toLowerCase();
      if (SAFE_IMAGE_FILE_EXTENSIONS.has(extension)) {
        if (size > WORKSPACE_IMAGE_READ_MAX_BYTES) {
          return {
            kind: "binary",
            relativePath: target.relativePath,
            size,
          } satisfies ProjectReadFileResult;
        }
        const bytes = yield* fileSystem
          .readFile(targetRealPath)
          .pipe(readError(input, "workspaceFileSystem.readImage"));
        return {
          kind: "image",
          relativePath: target.relativePath,
          mimeType: IMAGE_MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream",
          base64: Buffer.from(bytes).toString("base64"),
          size,
        } satisfies ProjectReadFileResult;
      }

      const prefix = yield* readFilePrefix(targetRealPath, WORKSPACE_TEXT_READ_MAX_BYTES).pipe(
        readError(input, "workspaceFileSystem.readText"),
      );
      if (prefix.includes(0)) {
        return {
          kind: "binary",
          relativePath: target.relativePath,
          size,
        } satisfies ProjectReadFileResult;
      }
      return {
        kind: "text",
        relativePath: target.relativePath,
        content: new TextDecoder().decode(prefix),
        size,
        truncated: size > prefix.length,
        contentHash: sha256Hex(prefix),
      } satisfies ProjectReadFileResult;
    },
  );

  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
