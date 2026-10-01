import type React from "react";
import {
  AbsoluteFill,
  Freeze,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type { Plan, Segment } from "../plan";
import { FPS } from "../config";

const fill: React.CSSProperties = { width: "100%", height: "100%", display: "block" };

/**
 * One frame of the take. The video is trimmed to start at that frame and
 * frozen on its first frame: freezing an untrimmed video at a late frame
 * would ask for a point past the composition's end, which Remotion clamps.
 */
const Frozen: React.FC<{ src: string; at: number }> = ({ src, at }) => (
  <Freeze frame={0}>
    <OffthreadVideo src={src} muted trimBefore={Math.round(at * FPS)} style={fill} />
  </Freeze>
);

/** Two held frames, the second fading in over the first. */
const Crossfade: React.FC<{ src: string; segment: Extract<Segment, { kind: "fade" }> }> = ({
  src,
  segment,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, segment.frames - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill>
      <Frozen src={src} at={segment.from} />
      <AbsoluteFill style={{ opacity }}>
        <Frozen src={src} at={segment.to} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** A scene's footage: its take, played, held and crossfaded as the plan says. */
export const TakeVideo: React.FC<{ plan: Plan }> = ({ plan }) => {
  const src = staticFile(plan.take.file);
  return (
    <AbsoluteFill>
      {plan.segments.map((segment) => (
        <Sequence
          key={segment.start}
          from={segment.start}
          durationInFrames={segment.frames}
          premountFor={FPS}
          layout="absolute-fill"
        >
          {segment.kind === "play" ? (
            <OffthreadVideo
              src={src}
              muted
              trimBefore={Math.round(segment.from * FPS)}
              playbackRate={segment.rate}
              style={fill}
            />
          ) : segment.kind === "hold" ? (
            <Frozen src={src} at={segment.at} />
          ) : (
            <Crossfade src={src} segment={segment} />
          )}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
