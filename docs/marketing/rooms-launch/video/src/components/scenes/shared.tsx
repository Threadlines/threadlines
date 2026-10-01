import type React from "react";
import { interpolate, spring } from "remotion";
import type { Camera } from "../../camera";
import { FPS } from "../../config";
import type { Layout } from "../../layout";
import { frameAt, type Plan } from "../../plan";
import { pad, type Rect, rectOf, type Take, union } from "../../takes";
import { ClickRing } from "../overlays";
import type { Float } from "../Stage";

const clampBoth = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Rings on the take's clicks that fall inside this scene's footage. */
export const Clicks: React.FC<{ plan: Plan; camera: Camera }> = ({ plan, camera }) => {
  const played = plan.segments.filter((segment) => segment.kind === "play");
  const first = played[0];
  const last = played.at(-1);
  if (first?.kind !== "play" || last?.kind !== "play") return null;
  return (
    <>
      {plan.take.clicks
        .filter((click) => click.at >= first.from && click.at <= last.to)
        .map((click) => {
          const point = camera.toScreen({ x: click.x, y: click.y, w: 0, h: 0 });
          return <ClickRing key={click.at} x={point.x} y={point.y} at={frameAt(plan, click.at)} />;
        })}
    </>
  );
};

/** The bottom of the thread and the message box, at take time `t`. */
export const threadBottom = (take: Take, t: number, layout: Layout): Rect => {
  const composer = rectOf(take, "composer", t);
  const lift = take.height * (layout.format === "landscape" ? 0.3 : 0.26);
  return pad({ x: composer.x, y: composer.y - lift, w: composer.w, h: composer.h + lift }, 30);
};

/**
 * A frame around whole chat rows (the full column, so right-aligned user
 * messages stay whole), with room above and below.
 */
export const rowsFocus = (...rows: ReadonlyArray<Rect>): Rect => pad(union(...rows), 40, 60);

/** Each speaker's dot on the labels: Opus's orange, Codex models' white. */
export const DOTS = { opus: "#d97757", codex: "#e4e4e7" } as const;

/** A spring from 0 to 1 starting at `at`. */
export const settle = (frame: number, at: number, frames = 26) =>
  spring({ frame: frame - at, fps: FPS, config: { damping: 200 }, durationInFrames: frames });

/** The window arriving: tilted back and low, settling flat. */
export const tiltIn = (frame: number, at = 0): Float => {
  const p = settle(frame, at, 34);
  return {
    rotateX: (1 - p) * 8,
    translateY: (1 - p) * 40,
    scale: 0.97 + 0.03 * p,
    opacity: interpolate(p, [0, 0.4], [0, 1], clampBoth),
  };
};

/** The window rising from below. */
export const riseIn = (frame: number, at = 0): Float => {
  const p = settle(frame, at, 30);
  return {
    translateY: (1 - p) * 90,
    rotateX: (1 - p) * 8,
    opacity: interpolate(p, [0, 0.35], [0, 1], clampBoth),
  };
};
