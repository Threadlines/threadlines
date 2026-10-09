import type React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame } from "remotion";
import type { Layout } from "../layout";
import { textWidth, useFontsReady } from "../measure";
import { FPS } from "../config";
import type { Story } from "../stories";
import { colors, fonts, tracking } from "../theme";
import { GLYPH_ASPECT, GLYPH_MAIN_LINE_Y, Glyph } from "./Glyph";
import { enter, riseStyle } from "./motion";
import { TitleBlock, titleBlockHeight } from "./TitleBlock";

const clampBoth = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const WORDMARK = "Threadlines";

// Frame marks for the intro. The logo builds and everything is in place by
// about 1.5 s; the rest of TIMING.introSeconds holds still for reading.
const BUILD_SPEED = 1.5; // the glyph builds this much faster than its own timing
const MORPH_AT = 22; // glyph settles into the lockup
const REVEAL = [24, 42] as const; // wordmark slides out of the glyph
const TITLE_AT = 24; // the title, its line and the release tag rise in together

/**
 * A thread draws across the frame, the glyph branches off it, then settles
 * into the Threadlines lockup while the story's title rises in beneath.
 */
export const Intro: React.FC<{ layout: Layout; story: Story }> = ({ layout, story }) => {
  const frame = useCurrentFrame();
  const { width, height, title } = layout;

  const morph = spring({
    frame: frame - MORPH_AT,
    fps: FPS,
    config: { damping: 200 },
    durationInFrames: 30,
  });
  const reveal = interpolate(frame, REVEAL, [0, 1], {
    ...clampBoth,
    easing: Easing.bezier(0.33, 0, 0.2, 1),
  });

  const glyphH = interpolate(morph, [0, 1], [title.introGlyphHeight, title.lockupGlyphHeight]);
  const fontsReady = useFontsReady();
  const wordmarkW = fontsReady
    ? textWidth(WORDMARK, {
        family: fonts.sans,
        weight: 600,
        size: title.wordmarkSize,
        tracking: tracking.wordmark,
      })
    : 0;
  const gap = title.wordmarkSize * 0.53 * reveal;

  // Final stack: lockup, the title block, then the release tag, centred as one group.
  const lockupToTitle = title.size * 0.46;
  const titleToRelease = title.lineSize * 1.1;
  const releaseH = title.urlSize * 1.3;
  const stackH =
    title.lockupGlyphHeight + lockupToTitle + titleBlockHeight(layout) + titleToRelease + releaseH;
  const stackTop = (height - stackH) / 2;
  const rowCentre = interpolate(
    morph,
    [0, 1],
    [height / 2, stackTop + title.lockupGlyphHeight / 2],
  );
  const rowTop = rowCentre - glyphH / 2;

  // The long thread the glyph grows from. It fades before the lockup moves.
  const thread = interpolate(frame, [0, 16], [0, 1], {
    ...clampBoth,
    easing: Easing.bezier(0.5, 0, 0.2, 1),
  });
  const threadFade = interpolate(frame, [18, 28], [1, 0], clampBoth);
  const threadY =
    height / 2 - title.introGlyphHeight / 2 + title.introGlyphHeight * GLYPH_MAIN_LINE_Y;
  const threadThickness = (title.introGlyphHeight / 100) * 3;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: threadY - threadThickness / 2,
          width: width * thread,
          height: threadThickness,
          borderRadius: threadThickness,
          opacity: threadFade,
          background: `linear-gradient(90deg, rgba(255,255,255,0) 0px, rgba(255,255,255,0.14) ${width * 0.3}px, rgba(255,255,255,0.14) ${width * 0.7}px, rgba(255,255,255,0) ${width}px)`,
          backgroundSize: `${width}px 100%`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          width,
          top: rowTop,
          height: glyphH,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div style={{ width: glyphH * GLYPH_ASPECT, height: glyphH, flexShrink: 0 }}>
          <Glyph frame={frame * BUILD_SPEED} height={glyphH} id="intro-glyph" />
        </div>
        <div style={{ width: gap, flexShrink: 0 }} />
        <div
          style={{
            width: wordmarkW * reveal,
            overflow: reveal < 1 ? "hidden" : "visible",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: fonts.sans,
              fontWeight: 600,
              fontSize: title.wordmarkSize,
              letterSpacing: `${tracking.wordmark}em`,
              lineHeight: 1,
              whiteSpace: "nowrap",
              color: colors.fg,
              opacity: reveal,
            }}
          >
            {WORDMARK}
          </span>
        </div>
      </div>
      <TitleBlock
        layout={layout}
        top={stackTop + title.lockupGlyphHeight + lockupToTitle}
        title={story.intro.title}
        line={story.intro.line}
        titleStyle={riseStyle(enter(frame - TITLE_AT, 20), 34, 10)}
        lineStyle={riseStyle(enter(frame - TITLE_AT, 20), 22, 6)}
      />
      <div
        style={{
          position: "absolute",
          top:
            stackTop +
            title.lockupGlyphHeight +
            lockupToTitle +
            titleBlockHeight(layout) +
            titleToRelease,
          left: 0,
          width,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontWeight: 500,
          fontSize: title.urlSize,
          lineHeight: 1.3,
          letterSpacing: "0.14em",
          color: colors.accentBright,
          ...riseStyle(enter(frame - TITLE_AT, 20), 14, 4),
        }}
      >
        NEW IN {story.release}
      </div>
    </AbsoluteFill>
  );
};
