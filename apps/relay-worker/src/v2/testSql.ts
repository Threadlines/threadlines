import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { SqlLike } from "./sql.ts";

/** In-memory `node:sqlite` database shaped like a Durable Object's `ctx.storage.sql`, for tests. */
export function makeTestSql(): SqlLike {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
      return { toArray: () => rows };
    },
  };
}
