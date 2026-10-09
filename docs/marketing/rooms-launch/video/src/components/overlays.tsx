// Things drawn over the app footage, in output pixels: a spotlight that dims
// everything but its target, a ring for each click, and a note that explains
// one step, pinned to the line it is about.
import type React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import type { Box } from "../camera";
import { textWidth, useFontsReady } from "../measure";
import { accentAlpha, accentBrightAlpha, colors, fonts } from "../theme";
import { riseStyle } from "./motion";

const clampBoth = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 to 1 over `frames` from `at`, eased; with `out`, back to 0 from there. */
export const presence = (frame: number, at: number, frames = 14, out?: number) => {
  const inP = interpolate(frame, [at, at + frames], [0, 1], {
    ...clampBoth,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  if (out === undefined) return inP;
  const outP = interpolate(frame, [out, out + frames], [1, 0], {
    ...clampBoth,
    easing: Easing.bezier(0.7, 0, 0.84, 0),
  });
  return Math.min(inP, outP);
};

/**
 * Darkens everything in `clip` but `target`, which gets a thin accent edge
 * and a soft glow. `amount` fades it in and out.
 */
export const Spotlight: React.FC<{ clip: Box; target: Box; amount: number; radius?: number }> = ({
  clip,
  target,
  amount,
  radius = 12,
}) => {
  if (amount <= 0.001) return null;
  const inset = 6;
  return (
    <div
      style={{
        position: "absolute",
        left: clip.x,
        top: clip.y,
        width: clip.w,
        height: clip.h,
        overflow: "hidden",
        borderRadius: 14,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: target.x - clip.x - inset,
          top: target.y - clip.y - inset,
          width: target.w + inset * 2,
          height: target.h + inset * 2,
          borderRadius: radius,
          boxShadow: [
            `0 0 0 4000px rgba(9, 9, 11, ${0.66 * amount})`,
            `inset 0 0 0 1.5px ${accentBrightAlpha(0.85 * amount)}`,
            `0 0 40px ${accentAlpha(0.35 * amount)}`,
          ].join(", "),
        }}
      />
    </div>
  );
};

/** A soft ring pulsing out from a click. */
export const ClickRing: React.FC<{ x: number; y: number; at: number }> = ({ x, y, at }) => {
  const frame = useCurrentFrame();
  const local = frame - at;
  if (local < 0 || local >= 22) return null;
  const q = local / 22;
  const radius = 14 + 34 * Easing.out(Easing.cubic)(q);
  return (
    <div
      style={{
        position: "absolute",
        left: x - radius,
        top: y - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: "50%",
        border: `2px solid ${colors.accentBright}`,
        boxShadow: `0 0 18px ${accentBrightAlpha(0.55)}`,
        opacity: interpolate(q, [0, 0.15, 1], [0, 0.95, 0]),
      }}
    />
  );
};

/**
 * A short label explaining one step, pinned to the line it is about. With
 * `side: "after"`, `anchor` is the box of a line of text: a thin thread runs
 * from the line's end to a pill with the speaker's dot, or, when the pill
 * would run past `clip`'s right edge, the pill sits just over the line and
 * ends where the line ends (the row above a message is usually a short
 * header or step line, so its right side is free). With `side: "above"`, the pill sits over `anchor`
 * (a control such as the message box's agent button), joined by a short
 * thread; with `side: "below"`, under it (a group of rows whose own text must
 * stay readable). It draws in from `at` and fades from `out`.
 */
export const Note: React.FC<{
  anchor: Box;
  clip: Box;
  text: string;
  size: number;
  at: number;
  out?: number;
  dot?: string;
  side?: "after" | "above" | "below";
}> = ({ anchor, clip, text, size, at, out, dot, side = "after" }) => {
  const frame = useCurrentFrame();
  const fontsReady = useFontsReady();
  const line = presence(frame, at, 12, out);
  const pill = presence(frame, at + 6, 14, out);
  if (line <= 0.001 && pill <= 0.001) return null;

  const padX = size * 0.7;
  const dotSize = size * 0.42;
  const textW = fontsReady
    ? textWidth(text, { family: fonts.sans, weight: 500, size, tracking: 0 })
    : 0;
  const pillW = textW + padX * 2 + (dot ? dotSize + size * 0.45 : 0);
  const pillH = size * 1.75;
  const gap = size * 1.1;
  const right = clip.x + clip.w - size * 0.6;

  // Where the thread starts (on the anchor) and where the pill goes.
  let thread: { x: number; y: number; w: number; h: number };
  let pillX: number;
  let pillY: number;
  if (side === "above") {
    const x = anchor.x + Math.min(anchor.w / 2, size * 2);
    thread = { x, y: anchor.y - gap, w: 1.5, h: gap };
    pillX = Math.min(Math.max(anchor.x, clip.x + size * 0.6), right - pillW);
    pillY = anchor.y - gap - pillH;
  } else if (side === "below") {
    const x = anchor.x + Math.min(anchor.w / 2, size * 2);
    thread = { x, y: anchor.y + anchor.h, w: 1.5, h: gap };
    pillX = Math.min(Math.max(anchor.x, clip.x + size * 0.6), right - pillW);
    pillY = anchor.y + anchor.h + gap;
  } else if (anchor.x + anchor.w + gap + pillW <= right) {
    const y = anchor.y + anchor.h / 2;
    thread = { x: anchor.x + anchor.w + size * 0.3, y, w: gap - size * 0.3, h: 1.5 };
    pillX = anchor.x + anchor.w + gap;
    pillY = y - pillH / 2;
  } else {
    const end = Math.min(anchor.x + anchor.w, right);
    thread = { x: end - size * 0.6, y: anchor.y - size * 0.6, w: 1.5, h: size * 0.6 };
    pillX = Math.max(clip.x + size * 0.6, end - pillW);
    pillY = anchor.y - size * 0.6 - pillH;
  }
  const horizontal = thread.h <= 2;

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: thread.x,
          top: thread.y - (horizontal ? 0.75 : 0),
          width: horizontal ? thread.w * line : 1.5,
          height: horizontal ? 1.5 : thread.h * line,
          background: colors.accentBright,
          opacity: 0.85 * line,
          borderRadius: 1,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: pillX,
          top: pillY,
          height: pillH,
          display: "flex",
          alignItems: "center",
          gap: size * 0.45,
          padding: `0 ${padX}px`,
          borderRadius: 999,
          background: "rgba(17, 17, 19, 0.94)",
          border: `1px solid ${accentBrightAlpha(0.45)}`,
          boxShadow: `0 10px 26px -12px rgba(0,0,0,0.8), 0 0 16px ${accentAlpha(0.12)}`,
          fontFamily: fonts.sans,
          fontWeight: 500,
          fontSize: size,
          lineHeight: 1,
          color: colors.fg,
          whiteSpace: "nowrap",
          ...riseStyle(pill, size * 0.5, 4),
        }}
      >
        {dot ? (
          <span style={{ width: dotSize, height: dotSize, borderRadius: "50%", background: dot }} />
        ) : null}
        {text}
      </div>
    </>
  );
};
