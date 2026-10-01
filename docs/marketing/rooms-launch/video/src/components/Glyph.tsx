import type React from "react";
import { Easing, interpolate, spring } from "remotion";
import { FPS } from "../config";
import { colors } from "../theme";

// The Threadlines glyph from the marketing site nav: a main thread with a
// second strand branching off it and ending in a lit node.
const VIEWBOX = { x: 36, y: 86, w: 184, h: 100 };
export const GLYPH_ASPECT = VIEWBOX.w / VIEWBOX.h;
/** Where the main line sits, as a fraction of the glyph's height. */
export const GLYPH_MAIN_LINE_Y = (98 - VIEWBOX.y) / VIEWBOX.h;

const drawEase = Easing.bezier(0.65, 0, 0.35, 1);
const clampBoth = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const draw = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { ...clampBoth, easing: drawEase });

const pop = (frame: number) =>
  spring({ frame, fps: FPS, config: { mass: 0.7, stiffness: 190, damping: 12 } });

/**
 * The glyph, drawn `frame` frames into its build (lines stroke in, dots pop,
 * the end node lights). Pass a large frame for the finished mark.
 */
export const Glyph: React.FC<{ frame: number; height: number; id: string }> = ({
  frame,
  height,
  id,
}) => {
  const main = draw(frame, 0, 24);
  const branch = draw(frame, 9, 30);
  const dots = [
    { cx: 70, r: 7, at: 5 },
    { cx: 108, r: 8.5, at: 10 },
    { cx: 178, r: 7, at: 17 },
  ];
  const node = pop(frame - 27);
  const halo = spring({
    frame: frame - 28,
    fps: FPS,
    config: { damping: 200 },
    durationInFrames: 18,
  });
  const haloOpacity = interpolate(frame, [27, 34, 50], [0, 0.34, 0.16], clampBoth);
  const bloom = interpolate(frame, [27, 35, 64], [0, 0.55, 0.22], clampBoth);
  const gradientId = `${id}-branch`;
  const bloomId = `${id}-bloom`;

  return (
    <svg
      viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
      width={height * GLYPH_ASPECT}
      height={height}
      fill="none"
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="108"
          y1="98"
          x2="194"
          y2="162"
        >
          <stop offset="0" stopColor="#a1a1aa" stopOpacity="0.45" />
          <stop offset="1" stopColor={colors.accentBright} />
        </linearGradient>
        <radialGradient id={bloomId}>
          <stop offset="0" stopColor={colors.accentBright} stopOpacity="0.55" />
          <stop offset="0.45" stopColor={colors.accentBright} stopOpacity="0.16" />
          <stop offset="1" stopColor={colors.accentBright} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="194" cy="162" r="58" fill={`url(#${bloomId})`} opacity={bloom} />
      <g strokeLinecap="round" strokeWidth="10">
        <path
          d="M 44 98 L 212 98"
          stroke={colors.lineStrong}
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - main}
          opacity={main > 0.001 ? 1 : 0}
        />
        <path
          d="M 108 98 C 134 98 134 162 160 162 L 188 162"
          stroke={`url(#${gradientId})`}
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - branch}
          opacity={branch > 0.001 ? 1 : 0}
        />
      </g>
      <g fill={colors.nodeStrong}>
        {dots.map((dot) => (
          <circle key={dot.cx} cx={dot.cx} cy="98" r={dot.r * Math.max(0, pop(frame - dot.at))} />
        ))}
      </g>
      <circle
        cx="194"
        cy="162"
        r={21 * (0.55 + 0.45 * halo)}
        fill={colors.accentBright}
        opacity={haloOpacity}
      />
      <circle cx="194" cy="162" r={12.5 * Math.max(0, node)} fill={colors.accentBright} />
    </svg>
  );
};
