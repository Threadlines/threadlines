/**
 * How long this process has spent inside synchronous database calls, in
 * total. The SQLite driver (`persistence/NodeSqliteClient.ts`) holds the
 * event loop for the whole of each call, so the stall monitor reads this to
 * tell a freeze spent in the database from any other (`StallMonitor.ts`).
 */
import { performance } from "node:perf_hooks";

let databaseCallMs = 0;

/** Runs one synchronous database call, adding its time to the total. */
export function timeDatabaseCall<A>(call: () => A): A {
  const startedAt = performance.now();
  try {
    return call();
  } finally {
    databaseCallMs += performance.now() - startedAt;
  }
}

/** Milliseconds spent inside database calls since this process started. */
export function readDatabaseCallMs(): number {
  return databaseCallMs;
}
