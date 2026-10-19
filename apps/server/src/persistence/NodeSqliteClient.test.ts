import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("keeps a plain write out of another fiber's rolled back transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE race(kind TEXT NOT NULL)`;

      // Sweep the gap between taking the connection and running the statement,
      // so the test does not depend on one scheduler offset.
      for (let delay = 0; delay < 31; delay++) {
        yield* sql`DELETE FROM race`;
        const plain = yield* sql`INSERT INTO race(kind) VALUES ('plain')`.pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 3),
          Effect.forkChild,
        );
        for (let i = 0; i < delay; i++) yield* Effect.yieldNow;
        const transaction = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO race(kind) VALUES ('rolled back')`;
              for (let i = 0; i < 1000; i++) yield* Effect.yieldNow;
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.ignore, Effect.forkChild);
        yield* Fiber.join(plain);
        yield* Fiber.join(transaction);

        const rows = yield* sql<{ readonly kind: string }>`SELECT kind FROM race`;
        assert.deepStrictEqual(rows, [{ kind: "plain" }], `delay ${delay}`);
      }
    }),
  );

  it.effect("waits for another fiber's transaction before preparing an unprepared statement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE dropped(kind TEXT NOT NULL)`;

      const tableDropped = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DROP TABLE dropped`;
            yield* Deferred.succeed(tableDropped, undefined);
            for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.ignore, Effect.forkChild);
      yield* Deferred.await(tableDropped);

      yield* sql`INSERT INTO dropped(kind) VALUES ('plain')`.unprepared;
      yield* Fiber.join(transaction);

      const rows = yield* sql<{ readonly kind: string }>`SELECT kind FROM dropped`;
      assert.deepStrictEqual(rows, [{ kind: "plain" }]);
    }),
  );
});

it.live("an interrupted query never keeps the connection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Sweep where the interrupt lands: as the query takes a free connection,
    // while it waits for one a transaction holds, and as it runs.
    for (const contended of [false, true]) {
      for (let delay = 0; delay < 80; delay++) {
        const holder = contended
          ? yield* sql
              .withTransaction(Effect.repeat(Effect.yieldNow, { times: 20 }))
              .pipe(Effect.forkChild)
          : undefined;
        const query = yield* sql`SELECT 1`.pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 3),
          Effect.forkChild,
        );
        for (let i = 0; i < delay; i++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(query);
        if (holder) yield* Fiber.join(holder);

        const next = yield* sql`SELECT 2 AS two`.pipe(Effect.timeoutOption("1 second"));
        assert.isTrue(Option.isSome(next), `contended ${contended}, delay ${delay}`);
      }
    }
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.live("queries waiting for the connection all get through", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (let waiting = 2; waiting <= 6; waiting++) {
      const holder = yield* sql
        .withTransaction(Effect.repeat(Effect.yieldNow, { times: 20 }))
        .pipe(Effect.forkChild);
      const queries = yield* Effect.forEach(Array.from({ length: waiting }), () =>
        sql`SELECT 1`.pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 3),
          Effect.forkChild,
        ),
      );
      yield* Fiber.join(holder);

      const done = yield* Effect.forEach(queries, Fiber.join).pipe(
        Effect.timeoutOption("1 second"),
      );
      assert.isTrue(Option.isSome(done), `${waiting} waiting`);
    }
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);
