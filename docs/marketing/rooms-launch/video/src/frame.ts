// The edit counts in frames at FPS (30 a second): every plan, camera move and
// label is timed that way. A composition can still be rendered at a higher
// rate (the themes video is 60, so live art at 20 a second lands evenly):
// components read the frame with useFrame, which is always in FPS frames
// (with halves at 60), and anything that sets a length in real frames
// multiplies by useOutScale.
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FPS } from "./config";

/** The current frame in FPS frames, whatever rate the composition renders at. */
export const useFrame = (): number => (useCurrentFrame() * FPS) / useVideoConfig().fps;

/** Real frames per FPS frame: 1 at 30 a second, 2 at 60. */
export const useOutScale = (): number => useVideoConfig().fps / FPS;
