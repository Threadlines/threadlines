import type { ThreadStatusPill } from "../Sidebar.logic";

/**
 * The new-thread screen's drawing of a project: the main line, a loop above it
 * for each pull request that landed lately, and a branch below it for each
 * thread that has something to say. Everything here is pure, so the picture is
 * tested as data and the component only paints it.
 */

export type ThreadMapTone = "amber" | "red" | "violet" | "blue" | "cyan" | "emerald";

/** How the caption counts a thread, which is coarser than its colour. */
export type ThreadMapGroup = "needsYou" | "working" | "finished";

interface ThreadMapStatusPresentation {
  readonly tone: ThreadMapTone;
  readonly group: ThreadMapGroup;
  /** Lower claims a lane first when there are more threads than lanes. */
  readonly rank: number;
}

/**
 * One row per sidebar status, so the map's dots are the sidebar's dots. Keyed
 * by the label union: a status added there fails to compile here until it is
 * given a colour and a place in the count.
 */
const STATUS_PRESENTATION: Readonly<
  Record<ThreadStatusPill["label"], ThreadMapStatusPresentation>
> = {
  "Pending Approval": { tone: "amber", group: "needsYou", rank: 0 },
  "Awaiting Input": { tone: "amber", group: "needsYou", rank: 0 },
  Failed: { tone: "red", group: "needsYou", rank: 0 },
  "Plan Ready": { tone: "violet", group: "needsYou", rank: 1 },
  Working: { tone: "blue", group: "working", rank: 2 },
  Starting: { tone: "blue", group: "working", rank: 2 },
  Answering: { tone: "blue", group: "working", rank: 2 },
  Waiting: { tone: "cyan", group: "working", rank: 2 },
  Completed: { tone: "emerald", group: "finished", rank: 3 },
};

/** More lanes than this and the drawing stops reading as a glance. */
export const THREAD_MAP_MAX_LANES = 4;
export const THREAD_MAP_MAX_LOOPS = 3;
export const THREAD_MAP_MERGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ThreadMapThreadInput {
  readonly key: string;
  readonly title: string;
  readonly createdAt: string;
  /** When the thread last moved, for choosing which threads get a lane. */
  readonly activityAt: string;
  /** The sidebar's status for the thread, or null when it shows none. */
  readonly statusLabel: ThreadStatusPill["label"] | null;
}

export interface ThreadMapLane {
  readonly key: string;
  readonly title: string;
  readonly statusLabel: ThreadStatusPill["label"];
  readonly tone: ThreadMapTone;
  readonly group: ThreadMapGroup;
}

export interface ThreadMapCounts {
  readonly needsYou: number;
  readonly working: number;
  readonly finished: number;
}

function timestampMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Which threads get a lane, and the caption's totals.
 *
 * A thread is on the map when the sidebar shows a status for it: running,
 * stopped on the user, or finished and not yet looked at. The counts cover
 * every such thread; the lanes are the few that matter most, blocked ones
 * first. Lanes come back newest first, which is the order the layout stacks
 * them in, nearest the main line outward.
 */
export function deriveThreadMapLanes(threads: readonly ThreadMapThreadInput[]): {
  readonly lanes: readonly ThreadMapLane[];
  readonly counts: ThreadMapCounts;
} {
  const counts = { needsYou: 0, working: 0, finished: 0 };
  const candidates: {
    readonly thread: ThreadMapThreadInput;
    readonly statusLabel: ThreadStatusPill["label"];
    readonly presentation: ThreadMapStatusPresentation;
  }[] = [];
  for (const thread of threads) {
    if (thread.statusLabel === null) continue;
    const presentation = STATUS_PRESENTATION[thread.statusLabel];
    counts[presentation.group] += 1;
    candidates.push({ thread, statusLabel: thread.statusLabel, presentation });
  }

  const chosen = candidates
    .toSorted(
      (left, right) =>
        left.presentation.rank - right.presentation.rank ||
        timestampMs(right.thread.activityAt) - timestampMs(left.thread.activityAt) ||
        left.thread.key.localeCompare(right.thread.key),
    )
    .slice(0, THREAD_MAP_MAX_LANES)
    .toSorted(
      (left, right) =>
        timestampMs(right.thread.createdAt) - timestampMs(left.thread.createdAt) ||
        left.thread.key.localeCompare(right.thread.key),
    );

  return {
    lanes: chosen.map(({ thread, statusLabel, presentation }) => ({
      key: thread.key,
      title: thread.title,
      statusLabel,
      tone: presentation.tone,
      group: presentation.group,
    })),
    counts,
  };
}

export interface ThreadMapMergeInput {
  readonly key: string;
  /** One repository on one host, so the listing cap is applied per repository. */
  readonly repositoryScope: string;
  /** When it landed. A landing the host did not date is left off the map. */
  readonly settledAt?: string | undefined;
}

