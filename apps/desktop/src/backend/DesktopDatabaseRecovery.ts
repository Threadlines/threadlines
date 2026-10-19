/**
 * DesktopDatabaseRecovery - narrowly repairs a backend blocked by its state
 * database: one SQLite reports as damaged, or another app's database (T3 Code's,
 * copied in by earlier versions) that the server refused to upgrade.
 *
 * Recovery is a small crash-resumable transaction. The stopped database and
 * its WAL sidecars are copied and flushed first. A durable marker is then
 * written before any originals are removed. If the app or machine stops in
 * that second phase, the next desktop startup finishes it before spawning the
 * backend, so SQLite never opens a half-recovered database. Atomic rename and
 * ordering of the marker's directory entry rely on the host filesystem's
 * journaling guarantees (NTFS on supported Windows installations).
 */

import { FOREIGN_DATABASE_EXIT_CODE } from "@threadlines/contracts";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopCrashReport from "../app/DesktopCrashReport.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const DATABASE_FILE_NAME = "state.sqlite";
const DATABASE_FILE_NAMES = [
  DATABASE_FILE_NAME,
  `${DATABASE_FILE_NAME}-wal`,
  `${DATABASE_FILE_NAME}-shm`,
] as const;
const RECOVERY_DIRECTORY_NAME = "recovery";
export const DATABASE_RECOVERY_PENDING_FILE_NAME = "database-recovery-pending.json";

const SQLITE_CORRUPTION_MESSAGES = [
  "database disk image is malformed",
  "database schema is corrupt",
  "file is not a database",
  "malformed database schema",
] as const;
const SQLITE_CORRUPTION_CODE = /\bsqlite_(?:corrupt|notadb)(?:_[a-z0-9_]+)?\b/i;
const SQLITE_ERROR_CONTEXT =
  /(?:\[(?:cause|error)\]|\b(?:error|sqlerror|sqliteerror|node:sqlite)\b)/i;

/** Why a database was set aside: SQLite called it damaged, or another app made it. */
const DesktopDatabaseRecoveryReason = Schema.Literals(["corrupt", "foreign"]);
export type DesktopDatabaseRecoveryReason = typeof DesktopDatabaseRecoveryReason.Type;

const PendingRecoveryFile = Schema.Struct({
  name: Schema.Literals(DATABASE_FILE_NAMES),
  size: Schema.String,
});
const PendingRecoveryMarker = Schema.Struct({
  version: Schema.Literal(1),
  recoveryDirectoryName: Schema.String,
  files: Schema.Array(PendingRecoveryFile),
  // Absent from markers written before foreign databases were recovered.
  reason: Schema.optional(DesktopDatabaseRecoveryReason),
});
type PendingRecoveryMarker = typeof PendingRecoveryMarker.Type;

const encodePendingRecoveryMarker = Schema.encodeEffect(
  Schema.fromJsonString(PendingRecoveryMarker),
);
const decodePendingRecoveryMarker = Schema.decodeEffect(
  Schema.fromJsonString(PendingRecoveryMarker),
);

class DesktopDatabaseRecoveryProtocolError extends Data.TaggedError(
  "DesktopDatabaseRecoveryProtocolError",
)<{
  readonly detail: string;
}> {
  override get message() {
    return this.detail;
  }
}

export interface DesktopDatabaseRecoveryResult {
  readonly reason: DesktopDatabaseRecoveryReason;
  readonly backupDir: string;
  readonly databasePath: string;
  readonly preservedFiles: readonly string[];
}

export class DesktopDatabaseRecoveryError extends Data.TaggedError("DesktopDatabaseRecoveryError")<{
  readonly backupDir: string;
  readonly cause: { readonly message: string };
}> {
  override get message() {
    return `Could not safely recover the local database. Threadlines did not start with a partly recovered database. Preserved files, when available, are in ${this.backupDir}. Cause: ${this.cause.message}`;
  }
}

