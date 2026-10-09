import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type React from "react";
import { Fragment } from "react";
import { AbsoluteFill, Easing, Freeze, Series, useVideoConfig } from "remotion";
import { Background } from "./components/Background";
import { Intro } from "./components/Intro";
import { Outro } from "./components/Outro";
import { AddAgent } from "./components/scenes/AddAgent";
import { AnswersComeBack } from "./components/scenes/AnswersComeBack";
import { AskFirst } from "./components/scenes/AskFirst";
import { TalkToAgent } from "./components/scenes/TalkToAgent";
import { ThreeAtOnce } from "./components/scenes/ThreeAtOnce";
import { WorkTogether } from "./components/scenes/WorkTogether";
import { LAYOUTS, SITE_LAYOUT, SITE_TALL_LAYOUT, type Format, type Layout } from "./layout";
import type { Plan } from "./plan";
import type { SceneSpec } from "./scenes";
import { STORIES } from "./stories";
import type { StoryId } from "./takes";
import { INTRO_FRAMES, OUTRO_FRAMES, posterFrame, scenesFor, TRANSITION_FRAMES } from "./timeline";

export type PromoProps = { story: StoryId; format: Format };

const fadeTiming = linearTiming({
  durationInFrames: TRANSITION_FRAMES,
  easing: Easing.bezier(0.33, 0, 0.2, 1),
});

type SceneView = React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }>;

/** Each story's scenes, by the ids in its scene list. */
const VIEWS: Record<StoryId, Record<string, SceneView>> = {
  rooms: {
    "add-a-model": AddAgent,
    "work-together": WorkTogether,
    "talk-to-any-agent": TalkToAgent,
  },
  threads: {
    "ask-first": AskFirst,
    "three-at-once": ThreeAtOnce,
    "answers-come-back": AnswersComeBack,
  },
};

const viewOf = (story: StoryId, spec: SceneSpec): SceneView => {
  const View = VIEWS[story][spec.id];
  if (View === undefined) throw new Error(`Story "${story}" has no view for scene "${spec.id}".`);
  return View;
};

/**
 * A whole video. Each format plays its own take, so the scenes (and their
 * lengths) come from that take's plans. The scenes are one continuous take,
 * so they cut straight into each other; the intro and outro fade.
 */
export const Promo: React.FC<PromoProps> = ({ story: storyId, format }) => {
  const story = STORIES[storyId];
  const layout = LAYOUTS[format];
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background layout={layout} />
      <TransitionSeries>
        <TransitionSeries.Sequence name="Intro" durationInFrames={INTRO_FRAMES} premountFor={fps}>
          <Intro layout={layout} story={story} />
        </TransitionSeries.Sequence>
        {scenesFor(story, layout).map(({ spec, plan, frames }, index) => {
          const View = viewOf(storyId, spec);
          return (
            <Fragment key={spec.id}>
              {index === 0 ? (
                <TransitionSeries.Transition presentation={fade()} timing={fadeTiming} />
              ) : null}
              <TransitionSeries.Sequence
                name={spec.kicker}
                durationInFrames={frames}
                premountFor={fps}
              >
                <View layout={layout} plan={plan} spec={spec} />
              </TransitionSeries.Sequence>
            </Fragment>
          );
        })}
        <TransitionSeries.Transition presentation={fade()} timing={fadeTiming} />
        <TransitionSeries.Sequence name="Outro" durationInFrames={OUTRO_FRAMES} premountFor={fps}>
          <Outro layout={layout} story={story} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};

/** One frame of a video (its story's poster moment), for the poster PNGs. */
export const Poster: React.FC<PromoProps> = ({ story, format }) => (
  <Freeze frame={posterFrame(STORIES[story], LAYOUTS[format])}>
    <Promo story={story} format={format} />
  </Freeze>
);

export type SiteClipProps = { story: StoryId; variant: "wide" | "tall" };

const SITE_LAYOUTS = { wide: SITE_LAYOUT, tall: SITE_TALL_LAYOUT } as const;

/**
 * A homepage clip: a story's scenes cut straight together, the window
 * filling the frame, labels kept. "wide" (1600x934) is for desktop, "tall"
 * (800x1000) for phones. It loops on the site.
 */
export const SiteClip: React.FC<SiteClipProps> = ({ story: storyId, variant }) => {
  const layout = SITE_LAYOUTS[variant];
  return (
    <AbsoluteFill style={{ background: "#09090b" }}>
      <Series>
        {scenesFor(STORIES[storyId], layout).map(({ spec, plan, frames }) => {
          const View = viewOf(storyId, spec);
          return (
            <Series.Sequence key={spec.id} name={spec.kicker} durationInFrames={frames}>
              <View layout={layout} plan={plan} spec={spec} />
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};

/** A homepage clip's poster: the same moment as the promo posters. */
export const SitePoster: React.FC<SiteClipProps> = ({ story, variant }) => (
  <Freeze frame={posterFrame(STORIES[story], SITE_LAYOUTS[variant])}>
    <SiteClip story={story} variant={variant} />
  </Freeze>
);
