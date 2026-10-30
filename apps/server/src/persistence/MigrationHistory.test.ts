import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import {
  classifyMigrationHistory,
  ForeignDatabaseError,
  isForeignDatabaseCause,
} from "./MigrationHistory.ts";
import { migrationEntries } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

// T3 Code's migrations after the 30 both apps share, as recorded in a real
// T3 Code database (ids 31 onward).
const T3CODE_LATER_MIGRATIONS = [
  "AuthAuthorizationScopes",
  "AuthPairingProofKeyThumbprint",
  "ProjectionThreadsSettled",
  "ProjectionThreadsSnoozed",
  "ProjectionThreadTitleRegeneration",
  "ProjectionThreadsPinned",
  "ProjectionTurnsKeysetIndex",
  "ProjectionThreadsPinOrderKey",
  "ProjectionProjectsDefaultThreadEnvMode",
  "ProjectionProjectFaviconPath",
  "AuthSessionClientConnection",
  "ProjectionThreadLinkedPullRequest",
  "ProjectionThreadsUnsettledAt",
  "ClearAutomaticProjectModelDefaults",
  "ProjectionProjectsAutoPull",
  "RepairAutomaticSettlementTimestamps",
  "ProjectionProjectIcon",
  "ProjectionThreadBranchPullRequest",
  "ProjectionThreadsActiveOrderKey",
  "ProjectionThreadPullRequests",
  "ProjectionThreadMessageContext",
  "ProjectionThreadTitleState",
  "PullRequestFilesViewed",
  "ProjectionThreadsAutoSettleDisabledAt",
];

const ourHistory = migrationEntries.map(([id, name]) => ({ id, name }));
const t3CodeHistory = [
  ...ourHistory.filter(({ id }) => id <= 30),
  ...T3CODE_LATER_MIGRATIONS.map((name, index) => ({ id: 31 + index, name })),
];

describe("MigrationHistory", () => {
  it("tells our migration history from another app's", () => {
    assert.deepEqual(classifyMigrationHistory([]), { _tag: "Ours" });
    assert.deepEqual(classifyMigrationHistory(ourHistory), { _tag: "Ours" });
    // Before a February 2026 rewrite, some of our first steps had other names.
    assert.deepEqual(
      classifyMigrationHistory([
        { id: 1, name: "OrchestrationEvents" },
        { id: 2, name: "Projects" },
        { id: 3, name: "CheckpointCatalog" },
        { id: 4, name: "ProviderSessions" },
      ]),
      { _tag: "Ours" },
    );
    // A newer Threadlines recorded steps this build doesn't know yet.
    assert.deepEqual(
      classifyMigrationHistory([...ourHistory, { id: 9_999, name: "FromANewerVersion" }]),
      { _tag: "Ours" },
    );
    assert.deepEqual(classifyMigrationHistory(t3CodeHistory), {
      _tag: "Foreign",
      mismatch: {
        id: 31,
        recordedName: "AuthAuthorizationScopes",
        expectedName: "ProjectionThreadSessionPendingBackgroundTasks",
      },
    });
    // An older Threadlines already upgraded this copy, so it may hold the
    // user's own threads: startup carries on.
    const upgradedCopy = [
      ...t3CodeHistory.filter(({ id }) => id <= 32),
      ...ourHistory.filter(({ id }) => id > 32),
    ];
    assert.equal(classifyMigrationHistory(upgradedCopy)._tag, "Mixed");
  });

  it("finds the refusal however startup wrapped it", () => {
    const refusal = new ForeignDatabaseError({
      databasePath: "/tmp/state.sqlite",
      migrationId: 31,
      recordedName: "AuthAuthorizationScopes",
      expectedName: "ProjectionThreadSessionPendingBackgroundTasks",
    });
    assert.isTrue(isForeignDatabaseCause(Cause.fail(refusal)));
    assert.isTrue(
      isForeignDatabaseCause(Cause.die(new Error("server startup failed", { cause: refusal }))),
    );
    assert.isFalse(isForeignDatabaseCause(Cause.fail(new Error("no such table: projects"))));
  });

  it.effect("refuses a copy of T3 Code's database without writing to it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const t3CodeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-userdata-" });
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-foreign-database-",
      });
      const t3CodeDatabasePath = path.join(t3CodeDir, "state.sqlite");
      const databasePath = path.join(stateDir, "state.sqlite");
      // Copied while T3 Code had it open, as earlier versions did: its latest
      // writes are still in the WAL, which closing a writable connection
      // would fold into the copied database file.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA wal_autocheckpoint = 0`;
        yield* sql`
          CREATE TABLE effect_sql_migrations (
            migration_id INTEGER PRIMARY KEY NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            name VARCHAR(255) NOT NULL
          )
        `;
        for (const migration of t3CodeHistory) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (${migration.id}, ${migration.name})
          `;
        }
        for (const suffix of ["", "-wal", "-shm"]) {
          yield* fileSystem.copyFile(`${t3CodeDatabasePath}${suffix}`, `${databasePath}${suffix}`);
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: t3CodeDatabasePath })));
      const readDatabaseFiles = Effect.all([
        fileSystem.readFile(databasePath),
        fileSystem.readFile(`${databasePath}-wal`),
      ]);
      const before = yield* readDatabaseFiles;

      const exit = yield* Layer.build(makeSqlitePersistenceLive(databasePath)).pipe(
        Effect.scoped,
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit) && isForeignDatabaseCause(exit.cause));
      assert.deepEqual(yield* readDatabaseFiles, before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
