import type React from "react";
import { useCurrentFrame } from "remotion";
import { type Camera, type CameraKey, type CameraOptions, cameraAt } from "../camera";
import type { Plan } from "../plan";
import { accentAlpha, colors } from "../theme";
import { TakeVideo } from "./TakeVideo";

/** How the whole window floats at a frame: a small 3D tilt, a drift, a fade. */
export type Float = {
  rotateX?: number;
  rotateY?: number;
  translateX?: number;
  translateY?: number;
  scale?: number;
  opacity?: number;
};

const STILL: Float = {};

/**
 * The app window: the scene's footage behind a camera, floating on the
 * background with a hairline edge and a soft accent light. `renderOverlay`
 * draws on top in output pixels, with the camera to place things on the
 * footage.
 */
export const Stage: React.FC<{
  plan: Plan;
  keys: ReadonlyArray<CameraKey>;
  options: CameraOptions;
  radius: number;
  float?: Float;
  renderOverlay?: (camera: Camera) => React.ReactNode;
}> = ({ plan, keys, options, radius, float = STILL, renderOverlay }) => {
  const frame = useCurrentFrame();
  const camera = cameraAt(plan.take, keys, frame, options);
  const { window: win, visible: vis } = camera;
  const transform = [
    `translate(${float.translateX ?? 0}px, ${float.translateY ?? 0}px)`,
    `perspective(2200px)`,
    `rotateX(${float.rotateX ?? 0}deg)`,
    `rotateY(${float.rotateY ?? 0}deg)`,
    `scale(${float.scale ?? 1})`,
  ].join(" ");
  const flat =
    !float.rotateX &&
    !float.rotateY &&
    !float.translateX &&
    !float.translateY &&
    (float.scale ?? 1) === 1;

  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: float.opacity ?? 1,
          transform: flat ? undefined : transform,
          transformOrigin: `${vis.x + vis.w / 2}px ${vis.y + vis.h / 2}px`,
        }}
      >
        {/* Accent light spilling from behind the window. */}
        <div
          style={{
            position: "absolute",
            left: vis.x - vis.w * 0.25,
            top: vis.y - vis.h * 0.2,
            width: vis.w * 1.5,
            height: vis.h * 1.55,
            background: `radial-gradient(closest-side, ${accentAlpha(0.18)}, ${accentAlpha(0.06)} 55%, ${accentAlpha(0)} 100%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: vis.x,
            top: vis.y,
            width: vis.w,
            height: vis.h,
            borderRadius: radius,
            overflow: "hidden",
            backgroundColor: colors.bgElev,
            boxShadow: `0 50px 110px -30px rgba(0,0,0,0.85), 0 22px 44px -18px rgba(0,0,0,0.6), 0 0 90px ${accentAlpha(0.1)}`,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: win.x - vis.x,
              top: win.y - vis.y,
              width: win.w,
              height: win.h,
            }}
          >
            <TakeVideo plan={plan} />
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: radius,
              boxShadow: `inset 0 0 0 1px ${colors.border}`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: radius,
              right: radius,
              top: 0,
              height: 1,
              background:
                "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.16) 30%, rgba(255,255,255,0.16) 70%, rgba(255,255,255,0) 100%)",
            }}
          />
        </div>
        {renderOverlay?.(camera)}
      </div>
    </>
  );
};
