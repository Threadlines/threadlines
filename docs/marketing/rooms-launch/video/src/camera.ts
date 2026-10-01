import { spring } from "remotion";
import { FPS, TIMING } from "./config";
import { full, type Rect, type Take } from "./takes";

/** A box in output pixels. */
export type Box = { x: number; y: number; w: number; h: number };

/**
 * Camera keyframe: from scene frame `at`, glide to framing `focus` (take
 * pixels) over `glide` frames, then hold there until the next keyframe.
 */
export type CameraKey = { at: number; focus: Rect; glide?: number };

export type CameraOptions = {
  /** Where the window may appear. */
  stage: Box;
  /** Height in the stage (0 top) where the focus centre sits when the window is shorter. */
  anchorY?: number;
  /** Closest the camera gets, in output pixels per take pixel. */
  maxZoom?: number;
};

// Critically damped: the glide eases in from rest and settles without overshoot.
const GLIDE_SPRING = { mass: 1, stiffness: 100, damping: 20 };

/** Blend two rects. Centres move linearly and sizes geometrically, so a zoom feels even. */
const blendRect = (from: Rect, to: Rect, progress: number): Rect => {
  const w = from.w * (to.w / from.w) ** progress;
  const h = from.h * (to.h / from.h) ** progress;
  const cx = from.x + from.w / 2 + (to.x + to.w / 2 - (from.x + from.w / 2)) * progress;
  const cy = from.y + from.h / 2 + (to.y + to.h / 2 - (from.y + from.h / 2)) * progress;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
};

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

// Place the window along one axis: the focus centre goes to the anchor, then
// the window is kept inside the stage (when smaller) or covering it (when larger).
const placeAxis = (
  focusCentre: number,
  scale: number,
  windowSize: number,
  stageStart: number,
  stageSize: number,
  anchor: number,
) => {
  const desired = stageStart + stageSize * anchor - focusCentre * scale;
  const a = stageStart;
  const b = stageStart + stageSize - windowSize;
  return clamp(desired, Math.min(a, b), Math.max(a, b));
};

/**
 * What the stage shows when the camera rests on `focus`: a rect in take
 * pixels with the stage's aspect ratio, as large as `maxZoom` allows, never
 * past the window's edges where the window is bigger than the stage.
 */
const restingView = (take: Take, focus: Rect, options: CameraOptions): Rect => {
  const { stage } = options;
  const scale = Math.min(stage.w / focus.w, stage.h / focus.h, options.maxZoom ?? TIMING.maxZoom);
  const x = placeAxis(focus.x + focus.w / 2, scale, take.width * scale, stage.x, stage.w, 0.5);
  const y = placeAxis(
    focus.y + focus.h / 2,
    scale,
    take.height * scale,
    stage.y,
    stage.h,
    options.anchorY ?? 0.5,
  );
  return {
    x: (stage.x - x) / scale,
    y: (stage.y - y) / scale,
    w: stage.w / scale,
    h: stage.h / scale,
  };
};

export type Camera = {
  /** Output pixels per take pixel. */
  scale: number;
  /** The whole app window, in output pixels. */
  window: Box;
  /** The part of the window on screen: the window clipped to the stage. */
  visible: Box;
  /** Where a take rect lands on screen. */
  toScreen: (rect: Rect) => Box;
};

/**
 * The camera at scene frame `frame`. Each keyframe's resting view respects
 * the window's edges on its own, and the camera glides between them, so no
 * edge limit kicks in mid-glide. A glide starts from wherever the camera is,
 * so overlapping glides blend instead of jumping.
 */
export const cameraAt = (
  take: Take,
  keys: ReadonlyArray<CameraKey>,
  frame: number,
  options: CameraOptions,
): Camera => {
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  let view = restingView(take, sorted[0]?.focus ?? full(take), options);
  for (const key of sorted.slice(1)) {
    const elapsed = frame - key.at;
    if (elapsed <= 0) break;
    const progress = spring({
      frame: elapsed,
      fps: FPS,
      config: GLIDE_SPRING,
      durationInFrames: Math.max(1, key.glide ?? Math.round(TIMING.glideSeconds * FPS)),
    });
    view = blendRect(view, restingView(take, key.focus, options), progress);
  }

  const { stage } = options;
  const scale = stage.w / view.w;
  const x = stage.x - view.x * scale;
  const y = stage.y - view.y * scale;
  const w = take.width * scale;
  const h = take.height * scale;
  const left = Math.max(x, stage.x);
  const top = Math.max(y, stage.y);
  const right = Math.min(x + w, stage.x + stage.w);
  const bottom = Math.min(y + h, stage.y + stage.h);
  return {
    scale,
    window: { x, y, w, h },
    visible: { x: left, y: top, w: right - left, h: bottom - top },
    toScreen: (rect) => ({
      x: x + rect.x * scale,
      y: y + rect.y * scale,
      w: rect.w * scale,
      h: rect.h * scale,
    }),
  };
};
