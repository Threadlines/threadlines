import type React from "react";
import type { Layout } from "../layout";
import { colors, fonts } from "../theme";

const TITLE_TO_LINE_EM = 0.2;
const LINE_HEIGHT = 1.25;

/** Height of "Rooms" plus the line under it. */
export const titleBlockHeight = (layout: Layout) =>
  layout.title.size * (1 + TITLE_TO_LINE_EM) + layout.title.lineSize * LINE_HEIGHT;

/** "Rooms" (the one display-size element) and the line under it, centred. */
export const TitleBlock: React.FC<{
  layout: Layout;
  top: number;
  title: string;
  line: string;
  titleStyle: React.CSSProperties;
  lineStyle: React.CSSProperties;
}> = ({ layout, top, title, line, titleStyle, lineStyle }) => (
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
        fontFamily: fonts.sans,
        fontWeight: 600,
        fontSize: layout.title.size,
        lineHeight: 1,
        letterSpacing: "-0.045em",
        color: colors.fg,
        ...titleStyle,
      }}
    >
      {title}
    </div>
    <div
      style={{
        marginTop: layout.title.size * TITLE_TO_LINE_EM,
        fontFamily: fonts.sans,
        fontWeight: 500,
        fontSize: layout.title.lineSize,
        lineHeight: LINE_HEIGHT,
        letterSpacing: "-0.015em",
        color: colors.fgMuted,
        ...lineStyle,
      }}
    >
      {line}
    </div>
  </div>
);