export interface DesktopDatabaseRecoveryShape {
  /** Finishes a recovery interrupted after its durable marker was written. */
  readonly completePendingRecovery: Effect.Effect<
    Option.Option<DesktopDatabaseRecoveryResult>,
    DesktopDatabaseRecoveryError
  >;
  /**
   * Returns Some only after the database that blocked startup has been safely
   * preserved, so the backend can start fresh.
   */
  readonly recover: (
    report: DesktopCrashReport.DesktopStartupFailureReport,
  ) => Effect.Effect<Option.Option<DesktopDatabaseRecoveryResult>, DesktopDatabaseRecoveryError>;
}

export class DesktopDatabaseRecovery extends Context.Service<
  DesktopDatabaseRecovery,
  DesktopDatabaseRecoveryShape
>()("threadlines/desktop/DatabaseRecovery") {}

export function isDefinitiveSqliteCorruption(
  report: DesktopCrashReport.DesktopStartupFailureReport,
): boolean {
  if (report.failureKind !== "process-exit") {
    return false;
  }

  return `${report.lastReason}\n${report.outputTail}`.split(/\r?\n/).some((line) => {
    if (!SQLITE_ERROR_CONTEXT.test(line)) {
      return false;
    }
    const lowerLine = line.toLowerCase();
    return (
      SQLITE_CORRUPTION_CODE.test(line) ||
      SQLITE_CORRUPTION_MESSAGES.some((message) => lowerLine.includes(message))
    );
  });
}

/** The server stopped because its database was made by another app. */
export function isForeignDatabaseExit(
  report: DesktopCrashReport.DesktopStartupFailureReport,
): boolean {
  return (
    report.failureKind === "process-exit" &&
    Option.contains(report.lastExitCode, FOREIGN_DATABASE_EXIT_CODE)
  );
}

/** Why setting the database aside would let this failed startup succeed, if it would. */
export function databaseRecoveryReason(
  report: DesktopCrashReport.DesktopStartupFailureReport,
): Option.Option<DesktopDatabaseRecoveryReason> {
  if (isDefinitiveSqliteCorruption(report)) return Option.some("corrupt");
  if (isForeignDatabaseExit(report)) return Option.some("foreign");
  return Option.none();
}

const RECOVERY_REASON_TEXT: Record<DesktopDatabaseRecoveryReason, string> = {
  corrupt: "Threadlines preserved a database that SQLite reported as corrupt.",
  foreign:
    "Threadlines set aside a database made by another app (most likely a copy of T3 Code's), which it refused to upgrade.",
};

const syncFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  // Windows requires a writable handle for FlushFileBuffers/fsync.
  fileSystem.open(filePath, { flag: "r+" }).pipe(
    Effect.flatMap((file) => file.sync),
    Effect.scoped,
  );

function validatePendingRecoveryMarker(
  marker: PendingRecoveryMarker,
): Effect.Effect<PendingRecoveryMarker, DesktopDatabaseRecoveryProtocolError> {
  const names = marker.files.map(({ name }) => name);
  const validDirectoryName = /^database-[0-9a-f]{32}$/.test(marker.recoveryDirectoryName);
  const validFiles =
    names.includes(DATABASE_FILE_NAME) &&
    new Set(names).size === names.length &&
    marker.files.every(({ size }) => /^\d+$/.test(size));

  return validDirectoryName && validFiles
    ? Effect.succeed(marker)
    : Effect.fail(
        new DesktopDatabaseRecoveryProtocolError({
          detail: "The pending database recovery marker is invalid.",
        }),
      );
}

