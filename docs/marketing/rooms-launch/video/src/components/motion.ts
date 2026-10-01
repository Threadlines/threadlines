import type React from "react";
import { spring } from "remotion";
import { FPS } from "../config";

/** Smooth, no-overshoot entrance used by all text. */
export const enter = (frame: number, durationInFrames = 20) =>
  spring({ frame, fps: FPS, config: { damping: 200 }, durationInFrames });

/**
 * Text rising into place: fades in, lifts `distance` px, and sharpens from a
 * light blur. At rest it has no transform or filter, so it rasterises crisply.
 */
export const riseStyle = (progress: number, distance: number, blur = 8): React.CSSProperties => {
  if (progress >= 0.999) return { opacity: 1 };
  const remaining = 1 - progress;
  return {
    opacity: progress,
    transform: `translateY(${remaining * distance}px)`,
    filter: blur > 0 && remaining > 0.01 ? `blur(${remaining * blur}px)` : undefined,
  };
};
