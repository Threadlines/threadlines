import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";

import type { DesktopStartupFailureReport } from "../app/DesktopCrashReport.ts";
import * as DesktopDatabaseRecovery from "./DesktopDatabaseRecovery.ts";

const report = (outputTail: string): DesktopStartupFailureReport => ({
  failureKind: "process-exit",
  attempts: 3,
  lastExitCode: Option.some(1),
  lastReason: "code=1",
  outputTail,
});

const recoveryDirectoryName = `database-${"1".repeat(32)}`;
const databaseFiles = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"] as const;

function pendingRecoveryDocument(
  files: ReadonlyArray<{ readonly name: string; readonly size: string }>,
) {
  return `${JSON.stringify({ version: 1, recoveryDirectoryName, files })}\n`;
}

describe("DesktopDatabaseRecovery", () => {
  it("recognizes only canonical SQLite corruption errors", () => {
    assert.isTrue(
      DesktopDatabaseRecovery.isDefinitiveSqliteCorruption(
        report(
          "effect/sql/SqlError: Failed to prepare statement\n[cause]: Error: file is not a database",
        ),
      ),
    );
    assert.isTrue(
      DesktopDatabaseRecovery.isDefinitiveSqliteCorruption(
        report("node:sqlite failed: database disk image is malformed"),
      ),
    );
    assert.isTrue(
      DesktopDatabaseRecovery.isDefinitiveSqliteCorruption(
        report("SqlError: operation failed with code SQLITE_CORRUPT"),
      ),
    );

    for (const ambiguousFailure of [
      "database corruption check passed",
      "No file is not a database errors were found",
      "The help page mentions: file is not a database",
      "SqlError: database is locked",
      "SqlError: attempt to write a readonly database",
      "SqlError: disk I/O error",
      "SqlError: ENOSPC: no space left on device",
      "SqlError: EACCES opening state.sqlite",
    ]) {
      assert.isFalse(
        DesktopDatabaseRecovery.isDefinitiveSqliteCorruption(report(ambiguousFailure)),
      );
    }
    assert.isFalse(
      DesktopDatabaseRecovery.isDefinitiveSqliteCorruption({
        ...report("node:sqlite failed: database disk image is malformed"),
        failureKind: "readiness-timeout",
      }),
    );
  });

  it.effect("preserves and flushes the database and both sidecars before fresh startup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-database-recovery-",
      });
      for (const fileName of databaseFiles) {
        yield* fileSystem.writeFileString(path.join(stateDir, fileName), `contents:${fileName}`);
      }
      yield* fileSystem.writeFileString(path.join(stateDir, "settings.json"), "keep me");

      const recovery = yield* DesktopDatabaseRecovery.recoverCorruptDesktopDatabase({
        stateDir,
        report: report(
          "effect/sql/SqlError: Failed to prepare statement\n[cause]: Error: file is not a database",
        ),
      });
      const recovered = Option.getOrUndefined(recovery);
      assert.isDefined(recovered);
      assert.sameMembers([...recovered.preservedFiles], [...databaseFiles]);

      for (const fileName of databaseFiles) {
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, fileName)));
        assert.equal(
          yield* fileSystem.readFileString(path.join(recovered.backupDir, fileName)),
          `contents:${fileName}`,
        );
      }
      assert.isFalse(
        yield* fileSystem.exists(
          path.join(stateDir, DesktopDatabaseRecovery.DATABASE_RECOVERY_PENDING_FILE_NAME),
        ),
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(stateDir, "settings.json")),
        "keep me",
      );
      assert.include(
        yield* fileSystem.readFileString(path.join(recovered.backupDir, "recovery.json")),
        "SQLite reported as corrupt",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does nothing when the database is absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-database-recovery-empty-",
      });
      const recovery = yield* DesktopDatabaseRecovery.recoverCorruptDesktopDatabase({
        stateDir,
        report: report("SqlError in node:sqlite: file is not a database"),
      });
      assert.isTrue(Option.isNone(recovery));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves every original in place when copying fails before the durable marker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-database-recovery-copy-failure-",
      });
      for (const fileName of databaseFiles) {
        yield* fileSystem.writeFileString(path.join(stateDir, fileName), `contents:${fileName}`);
      }
      const failingFileSystem = FileSystem.make({
        ...fileSystem,
        copyFile: (source) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "copyFile",
              pathOrDescriptor: source,
              description: "backup destination was unavailable",
            }),
          ),
      });

      const recovery = yield* Effect.result(
        DesktopDatabaseRecovery.recoverCorruptDesktopDatabase({
          stateDir,
          report: report("[cause]: Error: file is not a database"),
        }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem)),
      );

      assert.isTrue(Result.isFailure(recovery));
      for (const fileName of databaseFiles) {
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, fileName)),
          `contents:${fileName}`,
        );
      }
      assert.isFalse(
        yield* fileSystem.exists(
          path.join(stateDir, DesktopDatabaseRecovery.DATABASE_RECOVERY_PENDING_FILE_NAME),
        ),
      );
      assert.deepEqual(
        yield* fileSystem
          .readDirectory(path.join(stateDir, "recovery"))
          .pipe(Effect.orElseSucceed(() => [])),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes an interrupted removal before the backend can open SQLite", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-database-recovery-resume-",
      });
      const backupDir = path.join(stateDir, "recovery", recoveryDirectoryName);
      yield* fileSystem.makeDirectory(backupDir, { recursive: true });
      const markerFiles = [];
      for (const fileName of databaseFiles) {
        const contents = `contents:${fileName}`;
        markerFiles.push({ name: fileName, size: String(contents.length) });
        yield* fileSystem.writeFileString(path.join(stateDir, fileName), contents);
        yield* fileSystem.writeFileString(path.join(backupDir, fileName), contents);
      }
      const pendingPath = path.join(
        stateDir,
        DesktopDatabaseRecovery.DATABASE_RECOVERY_PENDING_FILE_NAME,
      );
      yield* fileSystem.writeFileString(pendingPath, pendingRecoveryDocument(markerFiles));
      // Simulate power loss after one original was already removed.
      yield* fileSystem.remove(path.join(stateDir, "state.sqlite-wal"));

      const recovery = yield* DesktopDatabaseRecovery.completePendingDesktopDatabaseRecovery({
        stateDir,
      });
      const recovered = Option.getOrUndefined(recovery);
      assert.isDefined(recovered);
      assert.equal(recovered.backupDir, backupDir);
      for (const fileName of databaseFiles) {
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, fileName)));
        assert.isTrue(yield* fileSystem.exists(path.join(backupDir, fileName)));
      }
      assert.isFalse(yield* fileSystem.exists(pendingPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps originals and the marker when a preserved copy cannot be verified", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-database-recovery-invalid-backup-",
      });
      const backupDir = path.join(stateDir, "recovery", recoveryDirectoryName);
      yield* fileSystem.makeDirectory(backupDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(stateDir, "state.sqlite"), "original");
      yield* fileSystem.writeFileString(path.join(backupDir, "state.sqlite"), "short");
      const pendingPath = path.join(
        stateDir,
        DesktopDatabaseRecovery.DATABASE_RECOVERY_PENDING_FILE_NAME,
      );
      yield* fileSystem.writeFileString(
        pendingPath,
        pendingRecoveryDocument([{ name: "state.sqlite", size: "999" }]),
      );

      const recovery = yield* Effect.result(
        DesktopDatabaseRecovery.completePendingDesktopDatabaseRecovery({ stateDir }),
      );

      assert.isTrue(Result.isFailure(recovery));
      assert.equal(
        yield* fileSystem.readFileString(path.join(stateDir, "state.sqlite")),
        "original",
      );
      assert.isTrue(yield* fileSystem.exists(pendingPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the marker and safely retries after a Windows-style database lock", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-database-recovery-lock-",
      });
      const databasePath = path.join(stateDir, "state.sqlite");
      const backupDir = path.join(stateDir, "recovery", recoveryDirectoryName);
      yield* fileSystem.makeDirectory(backupDir, { recursive: true });
      yield* fileSystem.writeFileString(databasePath, "database");
      yield* fileSystem.writeFileString(path.join(backupDir, "state.sqlite"), "database");
      const pendingPath = path.join(
        stateDir,
        DesktopDatabaseRecovery.DATABASE_RECOVERY_PENDING_FILE_NAME,
      );
      yield* fileSystem.writeFileString(
        pendingPath,
        pendingRecoveryDocument([{ name: "state.sqlite", size: "8" }]),
      );
      const lockedFileSystem = FileSystem.make({
        ...fileSystem,
        remove: (filePath, options) =>
          filePath === databasePath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: filePath,
                  description: "the process cannot access the file because it is in use",
                }),
              )
            : fileSystem.remove(filePath, options),
      });

      const lockedAttempt = yield* Effect.result(
        DesktopDatabaseRecovery.completePendingDesktopDatabaseRecovery({ stateDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, lockedFileSystem),
        ),
      );
      assert.isTrue(Result.isFailure(lockedAttempt));
      assert.isTrue(yield* fileSystem.exists(databasePath));
      assert.isTrue(yield* fileSystem.exists(pendingPath));

      const retry = yield* DesktopDatabaseRecovery.completePendingDesktopDatabaseRecovery({
        stateDir,
      });
      assert.isTrue(Option.isSome(retry));
      assert.isFalse(yield* fileSystem.exists(databasePath));
      assert.isFalse(yield* fileSystem.exists(pendingPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
