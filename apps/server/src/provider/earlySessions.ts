/**
 * Sessions started early, while the user is still typing the message that
 * will need them (docs/early-agent-start.md), keyed by session key.
 *
 * An early session is not the thread's until something uses it: until then
 * the thread shows nothing of it, its events are withheld (its warnings are
 * held for the thread, the rest dropped), and it is stopped once the user
 * stops typing. Using it (a turn, a goal, a review, voice) adopts it, and it
 * becomes an ordinary session.
 */

/** Early sessions not yet used, at most, on one server. */
export const EARLY_SESSION_LIMIT = 2;

/** An unused early session stops this long after the last sign of typing. */
export const EARLY_SESSION_IDLE_MS = 3 * 60_000;

/** Why an early session went unused. */
export type EarlySessionEndReason = "idle" | "turn_started" | "asked_user";

export type EarlyReservation = "reserved" | "renewed" | "limit" | "blocked";

interface EarlyEntry<Held> {
  /** Which early start this is: a later start of the same key gets a new one. */
  readonly id: number;
  /**
   * `starting` and `ready`: waiting to be used. `retired`: being stopped
   * unused; its last events are still ignored until the key starts again.
   */
  readonly phase: "starting" | "ready" | "retired";
  readonly instanceId: string;
  readonly cwd: string | undefined;
  readonly startedAtMs: number;
  readonly lastSignalAtMs: number;
  /** The started runtime's `createdAt`, so expiry never stops a newer one. */
  readonly generation: string | undefined;
  /** What the runtime said that the thread should see once it is used. */
  readonly held: ReadonlyArray<Held>;
}

export interface ExpiredEarlySession {
  readonly sessionKey: string;
  readonly instanceId: string;
  readonly startedAtMs: number;
  readonly generation: string | undefined;
}

/** `Held`: what an early runtime says that its thread sees once it is used. */
export const makeEarlySessionLedger = <Held>() => {
  const entries = new Map<string, EarlyEntry<Held>>();
  /** Instance and checkout pairs whose start did something on its own. */
  const blocked = new Set<string>();
  /** Adopted early sessions whose first turn hasn't been sent yet. */
  const firstTurnPending = new Set<string>();
  let lastId = 0;

  const blockKey = (instanceId: string, cwd: string | undefined) =>
    `${instanceId}\u0000${cwd ?? ""}`;
  const waiting = (entry: EarlyEntry<Held> | undefined): entry is EarlyEntry<Held> =>
    entry !== undefined && entry.phase !== "retired";

  return {
    /**
     * Claims a slot for an early start of `sessionKey`, or renews the one it
     * has. Synchronous, so two threads can't both take the last slot.
     */
    reserve: (
      sessionKey: string,
      input: {
        readonly instanceId: string;
        readonly cwd: string | undefined;
        readonly nowMs: number;
      },
    ): EarlyReservation => {
      const existing = entries.get(sessionKey);
      if (waiting(existing)) {
        entries.set(sessionKey, { ...existing, lastSignalAtMs: input.nowMs });
        return "renewed";
      }
      if (blocked.has(blockKey(input.instanceId, input.cwd))) {
        return "blocked";
      }
      let count = 0;
      for (const entry of entries.values()) {
        if (waiting(entry)) count += 1;
      }
      if (count >= EARLY_SESSION_LIMIT) {
        return "limit";
      }
      lastId += 1;
      entries.set(sessionKey, {
        id: lastId,
        phase: "starting",
        instanceId: input.instanceId,
        cwd: input.cwd,
        startedAtMs: input.nowMs,
        lastSignalAtMs: input.nowMs,
        generation: undefined,
        held: [],
      });
      return "reserved";
    },

    /**
     * The reserved start finished; `generation` is the runtime's `createdAt`.
     * Recorded on a retired entry too, so whoever stops it can tell its runtime.
     */
    started: (sessionKey: string, generation: string) => {
      const entry = entries.get(sessionKey);
      if (entry?.phase === "starting") {
        entries.set(sessionKey, { ...entry, phase: "ready", generation });
      } else if (entry?.phase === "retired") {
        entries.set(sessionKey, { ...entry, generation });
      }
    },

    /** The key's entry, if it is still the early start `id`. */
    entryOf: (sessionKey: string, id: number) => {
      const entry = entries.get(sessionKey);
      return entry?.id === id ? entry : undefined;
    },

    /** Started, unused, and no sign of typing for the idle time, as of now. */
    isExpired: (sessionKey: string, nowMs: number) => {
      const entry = entries.get(sessionKey);
      return entry?.phase === "ready" && nowMs - entry.lastSignalAtMs >= EARLY_SESSION_IDLE_MS;
    },

    /** True while the key's runtime is early and unused, or being stopped unused. */
    isEarly: (sessionKey: string) => entries.has(sessionKey),

    /** The early session waiting to be used for this key, if any. */
    waiting: (sessionKey: string) => {
      const entry = entries.get(sessionKey);
      return waiting(entry) ? entry : undefined;
    },

    /** Keeps `item` for the thread if the key's session is waiting to be used. */
    hold: (sessionKey: string, item: Held) => {
      const entry = entries.get(sessionKey);
      if (waiting(entry)) {
        entries.set(sessionKey, { ...entry, held: [...entry.held, item] });
      }
    },

    /**
     * Something used the session: it is the thread's now. Returns what was
     * held for the thread, or undefined if it wasn't waiting as an early
     * session.
     */
    adopt: (sessionKey: string): ReadonlyArray<Held> | undefined => {
      const entry = entries.get(sessionKey);
      if (!waiting(entry)) {
        return undefined;
      }
      entries.delete(sessionKey);
      firstTurnPending.add(sessionKey);
      return entry.held;
    },

    /** Whether this is the first turn of an adopted early session (asked once). */
    takeFirstTurn: (sessionKey: string) => firstTurnPending.delete(sessionKey),

    /**
     * The key's runtime stopped or is being replaced by an ordinary start.
     * A retired entry stays until the key starts again, so the stopped
     * runtime's last events are still ignored.
     */
    forget: (sessionKey: string, options?: { readonly keepRetired?: boolean }) => {
      firstTurnPending.delete(sessionKey);
      if (options?.keepRetired === true && entries.get(sessionKey)?.phase === "retired") {
        return;
      }
      entries.delete(sessionKey);
    },

    /**
     * Marks a waiting entry as being stopped unused (or as failed to start),
     * dropping what it held, and returns what it was.
     */
    retire: (sessionKey: string): EarlyEntry<Held> | undefined => {
      const entry = entries.get(sessionKey);
      if (!waiting(entry)) {
        return undefined;
      }
      entries.set(sessionKey, { ...entry, phase: "retired", held: [] });
      return entry;
    },

    /** No more early starts for this instance in this checkout, for this server's life. */
    block: (instanceId: string, cwd: string | undefined) => {
      blocked.add(blockKey(instanceId, cwd));
    },

    /** Started sessions nobody has used, with no sign of typing for the idle time. */
    expired: (nowMs: number): ReadonlyArray<ExpiredEarlySession> => {
      const result: Array<ExpiredEarlySession> = [];
      for (const [sessionKey, entry] of entries) {
        if (entry.phase === "ready" && nowMs - entry.lastSignalAtMs >= EARLY_SESSION_IDLE_MS) {
          result.push({
            sessionKey,
            instanceId: entry.instanceId,
            startedAtMs: entry.startedAtMs,
            generation: entry.generation,
          });
        }
      }
      return result;
    },
  };
};
