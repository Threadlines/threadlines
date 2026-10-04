/**
 * The slice of Cloudflare's `SqlStorage` the relay uses. Durable Objects pass
 * `ctx.storage.sql`; tests pass a `node:sqlite` adapter, so the same SQL runs
 * in both places.
 */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

export function sqlRows<T>(sql: SqlLike, query: string, ...bindings: unknown[]): T[] {
  return sql.exec(query, ...bindings).toArray() as T[];
}
