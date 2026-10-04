import { type SqlLike, sqlRows } from "./sql.ts";

/**
 * Live 6-digit codes for one shard (codes are sharded by their last digit).
 * A code maps to exactly one (host, invite) while it is live; release only
 * removes the row that still belongs to that invite, so a late release from
 * an old invite can never free a newer allocation of the same digits.
 */
export class CodeShardCore {
  private readonly sql: SqlLike;

  constructor(sql: SqlLike) {
    this.sql = sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS codes (
         code TEXT PRIMARY KEY,
         host_id TEXT NOT NULL,
         invite_id TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
  }

  claim(input: {
    readonly code: string;
    readonly hostId: string;
    readonly inviteId: string;
    readonly expiresAt: number;
    readonly now: number;
  }): boolean {
    this.sql.exec("DELETE FROM codes WHERE code = ? AND expires_at <= ?", input.code, input.now);
    const existing = sqlRows<{ readonly code: string }>(
      this.sql,
      "SELECT code FROM codes WHERE code = ?",
      input.code,
    )[0];
    if (existing) {
      return false;
    }
    this.sql.exec(
      "INSERT INTO codes (code, host_id, invite_id, expires_at) VALUES (?, ?, ?, ?)",
      input.code,
      input.hostId,
      input.inviteId,
      input.expiresAt,
    );
    return true;
  }

  lookup(code: string, now: number): { readonly hostId: string; readonly inviteId: string } | null {
    const row = sqlRows<{
      readonly host_id: string;
      readonly invite_id: string;
      readonly expires_at: number;
    }>(this.sql, "SELECT host_id, invite_id, expires_at FROM codes WHERE code = ?", code)[0];
    if (!row || row.expires_at <= now) {
      return null;
    }
    return { hostId: row.host_id, inviteId: row.invite_id };
  }

  release(input: {
    readonly code: string;
    readonly hostId: string;
    readonly inviteId: string;
  }): void {
    this.sql.exec(
      "DELETE FROM codes WHERE code = ? AND host_id = ? AND invite_id = ?",
      input.code,
      input.hostId,
      input.inviteId,
    );
  }

  sweep(now: number): void {
    this.sql.exec("DELETE FROM codes WHERE expires_at <= ?", now);
  }

  nextExpiry(): number | null {
    return (
      sqlRows<{ readonly next: number | null }>(
        this.sql,
        "SELECT MIN(expires_at) AS next FROM codes",
      )[0]?.next ?? null
    );
  }
}

/** Which shard owns a code. */
export function codeShardName(code: string): string {
  return `codes:${code.slice(-1)}`;
}
