import { utcDay } from "./hostCore.ts";
import { type SqlLike, sqlRows } from "./sql.ts";

export interface LedgerLimits {
  /** Relay-wide forwarded messages per UTC day before new data sockets are refused. */
  readonly dailyMessageBudget: number;
  /** Host registrations per client IP per UTC day. */
  readonly registrationsPerIpPerDay: number;
}

/**
 * Relay-wide daily accounting, kept by one singleton Durable Object. Host
 * objects report forwarded-message deltas (each host at most once a minute);
 * the ledger answers whether the relay is "busy" (near the shared free-plan
 * pool) and caps how many hosts one IP can register per day. Every report is
 * written straight away: an idle ledger can be evicted within seconds, so a
 * total held only in memory would be lost.
 */
export class LedgerCore {
  private day: string;
  private messages = 0;
  private readonly sql: SqlLike;
  private readonly limits: LedgerLimits;

  constructor(sql: SqlLike, limits: LedgerLimits, now: number = Date.now()) {
    this.sql = sql;
    this.limits = limits;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS totals (
         day TEXT PRIMARY KEY,
         messages INTEGER NOT NULL
       )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS registrations (
         day TEXT NOT NULL,
         ip_hash TEXT NOT NULL,
         count INTEGER NOT NULL,
         PRIMARY KEY (day, ip_hash)
       )`,
    );
    this.day = utcDay(now);
    this.messages =
      sqlRows<{ readonly messages: number }>(
        this.sql,
        "SELECT messages FROM totals WHERE day = ?",
        this.day,
      )[0]?.messages ?? 0;
  }

  report(messages: number, now: number): { readonly busy: boolean } {
    this.roll(now);
    if (messages > 0) {
      this.sql.exec(
        `INSERT INTO totals (day, messages) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET messages = messages + excluded.messages`,
        this.day,
        messages,
      );
      this.messages += messages;
    }
    return { busy: this.isBusy(now) };
  }

  isBusy(now: number): boolean {
    this.roll(now);
    return this.messages >= this.limits.dailyMessageBudget;
  }

  allowRegistration(ipHash: string, now: number): boolean {
    this.roll(now);
    const count =
      sqlRows<{ readonly count: number }>(
        this.sql,
        "SELECT count FROM registrations WHERE day = ? AND ip_hash = ?",
        this.day,
        ipHash,
      )[0]?.count ?? 0;
    if (count >= this.limits.registrationsPerIpPerDay) {
      return false;
    }
    this.sql.exec(
      `INSERT INTO registrations (day, ip_hash, count) VALUES (?, ?, 1)
       ON CONFLICT(day, ip_hash) DO UPDATE SET count = count + 1`,
      this.day,
      ipHash,
    );
    return true;
  }

  private roll(now: number): void {
    const day = utcDay(now);
    if (day === this.day) return;
    this.sql.exec("DELETE FROM totals WHERE day < ?", day);
    this.sql.exec("DELETE FROM registrations WHERE day < ?", day);
    this.day = day;
    this.messages = 0;
  }
}