export const completePendingDesktopDatabaseRecovery = Effect.fn(
  "desktop.databaseRecovery.completePendingRecovery",
)(function* (input: {
  readonly stateDir: string;
}): Effect.fn.Return<
  Option.Option<DesktopDatabaseRecoveryResult>,
  DesktopDatabaseRecoveryError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pendingPath = path.join(input.stateDir, DATABASE_RECOVERY_PENDING_FILE_NAME);
  const databasePath = path.join(input.stateDir, DATABASE_FILE_NAME);
  let backupDir = path.join(input.stateDir, RECOVERY_DIRECTORY_NAME);

  const pendingExists = yield* fileSystem.exists(pendingPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopDatabaseRecoveryError({
          backupDir,
          cause,
        }),
    ),
  );
  if (!pendingExists) {
    return Option.none();
  }

  const complete = Effect.gen(function* () {
    const marker = yield* fileSystem
      .readFileString(pendingPath)
      .pipe(
        Effect.flatMap(decodePendingRecoveryMarker),
        Effect.flatMap(validatePendingRecoveryMarker),
      );
    backupDir = path.join(input.stateDir, RECOVERY_DIRECTORY_NAME, marker.recoveryDirectoryName);

    // The marker is trusted only after every declared backup still exists at
    // the exact size captured before the originals were touched.
    for (const file of marker.files) {
      const backupPath = path.join(backupDir, file.name);
      const backupStat = yield* fileSystem.stat(backupPath);
      if (String(backupStat.size) !== file.size) {
        return yield* new DesktopDatabaseRecoveryProtocolError({
          detail: `The preserved copy of ${file.name} does not match the pending recovery marker.`,
        });
      }
    }

    for (const file of marker.files) {
      yield* fileSystem.remove(path.join(input.stateDir, file.name), { force: true });
    }
    // Removing the marker commits the recovery. If this removal is
    // interrupted, the operation is safe and idempotent on the next launch.
    yield* fileSystem.remove(pendingPath);

    return Option.some({
      reason: marker.reason ?? "corrupt",
      backupDir,
      databasePath,
      preservedFiles: marker.files.map(({ name }) => name),
    });
  });

  return yield* complete.pipe(
    Effect.catch((cause) =>
      Effect.fail(
        new DesktopDatabaseRecoveryError({
          backupDir,
          cause,
        }),
      ),
    ),
  );
});

/**
 * Preserves the database that blocked startup and removes it so the backend
 * starts fresh. Another app's database is set aside only from a data folder
 * the desktop owns (`ownsDatabaseFolder`), never from one a user pointed at,
 * which may be that app's live folder.
 */
