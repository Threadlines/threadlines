/**
 * The resume cursor for a Pi thread, and where each Threadlines turn sits in
 * Pi's session tree (docs/providers/pi-plan.md, "Revert and fork").
 *
 * Before each user turn the adapter has the Threadlines extension append a
 * marker entry (`threadlines-turn`, with the turn id) to Pi's session, and
 * another when the turn ends. Pi never sends custom entries to the model,
 * keeps them in the session file, and copies them on `fork` and `clone`
 * (checked on Pi 1.3.0). So a turn's boundary is read from Pi's own tree, by
 * any process, at any time:
 *
 * - A turn starts at its marker. Its first user message after the marker is
 *   the point a fork cuts before (Pi's RPC `fork` always cuts before a user
 *   entry). Later user messages in the same turn are steers.
 * - Its end marker says the turn finished there. Anything said after it that
 *   no later turn's marker claims (a message added outside Threadlines) makes
 *   "everything through this turn" inexact.
 * - A turn Pi starts by itself is marked once it is running ("late"): its
 *   start can't be cut at, but it still counts, and it shows where the turn
 *   before it stopped.
 * - A revert forks before the dropped turn's first message, which leaves its
 *   start marker on the branch; a "reverted" marker anywhere after it says
 *   the turn is gone.
 * - A turn that crashed half way still has its start marker, so later turns
 *   stay exact.
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
  /**
   * What "Pi default" means for this thread (`provider/id`): the model its
   * session started on, which Pi chose from its settings for that folder.
   */
  readonly defaultModel?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const makePiResumeCursor = (input: {
  readonly sessionFile: string;
  readonly cwd: string;
  readonly defaultModel?: string | undefined;
}): PiResumeCursor => ({
  schemaVersion: SCHEMA_VERSION,
  sessionFile: input.sessionFile,
  cwd: input.cwd,
  ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
});

/** Reads a stored cursor; anything malformed is no cursor (a fresh session). */
export function parsePiResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof raw.sessionFile !== "string" || raw.sessionFile.length === 0) return undefined;
  if (typeof raw.cwd !== "string" || raw.cwd.length === 0) return undefined;
  return makePiResumeCursor({
    sessionFile: raw.sessionFile,
    cwd: raw.cwd,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
  });
}

export interface PiTurnBoundary {
  readonly turnId: string;
  readonly markerId: string;
  /** Null when no user message followed the marker (a reverted or empty turn). */
  readonly firstUserEntryId: string | null;
  /** Where the turn ended, when it ended normally. */
  readonly endMarkerId: string | null;
  /** Pi started the turn; its marker was written once it ran. */
  readonly late: boolean;
}

interface PiTurnMarker {
  readonly turnId: string;
  readonly end: boolean;
  readonly late: boolean;
  readonly reverted: boolean;
}

const markerOf = (entry: PiSessionEntry): PiTurnMarker | undefined =>
  entry.type === "custom" &&
  entry.customType === PI_TURN_MARKER_TYPE &&
  isRecord(entry.data) &&
  typeof entry.data.turnId === "string"
    ? {
        turnId: entry.data.turnId,
        end: entry.data.end === true,
        late: entry.data.late === true,
        reverted: entry.data.reverted === true,
      }
    : undefined;

/**
 * Entries that change what the model reads (markers, settings and labels
 * don't). A compaction only restates what came before it, so it isn't one.
 */
const isConversation = (entry: PiSessionEntry) =>
  entry.type === "message" ||
  entry.type === "custom_message" ||
  entry.type === "branch_summary" ||
  entry.type === "context_edit";

/** The active branch, root to `leafId`. Abandoned branches are not on it. */
function activePath(
  entries: ReadonlyArray<PiSessionEntry>,
  leafId: string | null,
): ReadonlyArray<PiSessionEntry> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Array<PiSessionEntry> = [];
  for (let cursor = leafId; cursor !== null;) {
    const entry = byId.get(cursor);
    if (!entry || path.length > byId.size) break;
    path.push(entry);
    cursor = entry.parentId;
  }
  return path.toReversed();
}

