import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("runMigrations", (it) => {
  it.effect(
    "reads the file ahead once, before the first pending migration that reads whole tables",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // What each read-ahead found: whether migration 068's index existed yet.
        const reads: Array<boolean> = [];
        const readAhead = sql<{ readonly found: number }>`
          SELECT count(*) AS found FROM sqlite_master
          WHERE name = 'idx_orch_events_thread_maintenance'
        `.pipe(
          Effect.map(([row]) => {
            reads.push((row?.found ?? 0) > 0);
          }),
          Effect.orDie,
        );

        yield* runMigrations({ toMigrationInclusive: 50 });
        // 051 through 067 read no whole table.
        yield* runMigrations({ toMigrationInclusive: 67, readAhead });
        assert.deepStrictEqual(reads, []);

        // 068, 070 and 099 each read a whole table.
        yield* runMigrations({ readAhead });
        assert.deepStrictEqual(reads, [false]);

        // Nothing pending.
        yield* runMigrations({ readAhead });
        assert.deepStrictEqual(reads, [false]);
      }),
  );
});
