/**
 * MigrationHistory - keeps Threadlines from upgrading a database another app
 * made.
 *
 * Threadlines and T3 Code share an ancestor, so their first migrations carry
 * the same ids and names while later ids name different steps in each app.
 * The migrator runs only ids above the highest one recorded, so on a copy of
 * the other app's database it would skip most of our steps and fail later on a
 * missing table, or write our steps into the other app's schema. Startup reads
 * the recorded names over a read-only connection first, and stops before
 * opening the file for writing.
 *
 * @module MigrationHistory
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries } from "./Migrations.ts";

/** Where Effect's migrator records finished migrations. */
const MIGRATIONS_TABLE = "effect_sql_migrations";

const CURRENT_MIGRATION_NAMES: ReadonlyMap<number, string> = new Map(
  migrationEntries.map(([id, name]) => [id, name]),
);

/**
 * Names some of our first migrations carried before a February 2026 rewrite.
 * Databases from then still record them, and they are ours.
 */
const EARLIER_MIGRATION_NAMES: ReadonlyArray<readonly [number, string]> = [
  [2, "Projects"],
  [3, "CheckpointCatalog"],
  [4, "ProviderSessions"],
  [6, "ProjectionPendingTurnStarts"],
];

const isOurMigration = (migration: RecordedMigration): boolean =>
  CURRENT_MIGRATION_NAMES.get(migration.id) === migration.name ||
  EARLIER_MIGRATION_NAMES.some(([id, name]) => id === migration.id && name === migration.name);

export interface RecordedMigration {
  readonly id: number;
  readonly name: string;
}

/** The lowest recorded migration whose name is not ours for that id. */
export interface MigrationMismatch {
  readonly id: number;
  readonly recordedName: string;
  readonly expectedName: string;
}

export type MigrationHistory =
  /** Empty, or ours for every id we know. Ids above ours come from a newer Threadlines. */
  | { readonly _tag: "Ours" }
  /** Another app's history that Threadlines never upgraded. */
  | { readonly _tag: "Foreign"; readonly mismatch: MigrationMismatch }
  /**
   * Another app's history with our later steps on top: Threadlines upgraded
   * it before this check existed, so it may hold the user's own threads.
   */
  | { readonly _tag: "Mixed"; readonly mismatch: MigrationMismatch };

export function classifyMigrationHistory(
  recorded: ReadonlyArray<RecordedMigration>,
): MigrationHistory {
  let mismatch: MigrationMismatch | undefined;
  for (const migration of recorded) {
    const expectedName = CURRENT_MIGRATION_NAMES.get(migration.id);
    if (expectedName === undefined || isOurMigration(migration)) continue;
    if (mismatch === undefined || migration.id < mismatch.id) {
      mismatch = { id: migration.id, recordedName: migration.name, expectedName };
    }
  }
  if (mismatch === undefined) {
    return { _tag: "Ours" };
  }
  const firstMismatchId = mismatch.id;
  const upgradedByThreadlines = recorded.some(
    (migration) => migration.id > firstMismatchId && isOurMigration(migration),
  );
  return upgradedByThreadlines ? { _tag: "Mixed", mismatch } : { _tag: "Foreign", mismatch };
}

export class ForeignDatabaseError extends Schema.TaggedError<ForeignDatabaseError>()(
  "ForeignDatabaseError",
  {
    databasePath: Schema.String,
    migrationId: Schema.Number,
    recordedName: Schema.String,
    expectedName: Schema.String,
  },
) {
  override get message(): string {
    return `The database at ${this.databasePath} was made by another app, such as T3 Code: its migration ${this.migrationId} is "${this.recordedName}", where Threadlines has "${this.expectedName}". Threadlines stopped without upgrading it. Move it elsewhere to start fresh, or point THREADLINES_HOME at a folder of Threadlines' own.`;
  }
}

const isForeignDatabaseError = Schema.is(ForeignDatabaseError);

const MAX_WRAPPED_CAUSE_DEPTH = 8;

function holdsForeignDatabaseError(value: unknown, depth: number): boolean {
  if (isForeignDatabaseError(value)) return true;
  if (depth >= MAX_WRAPPED_CAUSE_DEPTH) return false;
  if (Cause.isCause(value)) return causeHoldsForeignDatabaseError(value, depth + 1);
  if (typeof value !== "object" || value === null || !("cause" in value)) return false;
  return holdsForeignDatabaseError(value.cause, depth + 1);
}

function causeHoldsForeignDatabaseError(cause: Cause.Cause<unknown>, depth: number): boolean {
  return cause.reasons.some((reason) =>
    Cause.isFailReason(reason)
      ? holdsForeignDatabaseError(reason.error, depth)
      : Cause.isDieReason(reason) && holdsForeignDatabaseError(reason.defect, depth),
  );
}

/**
 * Whether the process stopped on a foreign database, as a failure or a
 * defect and however startup wrapped it, so the CLI can exit with
 * FOREIGN_DATABASE_EXIT_CODE.
 */
export const isForeignDatabaseCause = (cause: Cause.Cause<unknown>): boolean =>
  causeHoldsForeignDatabaseError(cause, 0);

/**
 * Fails with ForeignDatabaseError when the database's migration history
 * belongs to another app. Give it a read-only connection opened before the
 * writable one: closing a writable connection can fold the other app's WAL
 * into its database file.
 */
export const assertOwnMigrationHistory = Effect.fn("assertOwnMigrationHistory")(function* (
  databasePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA busy_timeout = 5000;`;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) {
    return;
  }
  const rows = yield* sql<{ readonly migration_id: number | bigint; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(MIGRATIONS_TABLE)}
  `;
  const history = classifyMigrationHistory(
    rows.map((row) => ({ id: Number(row.migration_id), name: row.name })),
  );
  switch (history._tag) {
    case "Ours":
      return;
    case "Mixed":
      yield* Effect.logWarning(
        "database migration history includes another app's steps; continuing because Threadlines already upgraded it",
        { databasePath, ...history.mismatch },
      );
      return;
    case "Foreign":
      return yield* new ForeignDatabaseError({
        databasePath,
        migrationId: history.mismatch.id,
        recordedName: history.mismatch.recordedName,
        expectedName: history.mismatch.expectedName,
      });
  }
});
