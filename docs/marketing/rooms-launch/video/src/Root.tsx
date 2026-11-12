import type React from "react";
import { Composition, Folder } from "remotion";
import { Clip, clipFrames } from "./Clip";
import { FPS } from "./config";
import { LAYOUTS, SITE_LAYOUT, SITE_TALL_LAYOUT, type Format } from "./layout";
import { Poster, Promo, SiteClip, SitePoster } from "./Promo";
import { STORIES } from "./stories";
import type { StoryId } from "./takes";
import { totalFrames } from "./timeline";

/** Composition ids start with the story's name: RoomsPromoLandscape, ThreadsPromoLandscape. */
const NAMES: Record<StoryId, string> = {
  rooms: "Rooms",
  threads: "Threads",
  fleet: "Fleet",
  themes: "Themes",
};
const FORMATS: ReadonlyArray<[Format, string]> = [
  ["landscape", "Landscape"],
  ["portrait", "Portrait"],
  ["square", "Square"],
];
const SITE_VARIANTS = [
  ["wide", "", SITE_LAYOUT],
  ["tall", "Tall", SITE_TALL_LAYOUT],
] as const;

/**
 * The themes video renders at 60 a second: its live art draws 20 times a
 * second, which lands on every third frame at 60 and can't land evenly at 30.
 */
const THEMES_FPS = 60;

/** One story's videos, posters and homepage clips. */
const StoryCompositions: React.FC<{ id: StoryId }> = ({ id }) => {
  const story = STORIES[id];
  const name = NAMES[id];
  return (
    <Folder name={name}>
      {FORMATS.map(([format, label]) => (
        <Composition
          key={format}
          id={`${name}Promo${label}`}
          component={Promo}
          durationInFrames={totalFrames(story, LAYOUTS[format])}
          fps={FPS}
          width={LAYOUTS[format].width}
          height={LAYOUTS[format].height}
          defaultProps={{ story: id, format }}
        />
      ))}
      {/* Posters are full length so the timeline's sequences are not cut short;
          every frame shows the story's poster moment, and `remotion still` takes frame 0. */}
      <Folder name={`${name}-Posters`}>
        {FORMATS.map(([format, label]) => (
          <Composition
            key={format}
            id={`${name}Poster${label}`}
            component={Poster}
            durationInFrames={totalFrames(story, LAYOUTS[format])}
            fps={FPS}
            width={LAYOUTS[format].width}
            height={LAYOUTS[format].height}
            defaultProps={{ story: id, format }}
          />
        ))}
        {SITE_VARIANTS.map(([variant, label, layout]) => (
          <Composition
            key={variant}
            id={`${name}SitePoster${label}`}
            component={SitePoster}
            durationInFrames={totalFrames(story, layout)}
            fps={FPS}
            width={layout.width}
            height={layout.height}
            defaultProps={{ story: id, variant }}
          />
        ))}
      </Folder>
      {SITE_VARIANTS.map(([variant, label, layout]) => (
        <Composition
          key={variant}
          id={`${name}SiteClip${label}`}
          component={SiteClip}
          durationInFrames={totalFrames(story, layout)}
          fps={FPS}
          width={layout.width}
          height={layout.height}
          defaultProps={{ story: id, variant }}
        />
      ))}
    </Folder>
  );
};

export const RemotionRoot: React.FC = () => (
  <>
    <StoryCompositions id="rooms" />
    <StoryCompositions id="threads" />
    <StoryCompositions id="fleet" />
    <Folder name="Themes">
      <Composition
        id="ThemesPromoLandscape"
        component={Promo}
        durationInFrames={totalFrames(STORIES.themes, LAYOUTS.landscape) * (THEMES_FPS / FPS)}
        fps={THEMES_FPS}
        width={LAYOUTS.landscape.width}
        height={LAYOUTS.landscape.height}
        defaultProps={{ story: "themes", format: "landscape" }}
      />
      {(["montage", "honu"] as const).map((clip) => (
        <Composition
          key={clip}
          id={`ThemesClip${clip === "montage" ? "Montage" : "Honu"}Square`}
          component={Clip}
          durationInFrames={clipFrames(clip) * (THEMES_FPS / FPS)}
          fps={THEMES_FPS}
          width={LAYOUTS.square.width}
          height={LAYOUTS.square.height}
          defaultProps={{ clip }}
        />
      ))}
    </Folder>
  </>
);