/**
 * The merges inside the window: the newest few to draw, oldest first, and how
 * many there were.
 *
 * The listing behind this is capped per repository, and hosts do not order it
 * by merge time (one lists by creation, another by last update), so a full
 * listing proves nothing about what it left out: an old pull request touched
 * today can crowd a recent merge off it. Whenever a repository's listing is
 * full, the count is reported as a floor rather than passed off as exact.
 */
export function deriveThreadMapMerges<T extends ThreadMapMergeInput>(input: {
  readonly entries: readonly T[];
  readonly nowMs: number;
  /** How many settled pull requests the server lists per repository. */
  readonly listLimit: number;
}): {
  readonly loops: readonly T[];
  readonly count: number;
  readonly countIsFloor: boolean;
} {
  const recent = input.entries
    .filter((entry) => {
      if (entry.settledAt === undefined) return false;
      return input.nowMs - timestampMs(entry.settledAt) <= THREAD_MAP_MERGE_WINDOW_MS;
    })
    .toSorted(
      (left, right) =>
        timestampMs(right.settledAt ?? "") - timestampMs(left.settledAt ?? "") ||
        left.key.localeCompare(right.key),
    );

  const listedPerRepository = new Map<string, number>();
  for (const entry of input.entries) {
    listedPerRepository.set(
      entry.repositoryScope,
      (listedPerRepository.get(entry.repositoryScope) ?? 0) + 1,
    );
  }
  const countIsFloor = [...listedPerRepository.values()].some(
    (listed) => listed >= input.listLimit,
  );

  return {
    loops: recent.slice(0, THREAD_MAP_MAX_LOOPS).toReversed(),
    count: recent.length,
    countIsFloor,
  };
}

/** The caption under the drawing, as the phrases it joins. */
export function formatThreadMapCaption(input: {
  readonly hasAnyThread: boolean;
  readonly counts: ThreadMapCounts;
  /** Null when the merged listing has not been read, which is not zero. */
  readonly merged: { readonly count: number; readonly countIsFloor: boolean } | null;
}): readonly { readonly group: ThreadMapGroup | "merged" | "none"; readonly text: string }[] {
  const parts: { group: ThreadMapGroup | "merged" | "none"; text: string }[] = [];
  const { needsYou, working, finished } = input.counts;
  if (working > 0) parts.push({ group: "working", text: `${working} working` });
  if (needsYou > 0) {
    parts.push({
      group: "needsYou",
      text: needsYou === 1 ? "1 needs you" : `${needsYou} need you`,
    });
  }
  if (finished > 0) parts.push({ group: "finished", text: `${finished} finished` });
  if (parts.length === 0) {
    parts.push({
      group: "none",
      text: input.hasAnyThread ? "Nothing running" : "Your first thread starts here",
    });
  }
  if (input.merged !== null && input.merged.count > 0) {
    parts.push({
      group: "merged",
      text: `${input.merged.count}${input.merged.countIsFloor ? "+" : ""} merged this week`,
    });
  }
  return parts;
}

/* ------------------------------------------------------------------ layout */

export const THREAD_MAP_WIDTH = 340;
/** Where the main line ends: now. */
const NOW_X = 330;
const MAIN_START_X = 6;
/** The main line's height when loops need the room above it, and when not. */
const MAIN_Y_WITH_LOOPS = 50;
const MAIN_Y_BARE = 12;
const LOOP_RISE = 28;
const LOOP_WIDTH = 76;
const LOOP_GAP = 18;
const LOOP_LAST_X = 300;
const LANE_FIRST_DROP = 20;
const LANE_GAP = 16;
/** A finished thread's branch stops short of now. */
const FINISHED_TIP_INSET = 42;
/** The next thread's branch, in the proportions of the app's mark. */
const NEXT_THREAD_START_X = 146;
const NEXT_THREAD_CURVE = 22;
const NEXT_THREAD_DROP = 28;
const NEXT_THREAD_TIP_X = 292;

export interface ThreadMapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ThreadMapLaneLayout {
  readonly key: string;
  readonly path: string;
  /** Where the branch leaves the main line, and where its curve has landed. */
  readonly startX: number;
  readonly runStartX: number;
  readonly y: number;
  readonly tip: { readonly x: number; readonly y: number };
  /** The pointer and focus target: the flat run and its dot. */
  readonly hit: ThreadMapRect;
}

export interface ThreadMapLoopLayout {
  readonly key: string;
  readonly path: string;
  readonly dot: { readonly x: number; readonly y: number };
  readonly hit: ThreadMapRect;
}

