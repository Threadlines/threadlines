import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Layout } from "../layout";
import { FPS } from "../config";
import { accentAlpha, accentBrightAlpha, colors } from "../theme";

/**
 * The dark stage under the whole video: two soft accent glows drifting on slow
 * paths, and a vignette. It never cuts, so transitions only move the content.
 */
export const Background: React.FC<{ layout: Layout }> = ({ layout }) => {
  const t = useCurrentFrame() / FPS;
  const { width, height } = layout;
  const reach = Math.max(width, height);

  const aX = 0.26 + 0.1 * Math.sin(t * 0.19);
  const aY = 0.22 + 0.08 * Math.cos(t * 0.15);
  const bX = 0.76 + 0.08 * Math.cos(t * 0.17 + 1.3);
  const bY = 0.82 + 0.06 * Math.sin(t * 0.21 + 2.1);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(${reach * 0.62}px ${reach * 0.42}px at ${aX * 100}% ${aY * 100}%, ${accentAlpha(0.11)}, ${accentAlpha(0.04)} 45%, ${accentAlpha(0)} 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(${reach * 0.55}px ${reach * 0.4}px at ${bX * 100}% ${bY * 100}%, ${accentBrightAlpha(0.07)}, ${accentBrightAlpha(0.025)} 45%, ${accentBrightAlpha(0)} 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(${width * 0.75}px ${height * 0.75}px at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.4) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