export const recoverDesktopDatabase = Effect.fn("desktop.databaseRecovery.recoverDatabase")(
  function* (input: {
    readonly stateDir: string;
    readonly report: DesktopCrashReport.DesktopStartupFailureReport;
    readonly ownsDatabaseFolder: boolean;
  }): Effect.fn.Return<
    Option.Option<DesktopDatabaseRecoveryResult>,
    DesktopDatabaseRecoveryError,
    FileSystem.FileSystem | Path.Path
  > {
    const reasonOption = databaseRecoveryReason(input.report);
    if (
      Option.isNone(reasonOption) ||
      (reasonOption.value === "foreign" && !input.ownsDatabaseFolder)
    ) {
      return Option.none();
    }
    const reason = reasonOption.value;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const databasePath = path.join(input.stateDir, DATABASE_FILE_NAME);
    const recoveryId = (yield* randomUUIDv4).replaceAll("-", "");
    const recoveryDirectoryName = `database-${recoveryId}`;
    const recoveryRoot = path.join(input.stateDir, RECOVERY_DIRECTORY_NAME);
    const partialBackupDir = path.join(recoveryRoot, `.${recoveryDirectoryName}.partial`);
    const backupDir = path.join(recoveryRoot, recoveryDirectoryName);
    const pendingPath = path.join(input.stateDir, DATABASE_RECOVERY_PENDING_FILE_NAME);
    const pendingTempPath = `${pendingPath}.${recoveryId}.tmp`;

    const recover = Effect.gen(function* () {
      if (!(yield* fileSystem.exists(databasePath))) {
        return Option.none<DesktopDatabaseRecoveryResult>();
      }
      if (yield* fileSystem.exists(pendingPath)) {
        return yield* new DesktopDatabaseRecoveryProtocolError({
          detail: "A previous database recovery must be completed first.",
        });
      }

      const existingFiles: Array<{
        readonly name: (typeof DATABASE_FILE_NAMES)[number];
        readonly size: string;
      }> = [];
      for (const name of DATABASE_FILE_NAMES) {
        const source = path.join(input.stateDir, name);
        if (yield* fileSystem.exists(source)) {
          const sourceStat = yield* fileSystem.stat(source);
          existingFiles.push({ name, size: String(sourceStat.size) });
        }
      }

      yield* fileSystem.makeDirectory(partialBackupDir, { recursive: true });
      for (const file of existingFiles) {
        const source = path.join(input.stateDir, file.name);
        const target = path.join(partialBackupDir, file.name);
        yield* fileSystem.copyFile(source, target);
        yield* syncFile(fileSystem, target);
        const [sourceStat, targetStat] = yield* Effect.all([
          fileSystem.stat(source),
          fileSystem.stat(target),
        ]);
        if (String(sourceStat.size) !== file.size || String(targetStat.size) !== file.size) {
          return yield* new DesktopDatabaseRecoveryProtocolError({
            detail: `${file.name} changed or its preserved copy was incomplete.`,
          });
        }
      }

      yield* fileSystem.writeFileString(
        path.join(partialBackupDir, "recovery.json"),
        `${JSON.stringify(
          {
            reason: RECOVERY_REASON_TEXT[reason],
            originalDatabasePath: databasePath,
            files: existingFiles,
          },
          null,
          2,
        )}\n`,
      );
      yield* syncFile(fileSystem, path.join(partialBackupDir, "recovery.json"));
      yield* fileSystem.rename(partialBackupDir, backupDir);

      const marker: PendingRecoveryMarker = {
        version: 1,
        recoveryDirectoryName,
        files: existingFiles,
        reason,
      };
      const encodedMarker = yield* encodePendingRecoveryMarker(marker);
      yield* fileSystem.writeFileString(pendingTempPath, `${encodedMarker}\n`);
      yield* syncFile(fileSystem, pendingTempPath);
      // The marker becomes visible atomically only after the complete backup is
      // in its final directory. From this point, startup always resumes cleanup.
      yield* fileSystem.rename(pendingTempPath, pendingPath);

      return yield* completePendingDesktopDatabaseRecovery({ stateDir: input.stateDir });
    });

    return yield* recover.pipe(
      Effect.catch((cause) =>
        fileSystem.remove(pendingTempPath, { force: true }).pipe(
          Effect.ignore,
          Effect.andThen(
            // Before marker publication the originals are untouched, so this
            // attempt's private copy is safe to remove. Once published, keep it:
            // the next startup needs it to finish the transaction.
            fileSystem.exists(pendingPath).pipe(
              Effect.flatMap((published) =>
                published
                  ? Effect.void
                  : Effect.all([
                      fileSystem.remove(partialBackupDir, { recursive: true, force: true }),
                      fileSystem.remove(backupDir, { recursive: true, force: true }),
                    ]).pipe(Effect.asVoid),
              ),
              Effect.ignore,
            ),
          ),
          Effect.andThen(
            Effect.fail(
              new DesktopDatabaseRecoveryError({
                backupDir,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  },
);

const makeDesktopDatabaseRecovery = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providePlatform = <A>(
    effect: Effect.Effect<A, DesktopDatabaseRecoveryError, FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return DesktopDatabaseRecovery.of({
    completePendingRecovery: providePlatform(
      completePendingDesktopDatabaseRecovery({ stateDir: environment.stateDir }),
    ),
    recover: (report) =>
      providePlatform(
        recoverDesktopDatabase({
          stateDir: environment.stateDir,
          report,
          ownsDatabaseFolder: DesktopEnvironment.usesDefaultBaseDir(environment),
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopDatabaseRecovery, makeDesktopDatabaseRecovery);
