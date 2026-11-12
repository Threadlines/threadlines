// Short square clips of the themes story for X, cut from its wide take: a
// few of its scenes, then the end card. No intro: X shows a video's first
// frame as its picture, so a clip opens on the app.
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type React from "react";
import { AbsoluteFill, Easing, useVideoConfig } from "remotion";
import { Background } from "./components/Background";
import { Outro } from "./components/Outro";
import {
  AskSquare,
  GlassSquare,
  HonuOpenSquare,
  LiveArtSquare,
} from "./components/scenes/ThemesClips";
import { useOutScale } from "./frame";
import { LAYOUTS, type Layout } from "./layout";
import { planScene, play, type Plan } from "./plan";
import { numbered, type SceneSpec } from "./scenes";
import { STORIES, type Story } from "./stories";
import { mark } from "./takes";
import { OUTRO_FRAMES, TRANSITION_FRAMES } from "./timeline";

export type ClipId = "montage" | "honu";
export type ClipProps = { clip: ClipId };

/** The square frame, playing the wide take (the square videos play the phone-width one). */
const CLIP_LAYOUT: Layout = { ...LAYOUTS.square, take: "wide" };

type SceneView = React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec; opening?: boolean }>;

/**
 * A clip: scenes of the themes story by id, each with its square framing, and
 * its closing line. `opening` is a shot of its own before them.
 */
const CLIPS: Record<
  ClipId,
  {
    opening?: { spec: SceneSpec; View: SceneView };
    scenes: ReadonlyArray<readonly [string, SceneView]>;
    line: string;
  }
> = {
  montage: {
    scenes: [["live-art", LiveArtSquare]],
    line: "In the nightly now. Stable soon.",
  },
  honu: {
    opening: {
      spec: {
        id: "honu-open",
        kicker: "THEMES",
        caption: "An agent made this theme. Here's how.",
        // The lagoon behind the chat, from the end of the Glass scene.
        steps: (take) => [play(mark(take, "glass-done") + 2.2, mark(take, "glass-done") + 3.8)],
      },
      View: HonuOpenSquare,
    },
    scenes: [
      ["ask-for-your-own", AskSquare],
      ["set-the-glass", GlassSquare],
    ],
    // The feature started from his concept video of themes and /theme: the clip says so where it ends.
    line: "Inspired by @handsher_NGU's themes concept.",
  },
};

const clipScenes = (id: ClipId) => {
  const story = STORIES.themes;
  const take = story.takes.wide;
  const specs = CLIPS[id].scenes.map(([sceneId]) => {
    const spec = story.scenes.find((entry) => entry.id === sceneId);
    if (spec === undefined) throw new Error(`The themes story has no scene "${sceneId}".`);
    return spec;
  });
  const scenes = numbered(specs).map((spec, index) => {
    // A scene's closing skip leads into the scene after it in the full video; not here.
    const steps = spec.steps(take);
    while (steps.at(-1)?.kind === "skip") steps.pop();
    const plan = planScene(take, steps);
    const View = CLIPS[id].scenes[index]![1];
    return { spec, plan, View };
  });
  const opening = CLIPS[id].opening;
  return opening === undefined
    ? scenes
    : [
        { spec: opening.spec, plan: planScene(take, opening.spec.steps(take)), View: opening.View },
        ...scenes,
      ];
};

/** A clip's length in FPS frames. */
export const clipFrames = (id: ClipId) =>
  clipScenes(id).reduce((sum, scene) => sum + scene.plan.frames, 0) +
  OUTRO_FRAMES -
  TRANSITION_FRAMES;

export const Clip: React.FC<ClipProps> = ({ clip }) => {
  const { fps } = useVideoConfig();
  const out = useOutScale();
  const story: Story = {
    ...STORIES.themes,
    outro: { ...STORIES.themes.outro, line: CLIPS[clip].line },
  };
  return (
    <AbsoluteFill>
      <Background layout={CLIP_LAYOUT} />
      <TransitionSeries>
        {clipScenes(clip).map(({ spec, plan, View }, index) => (
          <TransitionSeries.Sequence
            key={spec.id}
            name={spec.kicker}
            durationInFrames={Math.round(plan.frames * out)}
            premountFor={fps}
          >
            <View layout={CLIP_LAYOUT} plan={plan} spec={spec} opening={index === 0} />
          </TransitionSeries.Sequence>
        ))}
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({
            durationInFrames: TRANSITION_FRAMES * out,
            easing: Easing.bezier(0.33, 0, 0.2, 1),
          })}
        />
        <TransitionSeries.Sequence
          name="Outro"
          durationInFrames={OUTRO_FRAMES * out}
          premountFor={fps}
        >
          <Outro layout={CLIP_LAYOUT} story={story} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
