/**
 * The resume cursor for a Pi thread, and where each Threadlines turn sits in
 * Pi's session tree (docs/providers/pi-plan.md, "Revert and fork").
 *
 * Before each user turn the adapter has the Threadlines extension append a
 * marker entry (`threadlines-turn`, with the turn id) to Pi's session. Pi
 * never sends custom entries to the model, keeps them in the session file,
 * and copies them on `fork` and `clone` (checked on Pi 1.3.0). So a turn's
 * boundary is read from Pi's own tree, by any process, at any time:
 *
 * - A turn starts at its marker. Its first user message after the marker is
 *   the point a fork cuts before (Pi's RPC `fork` always cuts before a user
 *   entry). Later user messages in the same turn are steers.
 * - A turn that crashed half way still has its marker, so the next turn's
 *   boundary stays exact. A turn Pi started itself has no marker; its entries
 *   read as part of the turn before it.
 *
 * @module provider/pi/PiCursor
 */
import type { PiSessionEntry } from "./PiProtocol.ts";

const SCHEMA_VERSION = 2;

/** The custom entry type the extension appends before each turn. */
export const PI_TURN_MARKER_TYPE = "threadlines-turn";

export interface PiResumeCursor {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** The absolute session file Pi writes to. */
  readonly sessionFile: string;
  /** The folder Pi runs the session in (its header's `cwd`). */
  readonly cwd: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const makePiResumeCursor = (input: {
  readonly sessionFile: string;
  readonly cwd: string;
}): PiResumeCursor => ({
  schemaVersion: SCHEMA_VERSION,
  sessionFile: input.sessionFile,
  cwd: input.cwd,
});

/** Reads a stored cursor; anything malformed is no cursor (a fresh session). */
export function parsePiResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof raw.sessionFile !== "string" || raw.sessionFile.length === 0) return undefined;
  if (typeof raw.cwd !== "string" || raw.cwd.length === 0) return undefined;
  return makePiResumeCursor({ sessionFile: raw.sessionFile, cwd: raw.cwd });
}

export interface PiTurnBoundary {
  readonly turnId: string;
  readonly markerId: string;
  /** Null when no user message followed the marker (a reverted or empty turn). */
  readonly firstUserEntryId: string | null;
}

const markerTurnId = (entry: PiSessionEntry): string | undefined =>
  entry.type === "custom" &&
  entry.customType === PI_TURN_MARKER_TYPE &&
  isRecord(entry.data) &&
  typeof entry.data.turnId === "string"
    ? entry.data.turnId
    : undefined;

/**
 * The turns on the active branch (root to `leafId`), in order. Abandoned
 * branches are not on the path, so a turn reverted earlier never shows up.
 */
export function piTurnBoundaries(
  entries: ReadonlyArray<PiSessionEntry>,
  leafId: string | null,
): ReadonlyArray<PiTurnBoundary> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Array<PiSessionEntry> = [];
  for (let cursor = leafId; cursor !== null;) {
    const entry = byId.get(cursor);
    if (!entry || path.length > byId.size) break;
    path.push(entry);
    cursor = entry.parentId;
  }
  path.reverse();
  const boundaries: Array<PiTurnBoundary> = [];
  let open: { turnId: string; markerId: string; firstUserEntryId: string | null } | undefined;
  for (const entry of path) {
    const turnId = markerTurnId(entry);
    if (turnId !== undefined) {
      if (open) boundaries.push(open);
      open = { turnId, markerId: entry.id, firstUserEntryId: null };
      continue;
    }
    if (
      open &&
      open.firstUserEntryId === null &&
      entry.type === "message" &&
      entry.message?.role === "user"
    ) {
      open.firstUserEntryId = entry.id;
    }
  }
  if (open) boundaries.push(open);
  return boundaries;
}

/** What Pi does to drop the turns from `turnId` on, or why it can't. */
export type PiRevertPlan =
  | { readonly kind: "fork"; readonly entryId: string }
  | { readonly kind: "unknown" };

/**
 * Revert to before `turnId`: fork before its first user message. Unknown when
 * the turn has no marker on the active branch (Pi started it) or no message.
 */
export function planPiRevert(
  boundaries: ReadonlyArray<PiTurnBoundary>,
  turnId: string,
): PiRevertPlan {
  const boundary = boundaries.find((entry) => entry.turnId === turnId);
  return boundary?.firstUserEntryId
    ? { kind: "fork", entryId: boundary.firstUserEntryId }
    : { kind: "unknown" };
}

/** Where a new thread forked from this one starts in Pi's tree. */
export type PiForkPlan =
  | { readonly kind: "fork"; readonly entryId: string }
  | { readonly kind: "clone" }
  /** No exact boundary: the new thread starts fresh with Threadlines' recap. */
  | { readonly kind: "contextSeed" };

/**
 * `beforeTurnId`: everything before that turn. `lastTurnId`: everything
 * through that turn, which is a cut before the next turn's first message, or
 * the whole branch when it is the last turn. Neither: the whole branch.
 */
export function planPiFork(
  boundaries: ReadonlyArray<PiTurnBoundary>,
  boundary: {
    readonly beforeTurnId?: string | undefined;
    readonly lastTurnId?: string | undefined;
  },
): PiForkPlan {
  if (boundary.beforeTurnId !== undefined) {
    const plan = planPiRevert(boundaries, boundary.beforeTurnId);
    return plan.kind === "fork" ? plan : { kind: "contextSeed" };
  }
  if (boundary.lastTurnId === undefined) return { kind: "clone" };
  const index = boundaries.findIndex((entry) => entry.turnId === boundary.lastTurnId);
  if (index < 0) return { kind: "contextSeed" };
  for (const next of boundaries.slice(index + 1)) {
    // A later turn with no message (reverted, empty) cuts nothing; the one after decides.
    if (next.firstUserEntryId) return { kind: "fork", entryId: next.firstUserEntryId };
  }
  return { kind: "clone" };
}
