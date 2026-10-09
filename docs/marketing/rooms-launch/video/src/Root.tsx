import type React from "react";
import { Composition, Folder } from "remotion";
import { FPS } from "./config";
import { LAYOUTS, SITE_LAYOUT, SITE_TALL_LAYOUT, type Format } from "./layout";
import { Poster, Promo, SiteClip, SitePoster } from "./Promo";
import { STORIES } from "./stories";
import type { StoryId } from "./takes";
import { totalFrames } from "./timeline";

/** Composition ids start with the story's name: RoomsPromoLandscape, ThreadsPromoLandscape. */
const NAMES: Record<StoryId, string> = { rooms: "Rooms", threads: "Threads" };
const FORMATS: ReadonlyArray<[Format, string]> = [
  ["landscape", "Landscape"],
  ["portrait", "Portrait"],
  ["square", "Square"],
];
const SITE_VARIANTS = [
  ["wide", "", SITE_LAYOUT],
  ["tall", "Tall", SITE_TALL_LAYOUT],
] as const;

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
  </>
);
