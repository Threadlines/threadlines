import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProjectReadFileResult } from "@threadlines/contracts";

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

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

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
    return { relativePath: target.relativePath };
  });

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
      const targetRealPath = yield* fileSystem
        .realPath(target.absolutePath)
        .pipe(readError(input, "workspaceFileSystem.resolveTargetRealPath"));
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

      const targetStat = yield* fileSystem
        .stat(targetRealPath)
        .pipe(readError(input, "workspaceFileSystem.statFile"));
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
      } satisfies ProjectReadFileResult;
    },
  );

  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
