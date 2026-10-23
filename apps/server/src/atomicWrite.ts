import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

/**
 * Replaces `filePath` with `contents` in one step: readers see the old file or
 * the new one, never a part. `mode` sets the new file's permissions (0o600
 * for a secret).
 */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* randomUUIDv4;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      yield* fs.writeFileString(
        tempPath,
        input.contents,
        input.mode === undefined ? undefined : { mode: input.mode },
      );
      // Windows readers and virus scanners can briefly block replacement.
      // Retry the rename while keeping both the old file and completed temp file.
      yield* fs.rename(tempPath, input.filePath).pipe(
        Effect.retry({
          times: 10,
          schedule: Schedule.spaced("50 millis"),
          while: (error) => {
            const cause = error.cause;
            return (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              (cause.code === "EPERM" || cause.code === "EACCES" || cause.code === "EBUSY")
            );
          },
        }),
      );
    }),
  );
