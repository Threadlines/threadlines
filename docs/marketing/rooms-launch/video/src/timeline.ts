import { FPS, TIMING } from "./config";
import type { Layout } from "./layout";
import { frameAt } from "./plan";
import { POSTER, scenePlan, scenesIn } from "./scenes";
import { mark, TAKES } from "./takes";

export const sec = (seconds: number) => Math.round(seconds * FPS);

export const TRANSITION_FRAMES = sec(TIMING.transitionSeconds);
export const INTRO_FRAMES = sec(TIMING.introSeconds);
export const OUTRO_FRAMES = sec(TIMING.outroSeconds);

/** Each scene's plan and length for a format. */
export const scenesFor = (layout: Layout) =>
  scenesIn().map((spec) => {
    const plan = scenePlan(spec, layout.take);
    return { spec, plan, frames: plan.frames };
  });

// The feature scenes are one continuous take, so they cut straight into each
// other; only the intro and outro fade, and each fade overlaps both sides. A
// bare layout (the site clip) is the scenes alone.
export const totalFrames = (layout: Layout) => {
  const scenes = scenesFor(layout).reduce((sum, scene) => sum + scene.frames, 0);
  return layout.bare ? scenes : INTRO_FRAMES + scenes + OUTRO_FRAMES - TRANSITION_FRAMES * 2;
};

/** The poster moment for a format, as a frame of the whole video. */
export const posterFrame = (layout: Layout) => {
  let start = layout.bare ? 0 : INTRO_FRAMES - TRANSITION_FRAMES;
  for (const scene of scenesFor(layout)) {
    if (scene.spec.id === POSTER.scene) {
      const at = frameAt(scene.plan, mark(TAKES[layout.take], POSTER.mark) + POSTER.after);
      return start + at;
    }
    start += scene.frames;
  }
  throw new Error(`Unknown poster scene ${POSTER.scene}`);
};
