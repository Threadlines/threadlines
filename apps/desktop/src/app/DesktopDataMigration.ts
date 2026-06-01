import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const BADCODE_BASE_DIR_NAME = ".badcode";
const LEGACY_T3CODE_BASE_DIR_NAME = ".t3";

export type DesktopDataMigrationStatus =
  | "migrated"
  | "skipped-custom-base-dir"
  | "skipped-missing-legacy-dir"
  | "skipped-empty-legacy-dir"
  | "skipped-existing-badcode-dir";

export interface DesktopDataMigrationShape {
  readonly status: DesktopDataMigrationStatus;
}

export class DesktopDataMigration extends Context.Service<
  DesktopDataMigration,
  DesktopDataMigrationShape
>()("t3/desktop/DataMigration") {}

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

export const migrateLegacyDesktopData = Effect.fn("desktop.dataMigration.legacyT3Code")(
  function* (): Effect.fn.Return<
    DesktopDataMigrationStatus,
    DesktopDataMigrationError,
    DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | Path.Path
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const defaultBadCodeBaseDir = path.join(environment.homeDirectory, BADCODE_BASE_DIR_NAME);

    if (path.resolve(environment.baseDir) !== path.resolve(defaultBadCodeBaseDir)) {
      return "skipped-custom-base-dir";
    }

    const legacyBaseDir = path.join(environment.homeDirectory, LEGACY_T3CODE_BASE_DIR_NAME);
    const legacyHasEntries = yield* hasDirectoryEntries(fileSystem, legacyBaseDir);
    if (!legacyHasEntries) {
      const legacyExists = yield* fileSystem
        .exists(legacyBaseDir)
        .pipe(Effect.orElseSucceed(() => false));
      return legacyExists ? "skipped-empty-legacy-dir" : "skipped-missing-legacy-dir";
    }

    const badCodeExists = yield* fileSystem
      .exists(environment.baseDir)
      .pipe(Effect.orElseSucceed(() => false));
    if (badCodeExists) {
      const badCodeHasEntries = yield* hasDirectoryEntries(fileSystem, environment.baseDir);
      if (badCodeHasEntries) {
        return "skipped-existing-badcode-dir";
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
