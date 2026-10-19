import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Our own folder from before the rename. Not T3 Code's `~/.t3`: that is
// another app's live data, and its database shares our first migration ids but
// not the later ones, so a copy left Threadlines unable to start.
const BADCODE_BASE_DIR_NAME = ".badcode";

export type DesktopDataMigrationStatus =
  | "migrated"
  | "skipped-custom-base-dir"
  | "skipped-missing-legacy-dir"
  | "skipped-empty-legacy-dir"
  | "skipped-existing-threadlines-dir";

export interface DesktopDataMigrationShape {
  readonly status: DesktopDataMigrationStatus;
}

export class DesktopDataMigration extends Context.Service<
  DesktopDataMigration,
  DesktopDataMigrationShape
>()("threadlines/desktop/DataMigration") {}

export class DesktopDataMigrationError extends Data.TaggedError("DesktopDataMigrationError")<{
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly cause: PlatformError.PlatformError;
}> {
  override get message() {
    return `Failed to migrate desktop data from ${this.sourcePath} to ${this.targetPath}: ${this.cause.message}`;
  }
}

const hasDirectoryEntries = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<boolean> =>
  fileSystem.readDirectory(directory).pipe(
    Effect.map((entries) => entries.length > 0),
    Effect.orElseSucceed(() => false),
  );

export const migrateLegacyDesktopData = Effect.fn("desktop.dataMigration.legacyBadcode")(
  function* (): Effect.fn.Return<
    DesktopDataMigrationStatus,
    DesktopDataMigrationError,
    DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | Path.Path
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (!DesktopEnvironment.usesDefaultBaseDir(environment)) {
      return "skipped-custom-base-dir";
    }

    const legacyBaseDir = path.join(environment.homeDirectory, BADCODE_BASE_DIR_NAME);
    if (!(yield* hasDirectoryEntries(fileSystem, legacyBaseDir))) {
      const legacyExists = yield* fileSystem
        .exists(legacyBaseDir)
        .pipe(Effect.orElseSucceed(() => false));
      return legacyExists ? "skipped-empty-legacy-dir" : "skipped-missing-legacy-dir";
    }

    const threadlinesExists = yield* fileSystem
      .exists(environment.baseDir)
      .pipe(Effect.orElseSucceed(() => false));
    if (threadlinesExists) {
      const threadlinesHasEntries = yield* hasDirectoryEntries(fileSystem, environment.baseDir);
      if (threadlinesHasEntries) {
        return "skipped-existing-threadlines-dir";
      }
      yield* fileSystem.remove(environment.baseDir, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopDataMigrationError({
              sourcePath: legacyBaseDir,
              targetPath: environment.baseDir,
              cause,
            }),
        ),
      );
    }

    yield* fileSystem.copy(legacyBaseDir, environment.baseDir, { preserveTimestamps: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopDataMigrationError({
            sourcePath: legacyBaseDir,
            targetPath: environment.baseDir,
            cause,
          }),
      ),
    );

    return "migrated";
  },
);

export const layer = Layer.effect(
  DesktopDataMigration,
  migrateLegacyDesktopData().pipe(Effect.map((status) => DesktopDataMigration.of({ status }))),
);
