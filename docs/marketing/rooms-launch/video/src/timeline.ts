import { FPS, TIMING } from "./config";
import type { Layout } from "./layout";
import { frameAt } from "./plan";
import { numbered, scenePlan } from "./scenes";
import type { Story } from "./stories";
import { mark } from "./takes";

export const sec = (seconds: number) => Math.round(seconds * FPS);

export const TRANSITION_FRAMES = sec(TIMING.transitionSeconds);
export const INTRO_FRAMES = sec(TIMING.introSeconds);
export const OUTRO_FRAMES = sec(TIMING.outroSeconds);

/** Each scene's plan and length for a story in a format. */
export const scenesFor = (story: Story, layout: Layout) =>
  numbered(story.scenes).map((spec) => {
    const plan = scenePlan(spec, story.takes[layout.take]);
    return { spec, plan, frames: plan.frames };
  });

// A story's scenes are one continuous take, so they cut straight into each
// other; only the intro and outro fade, and each fade overlaps both sides. A
// bare layout (the site clip) is the scenes alone.
export const totalFrames = (story: Story, layout: Layout) => {
  const scenes = scenesFor(story, layout).reduce((sum, scene) => sum + scene.frames, 0);
  return layout.bare ? scenes : INTRO_FRAMES + scenes + OUTRO_FRAMES - TRANSITION_FRAMES * 2;
};

/** The poster moment for a story in a format, as a frame of the whole video. */
export const posterFrame = (story: Story, layout: Layout) => {
  let start = layout.bare ? 0 : INTRO_FRAMES - TRANSITION_FRAMES;
  for (const scene of scenesFor(story, layout)) {
    if (scene.spec.id === story.poster.scene) {
      const at = frameAt(
        scene.plan,
        mark(story.takes[layout.take], story.poster.mark) + story.poster.after,
      );
      return start + at;
    }
    start += scene.frames;
  }
  throw new Error(`Unknown poster scene ${story.poster.scene}`);
};
