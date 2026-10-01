// A scene's footage as a list of steps over one take: play a range at some
// speed, or hold a frame. Wherever the thread jumps inside a played range,
// the plan crossfades from just before the jump to just after it, so the
// viewer sees the new layout arrive instead of the chat lurching.
import { FPS } from "./config";
import { jumpsBetween, type Take } from "./takes";

export type Step =
  | { kind: "play"; from: number; to: number; rate: number }
  | { kind: "hold"; at: number; seconds: number };

/** Play take seconds `from`..`to`, at `rate` (1 is real time). */
export const play = (from: number, to: number, rate = 1): Step => ({
  kind: "play",
  from,
  to,
  rate,
});
/** Hold the frame at take second `at` for `seconds`. */
export const hold = (at: number, seconds: number): Step => ({ kind: "hold", at, seconds });

type SegmentBody = { frames: number } & (
  | { kind: "play"; from: number; to: number; rate: number }
  | { kind: "hold"; at: number }
  | { kind: "fade"; from: number; to: number }
);

export type Segment = SegmentBody & { start: number };

export type Plan = { take: Take; segments: Segment[]; frames: number };

const FADE_FRAMES = 6;

export const planScene = (take: Take, steps: ReadonlyArray<Step>): Plan => {
  const segments: Segment[] = [];
  let start = 0;
  const push = (segment: SegmentBody) => {
    if (segment.frames <= 0) return;
    segments.push({ ...segment, start });
    start += segment.frames;
  };
  for (const step of steps) {
    if (step.kind === "hold") {
      push({ kind: "hold", at: step.at, frames: Math.round(step.seconds * FPS) });
      continue;
    }
    let from = step.from;
    // A crossfade stays inside its step, so playback never runs backwards
    // into the next one.
    const jumps = jumpsBetween(take, step.from, step.to)
      .map((jump) => ({ from: Math.max(jump.from, from), to: Math.min(jump.to, step.to) }))
      .filter((jump) => jump.to > jump.from);
    for (const jump of jumps) {
      if (jump.from < from) continue;
      push({
        kind: "play",
        from,
        to: jump.from,
        rate: step.rate,
        frames: Math.round(((jump.from - from) / step.rate) * FPS),
      });
      push({ kind: "fade", from: jump.from, to: jump.to, frames: FADE_FRAMES });
      from = jump.to;
    }
    push({
      kind: "play",
      from,
      to: step.to,
      rate: step.rate,
      frames: Math.round(((step.to - from) / step.rate) * FPS),
    });
  }
  return { take, segments, frames: start };
};

/** The take time shown at scene frame `frame`. */
export const takeTimeAt = (plan: Plan, frame: number): number => {
  const segment =
    plan.segments.find((entry) => frame < entry.start + entry.frames) ?? plan.segments.at(-1);
  if (segment === undefined) return 0;
  const local = Math.min(Math.max(frame - segment.start, 0), segment.frames);
  switch (segment.kind) {
    case "play":
      return segment.from + (local / FPS) * segment.rate;
    case "hold":
      return segment.at;
    case "fade":
      return local / segment.frames < 0.5 ? segment.from : segment.to;
  }
};

/** The first scene frame showing take time `t` or later. */
export const frameAt = (plan: Plan, t: number): number => {
  for (const segment of plan.segments) {
    switch (segment.kind) {
      case "play":
        if (t <= segment.to) {
          return segment.start + Math.max(0, Math.round(((t - segment.from) / segment.rate) * FPS));
        }
        break;
      case "hold":
        if (t <= segment.at) return segment.start;
        break;
      case "fade":
        if (t <= segment.to) return segment.start;
        break;
    }
  }
  return plan.frames;
};

/** Seconds into the scene at which take time `t` is shown. */
export const secondsAt = (plan: Plan, t: number) => frameAt(plan, t) / FPS;