export interface ThreadMapLayout {
  readonly width: number;
  readonly height: number;
  readonly mainY: number;
  readonly mainPath: string;
  readonly end: { readonly x: number; readonly y: number };
  readonly lanes: readonly ThreadMapLaneLayout[];
  readonly loops: readonly ThreadMapLoopLayout[];
  /**
   * With no thread to draw, the branch the next one will take: one line
   * leaving the main line and ending on a dot, which is the app's own mark.
   * Null as soon as a real thread has a lane.
   */
  readonly nextThread: {
    readonly path: string;
    readonly startX: number;
    readonly tip: { readonly x: number; readonly y: number };
  } | null;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Places the lines. A schematic rather than a time scale: order is kept,
 * distance is not, so three threads started this morning do not pile up on the
 * right edge.
 *
 * Lanes arrive newest first. The newest leaves the main line last and takes
 * the lane nearest it; each older one leaves earlier, by at least the width of
 * its own curve, and drops further. An older branch has therefore finished
 * falling before a newer one starts, and no two lines cross.
 */
export function layoutThreadMap(input: {
  readonly lanes: readonly Pick<ThreadMapLane, "key" | "group">[];
  readonly loops: readonly { readonly key: string }[];
}): ThreadMapLayout {
  const lanes = input.lanes.slice(0, THREAD_MAP_MAX_LANES);
  const loops = input.loops.slice(-THREAD_MAP_MAX_LOOPS);
  const mainY = loops.length > 0 ? MAIN_Y_WITH_LOOPS : MAIN_Y_BARE;

  let previousStartX = NOW_X - 4;
  const laneLayouts = lanes.map((lane, index): ThreadMapLaneLayout => {
    const y = mainY + LANE_FIRST_DROP + LANE_GAP * index;
    const curve = 10 + (y - mainY) * 0.2;
    const startX = previousStartX - 2 * curve - 2;
    previousStartX = startX;
    const runStartX = startX + 2 * curve;
    const tipX =
      lane.group === "finished" ? Math.max(runStartX + 10, NOW_X - FINISHED_TIP_INSET) : NOW_X;
    const hitStartX = Math.min(runStartX, tipX - 8);
    return {
      key: lane.key,
      path: `M ${round(startX)} ${mainY} C ${round(startX + curve)} ${mainY} ${round(startX + curve)} ${y} ${round(runStartX)} ${y} L ${round(tipX)} ${y}`,
      startX: round(startX),
      runStartX: round(runStartX),
      y,
      tip: { x: round(tipX), y },
      hit: { x: round(hitStartX), y: y - 8, width: round(tipX + 8 - hitStartX), height: 16 },
    };
  });

  const loopTopY = mainY - LOOP_RISE;
  const loopLayouts = loops.map((loop, index): ThreadMapLoopLayout => {
    // The newest loop sits nearest now; older ones step left from it.
    const fromNewest = loops.length - 1 - index;
    const endX = LOOP_LAST_X - fromNewest * (LOOP_WIDTH + LOOP_GAP);
    const startX = endX - LOOP_WIDTH;
    return {
      key: loop.key,
      path: `M ${startX} ${mainY} C ${startX + 12} ${mainY} ${startX + 12} ${loopTopY} ${startX + 24} ${loopTopY} L ${endX - 24} ${loopTopY} C ${endX - 12} ${loopTopY} ${endX - 12} ${mainY} ${endX} ${mainY}`,
      dot: { x: endX, y: mainY },
      hit: {
        x: startX + 12,
        y: loopTopY - 6,
        width: endX + 8 - (startX + 12),
        height: LOOP_RISE + 14,
      },
    };
  });

  const lastLane = laneLayouts.at(-1);
  const nextThreadY = mainY + NEXT_THREAD_DROP;
  const nextThread = lastLane
    ? null
    : {
        path: `M ${NEXT_THREAD_START_X} ${mainY} C ${NEXT_THREAD_START_X + NEXT_THREAD_CURVE} ${mainY} ${NEXT_THREAD_START_X + NEXT_THREAD_CURVE} ${nextThreadY} ${NEXT_THREAD_START_X + 2 * NEXT_THREAD_CURVE} ${nextThreadY} L ${NEXT_THREAD_TIP_X} ${nextThreadY}`,
        startX: NEXT_THREAD_START_X,
        tip: { x: NEXT_THREAD_TIP_X, y: nextThreadY },
      };
  return {
    width: THREAD_MAP_WIDTH,
    height: (lastLane?.y ?? nextThreadY) + 10,
    mainY,
    mainPath: `M ${MAIN_START_X} ${mainY} L ${NOW_X} ${mainY}`,
    end: { x: NOW_X, y: mainY },
    lanes: laneLayouts,
    loops: loopLayouts,
    nextThread,
  };
}
