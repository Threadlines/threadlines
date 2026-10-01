import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Layout } from "../layout";
import { OUTRO, RELEASE } from "../config";
import { TRANSITION_FRAMES } from "../timeline";
import { colors, fonts } from "../theme";
import { GLYPH_ASPECT, Glyph } from "./Glyph";
import { enter, riseStyle } from "./motion";
import { TitleBlock, titleBlockHeight } from "./TitleBlock";

/** Glyph, "Rooms", the closing line, and the release and site address. */
export const Outro: React.FC<{ layout: Layout }> = ({ layout }) => {
  const frame = useCurrentFrame();
  const { width, height, title } = layout;
  const start = TRANSITION_FRAMES - 4;

  const glyphToTitle = title.size * 0.34;
  const titleToUrl = title.lineSize * 1.6;
  const urlHeight = title.urlSize * 1.3;
  const stackH =
    title.outroGlyphHeight + glyphToTitle + titleBlockHeight(layout) + titleToUrl + urlHeight;
  const top = (height - stackH) / 2;
  const titleTop = top + title.outroGlyphHeight + glyphToTitle;
  const urlTop = titleTop + titleBlockHeight(layout) + titleToUrl;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top,
          left: (width - title.outroGlyphHeight * GLYPH_ASPECT) / 2,
        }}
      >
        <Glyph frame={frame - start} height={title.outroGlyphHeight} id="outro-glyph" />
      </div>
      <TitleBlock
        layout={layout}
        top={titleTop}
        title={OUTRO.title}
        line={OUTRO.line}
        titleStyle={riseStyle(enter(frame - start - 8, 20), 30, 10)}
        lineStyle={riseStyle(enter(frame - start - 12, 20), 20, 6)}
      />
      <div
        style={{
          position: "absolute",
          top: urlTop,
          left: 0,
          width,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontWeight: 500,
          fontSize: title.urlSize,
          lineHeight: 1.3,
          letterSpacing: "0.02em",
          whiteSpace: "pre",
          color: colors.fgDim,
          ...riseStyle(enter(frame - start - 16, 20), 14, 4),
        }}
      >
        <span style={{ color: colors.accentBright }}>v{RELEASE.version}</span>
        {"  ·  "}
        {OUTRO.url}
      </div>
    </AbsoluteFill>
  );
};
