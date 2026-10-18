/**
 * The resume cursor for a Pi thread, and where each Threadlines turn sits in
 * Pi's session tree (docs/providers/pi-plan.md, "Revert positions").
 *
 * Pi's session is an append-only tree of entries with ids. One Threadlines
 * turn can hold several Pi user messages (steers) or none (a turn Pi started
 * itself), so positions are recorded per turn instead of counted:
 *
 * - `startLeaf`: Pi's leaf just before the turn's prompt was sent.
 * - `firstUserEntryId`: the turn's first user message, the point a fork cuts
 *   before (Pi's RPC `fork` always cuts before a user entry).
 * - `leafId`: Pi's leaf when the turn ended.
 *
 * A turn whose positions were never read (a crash, a kill, a failed read) is
 * `known: false`; nothing is ever guessed. Entry ids survive `fork` and
 * `clone` (checked on Pi 1.3.0), so after a revert the remaining turns keep
 * their positions in the new session file.
 *
 * @module provider/pi/PiCursor
 */
import type { PiSessionEntry } from "./PiProtocol.ts";

const SCHEMA_VERSION = 1;
/** Older turns beyond this are dropped from the cursor; they can't be reverted to precisely. */
const MAX_TURNS = 500;

export interface PiTurnPosition {
  readonly turnId: string;
  /** False when the turn's positions were never read. */
  readonly known: boolean;
  readonly startLeaf: string | null;
  /** Null for a turn that holds no user message (Pi woke itself). */
  readonly firstUserEntryId: string | null;
  readonly leafId: string | null;
}

export interface PiResumeCursor {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** The absolute session file Pi writes to. */
  readonly sessionFile: string;
  /** The folder Pi runs the session in (its header's `cwd`). */
  readonly cwd: string;
  readonly turns: ReadonlyArray<PiTurnPosition>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined;

export function makePiResumeCursor(input: {
  readonly sessionFile: string;
  readonly cwd: string;
  readonly turns?: ReadonlyArray<PiTurnPosition>;
}): PiResumeCursor {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionFile: input.sessionFile,
    cwd: input.cwd,
    turns: (input.turns ?? []).slice(-MAX_TURNS),
  };
}

/** Reads a stored cursor; anything malformed is no cursor (a fresh session). */
export function parsePiResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof raw.sessionFile !== "string" || raw.sessionFile.length === 0) return undefined;
  if (typeof raw.cwd !== "string") return undefined;
  const turns: Array<PiTurnPosition> = [];
  for (const turn of Array.isArray(raw.turns) ? raw.turns : []) {
    if (!isRecord(turn) || typeof turn.turnId !== "string") continue;
    const startLeaf = nullableString(turn.startLeaf);
    const firstUserEntryId = nullableString(turn.firstUserEntryId);
    const leafId = nullableString(turn.leafId);
    const known =
      turn.known === true &&
      startLeaf !== undefined &&
      firstUserEntryId !== undefined &&
      leafId !== undefined;
    turns.push({
      turnId: turn.turnId,
      known,
      startLeaf: startLeaf ?? null,
      firstUserEntryId: firstUserEntryId ?? null,
      leafId: leafId ?? null,
    });
  }
  return makePiResumeCursor({ sessionFile: raw.sessionFile, cwd: raw.cwd, turns });
}

export const unknownTurn = (turnId: string): PiTurnPosition => ({
  turnId,
  known: false,
  startLeaf: null,
  firstUserEntryId: null,
  leafId: null,
});

/**
 * A turn's positions from `get_entries {since: startLeaf}` (or the whole
 * list): walk the parent chain from the new leaf back to the start leaf,
 * never trusting list order, and take the earliest user message on that path.
 * Undefined when the chain doesn't lead back to the start leaf.
 */
export function capturePiTurn(input: {
  readonly turnId: string;
  readonly startLeaf: string | null;
  readonly entries: ReadonlyArray<PiSessionEntry>;
  readonly leafId: string | null;
}): PiTurnPosition | undefined {
  if (input.leafId === null || input.leafId === input.startLeaf) {
    return {
      turnId: input.turnId,
      known: true,
      startLeaf: input.startLeaf,
      firstUserEntryId: null,
      leafId: input.leafId,
    };
  }
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  let firstUserEntryId: string | null = null;
  let cursor: string | null = input.leafId;
  for (let steps = 0; cursor !== input.startLeaf; steps += 1) {
    if (cursor === null || steps > byId.size) return undefined;
    const entry = byId.get(cursor);
    if (!entry) return undefined;
    if (entry.type === "message" && entry.message?.role === "user") firstUserEntryId = entry.id;
    cursor = entry.parentId;
  }
  return {
    turnId: input.turnId,
    known: true,
    startLeaf: input.startLeaf,
    firstUserEntryId,
    leafId: input.leafId,
  };
}

/** What Pi does to drop turns from `index` on, or why it can't. */
export type PiRevertPlan =
  | { readonly kind: "fork"; readonly entryId: string }
  | { readonly kind: "nothing" }
  | { readonly kind: "unknown" };

/**
 * Revert to before `turns[keep]` (keeping `keep` turns). Pi's memory is
 * rewound only when that turn's first user message is known; otherwise the
 * files come back and the conversation stays as Pi has it.
 */
export function planPiRevert(turns: ReadonlyArray<PiTurnPosition>, keep: number): PiRevertPlan {
  if (keep >= turns.length) return { kind: "nothing" };
  const target = turns[keep];
  if (!target?.known || target.firstUserEntryId === null) return { kind: "unknown" };
  return { kind: "fork", entryId: target.firstUserEntryId };
}

/** Where a new thread forked from this one starts in Pi's tree. */
export type PiForkPlan =
  | { readonly kind: "fork"; readonly entryId: string }
  | { readonly kind: "clone" }
  /** No exact boundary: the new thread starts fresh with Threadlines' recap. */
  | { readonly kind: "contextSeed" };

/**
 * A fork that keeps the first `keep` turns. `clone` copies Pi's current leaf,
 * so it is used only when that leaf is the last kept turn's own; a session
 * that grew outside Threadlines takes the recap path instead.
 */
export function planPiFork(input: {
  readonly turns: ReadonlyArray<PiTurnPosition>;
  readonly keep: number;
  readonly currentLeaf: string | null;
}): PiForkPlan {
  const { turns, keep } = input;
  if (keep <= 0) return { kind: "contextSeed" };
  if (keep >= turns.length) {
    const last = turns.at(-1);
    return last?.known && last.leafId !== null && last.leafId === input.currentLeaf
      ? { kind: "clone" }
      : { kind: "contextSeed" };
  }
  const next = turns[keep];
  return next?.known && next.firstUserEntryId !== null
    ? { kind: "fork", entryId: next.firstUserEntryId }
    : { kind: "contextSeed" };
}
