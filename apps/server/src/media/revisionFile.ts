/**
 * Reads one file of a past revision (a turn's snapshot, or the last commit)
 * as the client's picture reads come back: the picture's bytes, `binary` for
 * anything that is not a picture or is too big to send, `missing` when that
 * revision has no file there. Snapshot content comes out of the project's own
 * repository, so a picture is trusted by its extension, as project files are.
 */
import { type CheckpointRef, type ProjectRevisionFileResult } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import type { CheckpointStoreShape } from "../checkpointing/Services/CheckpointStore.ts";
import { IMAGE_MIME_TYPE_BY_EXTENSION, SAFE_IMAGE_FILE_EXTENSIONS } from "../imageMime.ts";
import { WORKSPACE_IMAGE_READ_MAX_BYTES } from "../workspace/Layers/WorkspaceFileSystem.ts";

/** The lowercase extension of a path's last segment, with its dot. */
export function pathExtension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export const readRevisionFileResult = Effect.fn("media.readRevisionFileResult")(function* (input: {
  readonly checkpointStore: CheckpointStoreShape;
  readonly cwd: string;
  readonly revision: CheckpointRef | "HEAD";
  /** Repository-root-relative. */
  readonly path: string;
  /** What the result calls the file; the requested path, when a rename moved it. */
  readonly displayPath?: string;
}) {
  const relativePath = input.displayPath ?? input.path;
  const extension = pathExtension(input.path);
  const isPicture = SAFE_IMAGE_FILE_EXTENSIONS.has(extension);
  // Anything but a picture is only ever told apart from a missing file, so
  // its bytes are never read.
  const file = yield* input.checkpointStore.readRevisionFile({
    cwd: input.cwd,
    revision: input.revision,
    path: input.path,
    maxBytes: isPicture ? WORKSPACE_IMAGE_READ_MAX_BYTES : 0,
  });
  if (file.kind === "missing") {
    return { kind: "missing", relativePath } satisfies ProjectRevisionFileResult;
  }
  if (file.kind === "too-large" || !isPicture) {
    return { kind: "binary", relativePath, size: file.size } satisfies ProjectRevisionFileResult;
  }
  return {
    kind: "image",
    relativePath,
    mimeType: IMAGE_MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream",
    base64: file.base64,
    size: file.size,
  } satisfies ProjectRevisionFileResult;
});
