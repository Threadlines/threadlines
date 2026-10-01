import type { Box } from "./camera";
import type { TakeId } from "./takes";

export type Format = "landscape" | "portrait" | "square";

export type Layout = {
  format: Format;
  width: number;
  height: number;
  /** The recording this format plays: the wide window, or the phone-width layout. */
  take: TakeId;
  windowRadius: number;
  /** The kicker and headline at the top. */
  caption: {
    x: number;
    y: number;
    width: number;
    kickerSize: number;
    headlineSize: number;
    /** Gap between kicker and headline. */
    gap: number;
    /** Put each sentence on its own line (narrow formats). */
    sentencePerLine: boolean;
  };
  /** Where the app window usually sits, under the caption. */
  stage: Box;
  /** Text size of the labels drawn over the footage. */
  chip: number;
  /**
   * The website clip: just the scenes, the window filling the frame. No
   * captions, background, intro, end card or tilt; the site's own frame and
   * text go around it.
   */
  bare?: true;
  title: {
    /** "Rooms" */
    size: number;
    /** The line under it. */
    lineSize: number;
    /** Intro: glyph height while it draws, then in the lockup with the wordmark. */
    introGlyphHeight: number;
    lockupGlyphHeight: number;
    wordmarkSize: number;
    /** Outro glyph height. */
    outroGlyphHeight: number;
    urlSize: number;
  };
};

export const LAYOUTS: Record<Format, Layout> = {
  landscape: {
    format: "landscape",
    width: 1920,
    height: 1080,
    take: "wide",
    windowRadius: 14,
    caption: {
      x: 150,
      y: 62,
      width: 1620,
      kickerSize: 20,
      headlineSize: 54,
      gap: 16,
      sentencePerLine: false,
    },
    stage: { x: 150, y: 196, w: 1620, h: 846 },
    chip: 28,
    title: {
      size: 120,
      lineSize: 38,
      introGlyphHeight: 168,
      lockupGlyphHeight: 40,
      wordmarkSize: 46,
      outroGlyphHeight: 92,
      urlSize: 24,
    },
  },
  portrait: {
    format: "portrait",
    width: 1080,
    height: 1350,
    take: "tall",
    windowRadius: 14,
    caption: {
      x: 72,
      y: 84,
      width: 936,
      kickerSize: 21,
      headlineSize: 60,
      gap: 20,
      sentencePerLine: true,
    },
    stage: { x: 60, y: 330, w: 960, h: 960 },
    chip: 28,
    title: {
      size: 120,
      lineSize: 40,
      introGlyphHeight: 168,
      lockupGlyphHeight: 40,
      wordmarkSize: 46,
      outroGlyphHeight: 92,
      urlSize: 24,
    },
  },
  square: {
    format: "square",
    width: 1080,
    height: 1080,
    take: "tall",
    windowRadius: 14,
    caption: {
      x: 72,
      y: 66,
      width: 936,
      kickerSize: 20,
      headlineSize: 52,
      gap: 16,
      sentencePerLine: true,
    },
    stage: { x: 60, y: 256, w: 960, h: 784 },
    chip: 26,
    title: {
      size: 112,
      lineSize: 38,
      introGlyphHeight: 156,
      lockupGlyphHeight: 38,
      wordmarkSize: 44,
      outroGlyphHeight: 86,
      urlSize: 24,
    },
  },
};

/**
 * The homepage clip: the wide take's scenes at the site's 1600x934 clip size,
 * filling the frame. It frames shots like landscape.
 */
export const SITE_LAYOUT: Layout = {
  ...LAYOUTS.landscape,
  width: 1600,
  height: 934,
  windowRadius: 0,
  stage: { x: 0, y: 0, w: 1600, h: 934 },
  chip: 24,
  bare: true,
};

/**
 * The homepage clip on phones: the tall take's scenes at 4:5, filling the
 * frame. It frames shots like portrait.
 */
export const SITE_TALL_LAYOUT: Layout = {
  ...LAYOUTS.portrait,
  width: 800,
  height: 1000,
  windowRadius: 0,
  stage: { x: 0, y: 0, w: 800, h: 1000 },
  chip: 26,
  bare: true,
};
