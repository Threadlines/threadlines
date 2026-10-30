import { type SqlLike, sqlRows } from "../sql.ts";

/**
 * Live assistant sign-in codes (`K4D82PQX`), code → computer, in the
 * `RelayCodeShard` objects next to Connect a device's codes. Codes are
 * sharded by their last character (32 shards), so typing one never touches
 * every host. A code lives 10 minutes and is used once: `take` removes it.
 * Each computer has at most one live code; its own object releases the
 * previous one when it mints the next.
 */
export class AssistantCodeShardCore {
  private readonly sql: SqlLike;

  constructor(sql: SqlLike) {
    this.sql = sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS assistant_codes (
         code TEXT PRIMARY KEY,
         host_id TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
  }

  /** Takes a fresh code for a host; false when another live code already has those characters. */
  claim(input: {
    readonly code: string;
    readonly hostId: string;
    readonly expiresAt: number;
    readonly now: number;
  }): boolean {
    this.sql.exec(
      "DELETE FROM assistant_codes WHERE code = ? AND expires_at <= ?",
      input.code,
      input.now,
    );
    if (sqlRows(this.sql, "SELECT code FROM assistant_codes WHERE code = ?", input.code)[0]) {
      return false;
    }
    this.sql.exec(
      "INSERT INTO assistant_codes (code, host_id, expires_at) VALUES (?, ?, ?)",
      input.code,
      input.hostId,
      input.expiresAt,
    );
    return true;
  }

  /** Uses a code up: the host it belongs to, or null when it isn't live. */
  take(code: string, now: number): string | null {
    const row = sqlRows<{ readonly host_id: string; readonly expires_at: number }>(
      this.sql,
      "SELECT host_id, expires_at FROM assistant_codes WHERE code = ?",
      code,
    )[0];
    if (!row) return null;
    this.sql.exec("DELETE FROM assistant_codes WHERE code = ?", code);
    return row.expires_at > now ? row.host_id : null;
  }

  /** Forgets a host's code; a row some other host holds now is left alone. */
  release(input: { readonly code: string; readonly hostId: string }): void {
    this.sql.exec(
      "DELETE FROM assistant_codes WHERE code = ? AND host_id = ?",
      input.code,
      input.hostId,
    );
  }

  sweep(now: number): void {
    this.sql.exec("DELETE FROM assistant_codes WHERE expires_at <= ?", now);
  }

  nextExpiry(): number | null {
    return (
      sqlRows<{ readonly next: number | null }>(
        this.sql,
        "SELECT MIN(expires_at) AS next FROM assistant_codes",
      )[0]?.next ?? null
    );
  }
}

/** Which shard owns an assistant code: one per last character of the code. */
export function assistantCodeShardName(code: string): string {
  return `assistant-codes:${code.slice(-1)}`;
}