function boundariesOf(path: ReadonlyArray<PiSessionEntry>): Array<PiTurnBoundary> {
  const boundaries: Array<PiTurnBoundary> = [];
  let open:
    | {
        turnId: string;
        markerId: string;
        firstUserEntryId: string | null;
        endMarkerId: string | null;
        late: boolean;
      }
    | undefined;
  for (const entry of path) {
    const marker = markerOf(entry);
    if (marker?.reverted) {
      // Nothing of a dropped turn is left on the branch but its start marker.
      // A marker Pi took late (after a retry) can follow later turns.
      if (open?.turnId === marker.turnId) open = undefined;
      const index = boundaries.findIndex((boundary) => boundary.turnId === marker.turnId);
      if (index >= 0) boundaries.splice(index, 1);
      continue;
    }
    if (marker?.end) {
      if (open?.turnId === marker.turnId) open.endMarkerId = entry.id;
      continue;
    }
    if (marker) {
      if (open) boundaries.push(open);
      open = {
        turnId: marker.turnId,
        markerId: entry.id,
        firstUserEntryId: null,
        endMarkerId: null,
        late: marker.late,
      };
      continue;
    }
    if (
      open &&
      open.firstUserEntryId === null &&
      open.endMarkerId === null &&
      entry.type === "message" &&
      entry.message?.role === "user"
    ) {
      open.firstUserEntryId = entry.id;
    }
  }
  if (open) boundaries.push(open);
  return boundaries;
}

/** The turns on the active branch (root to `leafId`), in order. */
export function piTurnBoundaries(
  entries: ReadonlyArray<PiSessionEntry>,
  leafId: string | null,
): ReadonlyArray<PiTurnBoundary> {
  return boundariesOf(activePath(entries, leafId));
}

/** What Pi does to drop the turns from `turnId` on, or why it can't. */
export type PiRevertPlan =
  | { readonly kind: "fork"; readonly entryId: string }
  | { readonly kind: "unknown" };

/**
 * Revert to before `turnId`: fork before its first user message. Unknown when
 * the turn has no marker on the active branch, no message, or was started by
 * Pi (its start isn't a place Pi can cut).
 */
export function planPiRevert(
  boundaries: ReadonlyArray<PiTurnBoundary>,
  turnId: string,
): PiRevertPlan {
  const boundary = boundaries.find((entry) => entry.turnId === turnId);
  return boundary?.firstUserEntryId && !boundary.late
    ? { kind: "fork", entryId: boundary.firstUserEntryId }
    : { kind: "unknown" };
}

/** Where a new thread forked from this one starts in Pi's tree. */
export type PiForkPlan =
  /**
   * Cut before `entryId`, the first message of `droppedTurnId`, whose start
   * marker the copy keeps: the copy's first process marks it reverted.
   */
  | { readonly kind: "fork"; readonly entryId: string; readonly droppedTurnId: string }
  | { readonly kind: "clone" }
  /** No exact boundary: the new thread starts fresh with Threadlines' recap. */
  | { readonly kind: "contextSeed" };

/**
 * `beforeTurnId`: everything before that turn. `lastTurnId`: everything
 * through that turn, which needs its end marker: after it, a cut before the
 * next turn's first message, or the whole branch when nothing was said
 * since. Neither: the whole branch.
 */
export function planPiFork(
  entries: ReadonlyArray<PiSessionEntry>,
  leafId: string | null,
  boundary: {
    readonly beforeTurnId?: string | undefined;
    readonly lastTurnId?: string | undefined;
  },
): PiForkPlan {
  const path = activePath(entries, leafId);
  const boundaries = boundariesOf(path);
  if (boundary.beforeTurnId !== undefined) {
    const plan = planPiRevert(boundaries, boundary.beforeTurnId);
    return plan.kind === "fork"
      ? { kind: "fork", entryId: plan.entryId, droppedTurnId: boundary.beforeTurnId }
      : { kind: "contextSeed" };
  }
  if (boundary.lastTurnId === undefined) return { kind: "clone" };
  const index = boundaries.findIndex((entry) => entry.turnId === boundary.lastTurnId);
  const turn = boundaries[index];
  if (!turn?.endMarkerId) return { kind: "contextSeed" };
  // Where a later turn of Threadlines' own starts; a turn Pi started can't be cut at.
  const starts = new Map(
    boundaries
      .slice(index + 1)
      .flatMap((entry) =>
        entry.firstUserEntryId && !entry.late
          ? [[entry.firstUserEntryId, entry.turnId] as const]
          : [],
      ),
  );
  const after = path.slice(path.findIndex((entry) => entry.id === turn.endMarkerId) + 1);
  for (const entry of after) {
    const droppedTurnId = starts.get(entry.id);
    if (droppedTurnId !== undefined) return { kind: "fork", entryId: entry.id, droppedTurnId };
    if (isConversation(entry)) return { kind: "contextSeed" };
  }
  return { kind: "clone" };
}
