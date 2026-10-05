import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadMapLanes,
  deriveThreadMapMerges,
  formatThreadMapCaption,
  layoutThreadMap,
  THREAD_MAP_MAX_LANES,
  type ThreadMapThreadInput,
} from "./ProjectThreadMap.logic";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = Date.parse("2026-10-05T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();

function thread(
  key: string,
  statusLabel: ThreadMapThreadInput["statusLabel"],
  overrides: Partial<ThreadMapThreadInput> = {},
): ThreadMapThreadInput {
  return {
    key,
    title: key,
    createdAt: ago(DAY_MS),
    activityAt: ago(HOUR_MS),
    statusLabel,
    ...overrides,
  };
}

describe("deriveThreadMapLanes", () => {
  it("leaves threads the sidebar shows no status for off the map", () => {
    const { lanes, counts } = deriveThreadMapLanes([
      thread("idle", null),
      thread("running", "Working"),
    ]);

    expect(lanes.map((lane) => lane.key)).toEqual(["running"]);
    expect(counts).toEqual({ needsYou: 0, working: 1, finished: 0 });
  });

  it("gives blocked threads a lane before running and finished ones, and counts them all", () => {
    const { lanes, counts } = deriveThreadMapLanes([
      thread("done-1", "Completed"),
      thread("work-1", "Working"),
      thread("work-2", "Waiting"),
      thread("work-3", "Starting"),
      thread("failed", "Failed"),
      thread("approval", "Pending Approval"),
      thread("plan", "Plan Ready"),
    ]);

    expect(lanes).toHaveLength(THREAD_MAP_MAX_LANES);
    expect(new Set(lanes.map((lane) => lane.key))).toEqual(
      new Set(["failed", "approval", "plan", "work-1"]),
    );
    expect(lanes.find((lane) => lane.key === "failed")?.tone).toBe("red");
    // The caption still owns up to the threads that did not get a lane.
    expect(counts).toEqual({ needsYou: 3, working: 3, finished: 1 });
  });

  it("orders lanes newest first, the order the layout stacks them from the main line", () => {
    const { lanes } = deriveThreadMapLanes([
      thread("old", "Working", { createdAt: ago(3 * DAY_MS) }),
      thread("new", "Working", { createdAt: ago(HOUR_MS) }),
      thread("mid", "Pending Approval", { createdAt: ago(DAY_MS) }),
    ]);

    expect(lanes.map((lane) => lane.key)).toEqual(["new", "mid", "old"]);
  });
});

describe("deriveThreadMapMerges", () => {
  const merge = (
    key: string,
    settledAt: string | undefined,
    repositoryScope = "github:acme/app",
  ) => ({
    key,
    repositoryScope,
    settledAt,
  });

  it("draws the newest merges of the week oldest first and counts the rest", () => {
    const result = deriveThreadMapMerges({
      entries: [
        merge("a", ago(6 * DAY_MS)),
        merge("b", ago(2 * DAY_MS)),
        merge("c", ago(HOUR_MS)),
        merge("d", ago(3 * DAY_MS)),
        merge("stale", ago(9 * DAY_MS)),
        merge("undated", undefined),
      ],
      nowMs: NOW_MS,
      listLimit: 30,
    });

    expect(result.loops.map((entry) => entry.key)).toEqual(["d", "b", "c"]);
    expect(result.count).toBe(4);
    expect(result.countIsFloor).toBe(false);
  });

  it("reports a floor whenever a repository's listing is full", () => {
    // Hosts do not order the capped listing by merge time, so a full one may
    // have left a recent merge out even when it reaches past the week.
    const full = [
      merge("recent-1", ago(HOUR_MS)),
      merge("recent-2", ago(2 * HOUR_MS)),
      merge("old", ago(20 * DAY_MS)),
    ];

    const capped = deriveThreadMapMerges({ entries: full, nowMs: NOW_MS, listLimit: 3 });
    expect(capped.count).toBe(2);
    expect(capped.countIsFloor).toBe(true);
    expect(
      deriveThreadMapMerges({ entries: full, nowMs: NOW_MS, listLimit: 30 }).countIsFloor,
    ).toBe(false);
  });
});

describe("formatThreadMapCaption", () => {
  const none = { needsYou: 0, working: 0, finished: 0 };

  it("does not pass an unread merged listing off as zero merges", () => {
    const caption = formatThreadMapCaption({
      hasAnyThread: true,
      counts: { needsYou: 1, working: 2, finished: 0 },
      merged: null,
    });

    expect(caption.map((part) => part.text)).toEqual(["2 working", "1 needs you"]);
  });

  it("says so when nothing is running, and marks a capped merge count", () => {
    expect(
      formatThreadMapCaption({
        hasAnyThread: true,
        counts: none,
        merged: { count: 30, countIsFloor: true },
      }).map((part) => part.text),
    ).toEqual(["Nothing running", "30+ merged this week"]);
  });

  it("invites the first thread on a project that has none, and still counts its merges", () => {
    expect(
      formatThreadMapCaption({ hasAnyThread: false, counts: none, merged: null }).map(
        (part) => part.text,
      ),
    ).toEqual(["Your first thread starts here"]);
    expect(
      formatThreadMapCaption({
        hasAnyThread: false,
        counts: none,
        merged: { count: 2, countIsFloor: false },
      }).map((part) => part.text),
    ).toEqual(["Your first thread starts here", "2 merged this week"]);
  });
});

describe("layoutThreadMap", () => {
  const lanes = (groups: readonly ("needsYou" | "working" | "finished")[]) =>
    groups.map((group, index) => ({ key: `lane-${index}`, group }));

  it("never lets two branches cross", () => {
    const layout = layoutThreadMap({
      lanes: lanes(["working", "working", "needsYou", "finished"]),
      loops: [{ key: "a" }, { key: "b" }, { key: "c" }],
    });

    // Each older branch has landed on its lane before the next newer one
    // leaves the main line, and each sits on a lower lane than the last.
    for (let index = 1; index < layout.lanes.length; index += 1) {
      const newer = layout.lanes[index - 1]!;
      const older = layout.lanes[index]!;
      expect(older.runStartX).toBeLessThanOrEqual(newer.startX);
      expect(older.y).toBeGreaterThan(newer.y);
    }
    expect(layout.lanes.every((lane) => lane.startX > 0)).toBe(true);
  });

  it("keeps loops in order, clear of each other, with the newest nearest now", () => {
    const layout = layoutThreadMap({
      lanes: [],
      loops: [{ key: "oldest" }, { key: "middle" }, { key: "newest" }],
    });

    expect(layout.loops.map((loop) => loop.key)).toEqual(["oldest", "middle", "newest"]);
    for (let index = 1; index < layout.loops.length; index += 1) {
      const left = layout.loops[index - 1]!;
      const right = layout.loops[index]!;
      expect(right.hit.x).toBeGreaterThan(left.dot.x);
    }
    expect(layout.loops.at(-1)!.dot.x).toBeLessThan(layout.end.x);
  });

  it("draws the next thread's branch only while there is no real one", () => {
    const quiet = layoutThreadMap({ lanes: [], loops: [{ key: "a" }] });
    const busy = layoutThreadMap({ lanes: lanes(["working"]), loops: [{ key: "a" }] });

    // One branch off the bottom of the main line, ending short of now.
    expect(quiet.nextThread).not.toBeNull();
    expect(quiet.nextThread!.tip.y).toBeGreaterThan(quiet.mainY);
    expect(quiet.nextThread!.tip.x).toBeLessThan(quiet.end.x);
    expect(quiet.height).toBeGreaterThan(quiet.nextThread!.tip.y);
    expect(busy.nextThread).toBeNull();
  });

  it("stops a finished thread's branch short of now and takes only the room it needs", () => {
    const withWork = layoutThreadMap({ lanes: lanes(["working", "finished"]), loops: [] });
    const bare = layoutThreadMap({ lanes: [], loops: [] });

    expect(withWork.lanes[0]!.tip.x).toBe(withWork.end.x);
    expect(withWork.lanes[1]!.tip.x).toBeLessThan(withWork.end.x);
    // Nothing to draw above or below the main line: no space held for it.
    expect(bare.height).toBeLessThan(withWork.height);
    expect(bare.mainY).toBeLessThan(layoutThreadMap({ lanes: [], loops: [{ key: "a" }] }).mainY);
  });
});
