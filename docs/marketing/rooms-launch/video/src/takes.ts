// The recordings the edit is cut from, two per story, with what
// ../source/take.ts noted while recording them: when each story moment
// happened (marks), where the pointer clicked, and where key elements were on
// screen over time (tracks).
import tallTake from "./takes/tall.json";
import threadsTallTake from "./takes/threads-tall.json";
import threadsWideTake from "./takes/threads-wide.json";
import wideTake from "./takes/wide.json";

/** The videos this project cuts: Rooms (0.5.0) and agents starting threads (0.6.0). */
export type StoryId = "rooms" | "threads";
export type TakeId = "wide" | "tall";

/** A region of a take, in its pixels. */
export type Rect = { x: number; y: number; w: number; h: number };

type TrackPoint = [number, number, number, number, number] | [number, null];

type TakeLog = {
  seconds: number;
  marks: Record<string, number>;
  clicks: Array<{ at: number; x: number; y: number }>;
  tracks: Record<string, TrackPoint[]>;
};

export type Take = TakeLog & {
  story: StoryId;
  id: TakeId;
  file: string;
  width: number;
  height: number;
};

// wide: the 1600x934 studio window at 2x. tall: the same story laid out at
// 480x800 (a phone's width and shape) at 2x, so its text reads large in the
// portrait and square frames and the whole exchange fits on screen at the end.
const takesOf = (story: StoryId, wide: unknown, tall: unknown): Record<TakeId, Take> => ({
  wide: {
    ...(wide as TakeLog),
    story,
    id: "wide",
    file: `${story}-wide.mp4`,
    width: 3200,
    height: 1868,
  },
  tall: {
    ...(tall as TakeLog),
    story,
    id: "tall",
    file: `${story}-tall.mp4`,
    width: 960,
    height: 1600,
  },
});

export const TAKES: Record<StoryId, Record<TakeId, Take>> = {
  rooms: takesOf("rooms", wideTake, tallTake),
  threads: takesOf("threads", threadsWideTake, threadsTallTake),
};

export const full = (take: Take): Rect => ({ x: 0, y: 0, w: take.width, h: take.height });

/** When a story moment happened (see the marks in ../source/story.ts and take.ts). */
export const mark = (take: Take, name: string): number => {
  const at = take.marks[name];
  if (at === undefined) throw new Error(`Take "${take.story}-${take.id}" has no mark "${name}".`);
  return at;
};

/** Where an element was at take time `t`, or null when it was not on screen. */
export const rectAt = (take: Take, name: string, t: number): Rect | null => {
  const track = take.tracks[name];
  if (track === undefined) return null;
  let found: TrackPoint | undefined;
  for (const point of track) {
    if (point[0] > t) break;
    found = point;
  }
  if (found === undefined || found[1] === null) return null;
  const [, x, y, w, h] = found as [number, number, number, number, number];
  return { x, y, w, h };
};

/** `rectAt`, failing loudly: the edit relies on this element being there. */
export const rectOf = (take: Take, name: string, t: number): Rect => {
  const rect = rectAt(take, name, t);
  if (rect === null) {
    throw new Error(`Take "${take.story}-${take.id}" has no "${name}" on screen at ${t}s.`);
  }
  return rect;
};

export const union = (...rects: ReadonlyArray<Rect | null>): Rect => {
  const present = rects.filter((rect): rect is Rect => rect !== null);
  const x = Math.min(...present.map((r) => r.x));
  const y = Math.min(...present.map((r) => r.y));
  const right = Math.max(...present.map((r) => r.x + r.w));
  const bottom = Math.max(...present.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
};

export const pad = (rect: Rect, by: number, byY = by): Rect => ({
  x: rect.x - by,
  y: rect.y - byY,
  w: rect.w + by * 2,
  h: rect.h + byY * 2,
});

/**
 * Moments where the thread jumps (a card docking, a summary popping in):
 * any tracked message row moving by more than `minShift` take pixels between
 * two samples. Nearby jumps merge into one window. The edit crossfades
 * across them instead of showing the jump.
 */
const NOT_THREAD_ROWS = new Set([
  "thread",
  "composer",
  "trigger",
  "picker",
  "request-box",
  "started-by",
  "child-heading",
  // The sidebar: its rows move when a family opens, which is the point.
  "sidebar",
  "parent-row",
  "family",
]);
const isThreadRow = (name: string) => !NOT_THREAD_ROWS.has(name) && !name.startsWith("child-row-");

export const jumpsBetween = (
  take: Take,
  from: number,
  to: number,
  minShift = 70,
): Array<{ from: number; to: number }> => {
  const times: number[] = [];
  for (const [name, track] of Object.entries(take.tracks)) {
    // Only rows of the thread count: the menus and the request card change
    // shape on purpose, and crossfading those would double their text.
    if (!isThreadRow(name)) continue;
    let previous: TrackPoint | undefined;
    for (const point of track) {
      if (previous !== undefined && previous[1] !== null && point[1] !== null) {
        const [, , y0, , h0] = previous as [number, number, number, number, number];
        const [t, , y1, , h1] = point as [number, number, number, number, number];
        if (
          t > from &&
          t < to &&
          (Math.abs(y1 - y0) >= minShift || Math.abs(h1 - h0) >= minShift)
        ) {
          times.push(t);
        }
      }
      previous = point;
    }
  }
  times.sort((a, b) => a - b);
  const windows: Array<{ from: number; to: number }> = [];
  for (const t of times) {
    const last = windows.at(-1);
    // A sample lands up to 50 ms after the change; start the crossfade before it.
    if (last !== undefined && t - last.to < 0.35) last.to = t;
    else windows.push({ from: t - 0.1, to: t });
  }
  return windows.map((window) => ({ from: window.from, to: window.to + 0.12 }));
};
