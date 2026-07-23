// @effect-diagnostics nodeBuiltinImport:off
import { constants as NodeFsConstants } from "node:fs";
import * as NodeFs from "node:fs/promises";
import NodePath from "node:path";

import {
  CodexInlineVisualizationReadError,
  type CodexInlineVisualizationReadResult,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MAX_CODEX_INLINE_VISUALIZATION_BYTES = 5_000_000;

const CODEX_INLINE_VISUALIZATION_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isReadError = Schema.is(CodexInlineVisualizationReadError);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Codex shards visualizations using the UUIDv7 timestamp in local time. */
export function codexVisualizationDateShard(providerThreadId: string): string | null {
  if (!UUID_V7.test(providerThreadId)) {
    return null;
  }

  const timestampHex = `${providerThreadId.slice(0, 8)}${providerThreadId.slice(9, 13)}`;
  const timestampMs = Number.parseInt(timestampHex, 16);
  const timestamp = new Date(timestampMs);
  if (!Number.isFinite(timestampMs) || Number.isNaN(timestamp.getTime())) {
    return null;
  }

  const year = String(timestamp.getFullYear()).padStart(4, "0");
  const month = String(timestamp.getMonth() + 1).padStart(2, "0");
  const day = String(timestamp.getDate()).padStart(2, "0");
  return NodePath.join(year, month, day);
}

function readError(message: string, cause?: unknown): CodexInlineVisualizationReadError {
  return new CodexInlineVisualizationReadError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const readCodexInlineVisualization = Effect.fn("CodexInlineVisualization.read")(
  function* (input: {
    readonly codexHomePath: string;
    readonly providerThreadId: string;
    readonly file: string;
  }): Effect.fn.Return<CodexInlineVisualizationReadResult, CodexInlineVisualizationReadError> {
    if (!CODEX_INLINE_VISUALIZATION_FILE_NAME.test(input.file)) {
      return yield* readError("The visualization filename is invalid.");
    }

    const dateShard = codexVisualizationDateShard(input.providerThreadId);
    if (!dateShard) {
      return yield* readError("This Codex thread cannot be mapped to a visualization directory.");
    }

    const filePath = NodePath.join(
      input.codexHomePath,
      "visualizations",
      dateShard,
      input.providerThreadId,
      input.file,
    );

    return yield* Effect.tryPromise({
      try: async () => {
        const linkInfo = await NodeFs.lstat(filePath);
        if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
          throw readError("The visualization is not a regular file.");
        }
        if (linkInfo.size > MAX_CODEX_INLINE_VISUALIZATION_BYTES) {
          throw readError("The visualization is too large to display.");
        }

        const noFollow = NodeFsConstants.O_NOFOLLOW ?? 0;
        const handle = await NodeFs.open(filePath, NodeFsConstants.O_RDONLY | noFollow);
        try {
          const openedInfo = await handle.stat();
          if (
            !openedInfo.isFile() ||
            openedInfo.dev !== linkInfo.dev ||
            openedInfo.ino !== linkInfo.ino
          ) {
            throw readError("The visualization changed while it was being opened.");
          }
          if (openedInfo.size > MAX_CODEX_INLINE_VISUALIZATION_BYTES) {
            throw readError("The visualization is too large to display.");
          }
          const bytes = await handle.readFile();
          if (bytes.byteLength > MAX_CODEX_INLINE_VISUALIZATION_BYTES) {
            throw readError("The visualization is too large to display.");
          }
          return {
            file: input.file,
            contents: textDecoder.decode(bytes),
            sizeBytes: bytes.byteLength,
          };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        isReadError(cause)
          ? cause
          : readError("The visualization could not be read for this Codex thread.", cause),
    });
  },
);
