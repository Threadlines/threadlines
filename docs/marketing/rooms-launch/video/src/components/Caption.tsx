import type React from "react";
import { useCurrentFrame } from "remotion";
import type { Layout } from "../layout";
import { balancedLines, useFontsReady } from "../measure";
import { colors, fonts, tracking } from "../theme";
import { enter, riseStyle } from "./motion";

const IN_AT = 2;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/);

/**
 * Kicker and headline. They rise in together as the scene starts and stay
 * until it cuts to the next one, so the caption changes exactly on the cut.
 */
export const Caption: React.FC<{
  layout: Layout;
  kicker: string;
  caption: string;
}> = ({ layout, kicker, caption }) => {
  const frame = useCurrentFrame();
  const fontsReady = useFontsReady();
  // The site clip has no captions; its page says what it shows.
  if (layout.bare) return null;
  const c = layout.caption;
  const tick = enter(frame - IN_AT, 16);
  const kickerIn = enter(frame - IN_AT, 16);
  const headlineIn = enter(frame - IN_AT - 3, 18);
  const headlineStyle = {
    family: fonts.sans,
    weight: 600,
    size: c.headlineSize,
    tracking: tracking.headline,
  };
  const blocks = c.sentencePerLine ? sentences(caption) : [caption];
  const lines = blocks.flatMap((block) =>
    fontsReady ? balancedLines(block, c.width, headlineStyle) : [block],
  );

  return (
    <div
      style={{
        position: "absolute",
        left: c.x,
        top: c.y,
        width: c.width,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: c.kickerSize * 0.7,
        }}
      >
        <div
          style={{
            width: c.kickerSize * 1.4,
            height: 2,
            borderRadius: 1,
            background: colors.accentBright,
            transform: `scaleX(${tick})`,
            transformOrigin: "left center",
          }}
        />
        <div
          style={{
            fontFamily: fonts.mono,
            fontWeight: 500,
            fontSize: c.kickerSize,
            lineHeight: 1,
            letterSpacing: "0.14em",
            whiteSpace: "pre",
            color: colors.accentBright,
            opacity: kickerIn,
            transform: kickerIn < 0.999 ? `translateX(${(1 - kickerIn) * -10}px)` : undefined,
          }}
        >
          {kicker}
        </div>
      </div>
      <div
        style={{
          marginTop: c.gap,
          fontFamily: fonts.sans,
          fontWeight: 600,
          fontSize: c.headlineSize,
          lineHeight: 1.12,
          letterSpacing: `${tracking.headline}em`,
          color: colors.fg,
          whiteSpace: "nowrap",
        }}
      >
        <div style={riseStyle(headlineIn, c.headlineSize * 0.35, 6)}>
          {lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
};
