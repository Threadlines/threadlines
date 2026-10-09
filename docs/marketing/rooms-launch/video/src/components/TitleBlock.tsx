import type React from "react";
import type { Layout } from "../layout";
import { textWidth, useFontsReady } from "../measure";
import { colors, fonts } from "../theme";

const TITLE_TO_LINE_EM = 0.2;
const LINE_HEIGHT = 1.25;
const TITLE_TRACKING = -0.045;
const LINE_TRACKING = -0.015;

/** Height of a story's title plus the line under it. */
export const titleBlockHeight = (layout: Layout) =>
  layout.title.size * (1 + TITLE_TO_LINE_EM) + layout.title.lineSize * LINE_HEIGHT;

/** `size`, or smaller so `text` fits `maxWidth` on one line. */
const fitted = (text: string, size: number, weight: number, tracking: number, maxWidth: number) => {
  const width = textWidth(text, { family: fonts.sans, weight, size, tracking });
  return width > maxWidth ? size * (maxWidth / width) : size;
};

/**
 * A story's title (the one display-size element) and the line under it,
 * centred. A long title or line is set smaller to stay on one line inside
 * the frame; the block keeps its height either way, so the cards around it
 * don't move.
 */
export const TitleBlock: React.FC<{
  layout: Layout;
  top: number;
  title: string;
  line: string;
  titleStyle: React.CSSProperties;
  lineStyle: React.CSSProperties;
}> = ({ layout, top, title, line, titleStyle, lineStyle }) => {
  const fontsReady = useFontsReady();
  const narrow = layout.format !== "landscape";
  const titleSize = fontsReady
    ? fitted(title, layout.title.size, 600, TITLE_TRACKING, layout.width * (narrow ? 0.86 : 0.6))
    : layout.title.size;
  const lineSize = fontsReady
    ? fitted(line, layout.title.lineSize, 500, LINE_TRACKING, layout.width * 0.88)
    : layout.title.lineSize;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        width: layout.width,
        top,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <div
        style={{
          height: layout.title.size,
          display: "flex",
          alignItems: "center",
          fontFamily: fonts.sans,
          fontWeight: 600,
          fontSize: titleSize,
          lineHeight: 1,
          letterSpacing: `${TITLE_TRACKING}em`,
          whiteSpace: "nowrap",
          color: colors.fg,
          ...titleStyle,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: layout.title.size * TITLE_TO_LINE_EM,
          height: layout.title.lineSize * LINE_HEIGHT,
          display: "flex",
          alignItems: "center",
          fontFamily: fonts.sans,
          fontWeight: 500,
          fontSize: lineSize,
          lineHeight: LINE_HEIGHT,
          letterSpacing: `${LINE_TRACKING}em`,
          whiteSpace: "nowrap",
          color: colors.fgMuted,
          ...lineStyle,
        }}
      >
        {line}
      </div>
    </div>
  );
};
