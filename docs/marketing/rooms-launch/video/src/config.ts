// Timing and copy shared by every part of the edit.

export const FPS = 30;

export const TIMING = {
  introSeconds: 4,
  outroSeconds: 3.5,
  /** Every transition between segments: a short fade. */
  transitionSeconds: 0.4,
  /** Default camera glide time when a keyframe has no `glide` of its own. */
  glideSeconds: 1.3,
  /**
   * Closest the camera gets: output pixels per take pixel. 1 shows the 2x
   * capture at its native pixel size, which is as sharp as the footage gets.
   */
  maxZoom: 1.1,
} as const;

export const SITE_URL = "threadlines.dev";
