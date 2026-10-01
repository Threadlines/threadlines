import type React from "react";
import { Composition, Folder } from "remotion";
import { FPS } from "./config";
import { LAYOUTS, SITE_LAYOUT, SITE_TALL_LAYOUT } from "./layout";
import { Poster, Promo, SiteClip, SitePoster } from "./Promo";
import { totalFrames } from "./timeline";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="RoomsPromoLandscape"
      component={Promo}
      durationInFrames={totalFrames(LAYOUTS.landscape)}
      fps={FPS}
      width={LAYOUTS.landscape.width}
      height={LAYOUTS.landscape.height}
      defaultProps={{ format: "landscape" as const }}
    />
    <Composition
      id="RoomsPromoPortrait"
      component={Promo}
      durationInFrames={totalFrames(LAYOUTS.portrait)}
      fps={FPS}
      width={LAYOUTS.portrait.width}
      height={LAYOUTS.portrait.height}
      defaultProps={{ format: "portrait" as const }}
    />
    <Composition
      id="RoomsPromoSquare"
      component={Promo}
      durationInFrames={totalFrames(LAYOUTS.square)}
      fps={FPS}
      width={LAYOUTS.square.width}
      height={LAYOUTS.square.height}
      defaultProps={{ format: "square" as const }}
    />
    {/* Posters are full length so the timeline's sequences are not cut short;
        every frame shows the POSTER moment, and `remotion still` takes frame 0. */}
    <Folder name="Posters">
      <Composition
        id="RoomsPosterLandscape"
        component={Poster}
        durationInFrames={totalFrames(LAYOUTS.landscape)}
        fps={FPS}
        width={LAYOUTS.landscape.width}
        height={LAYOUTS.landscape.height}
        defaultProps={{ format: "landscape" as const }}
      />
      <Composition
        id="RoomsPosterPortrait"
        component={Poster}
        durationInFrames={totalFrames(LAYOUTS.portrait)}
        fps={FPS}
        width={LAYOUTS.portrait.width}
        height={LAYOUTS.portrait.height}
        defaultProps={{ format: "portrait" as const }}
      />
      <Composition
        id="RoomsPosterSquare"
        component={Poster}
        durationInFrames={totalFrames(LAYOUTS.square)}
        fps={FPS}
        width={LAYOUTS.square.width}
        height={LAYOUTS.square.height}
        defaultProps={{ format: "square" as const }}
      />
      <Composition
        id="RoomsSitePoster"
        component={SitePoster}
        durationInFrames={totalFrames(SITE_LAYOUT)}
        fps={FPS}
        width={SITE_LAYOUT.width}
        height={SITE_LAYOUT.height}
        defaultProps={{ variant: "wide" as const }}
      />
      <Composition
        id="RoomsSitePosterTall"
        component={SitePoster}
        durationInFrames={totalFrames(SITE_TALL_LAYOUT)}
        fps={FPS}
        width={SITE_TALL_LAYOUT.width}
        height={SITE_TALL_LAYOUT.height}
        defaultProps={{ variant: "tall" as const }}
      />
    </Folder>
    <Composition
      id="RoomsSiteClip"
      component={SiteClip}
      durationInFrames={totalFrames(SITE_LAYOUT)}
      fps={FPS}
      width={SITE_LAYOUT.width}
      height={SITE_LAYOUT.height}
      defaultProps={{ variant: "wide" as const }}
    />
    <Composition
      id="RoomsSiteClipTall"
      component={SiteClip}
      durationInFrames={totalFrames(SITE_TALL_LAYOUT)}
      fps={FPS}
      width={SITE_TALL_LAYOUT.width}
      height={SITE_TALL_LAYOUT.height}
      defaultProps={{ variant: "tall" as const }}
    />
  </>
);
