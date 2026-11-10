/**
 * Loops that never stop, shown fewer times a second than the screen refreshes.
 *
 * Anything that moves makes the browser draw the window again, and a loop
 * left to itself moves on every refresh of the screen: 144 times a second on
 * a 144 Hz display, for a working dot that travels a fortieth of a pixel
 * between two of them. Measured in Nov 2026 on such a screen, the working
 * dots and the status word's sheen took a third of a CPU core between them;
 * shown 30 times a second they take a tenth.
 *
 * A loop asks for this in CSS: `--loop-fps: 30` on its element (or one above
 * it) shows it 30 poses a second. The motion is the loop's own, with its
 * curves and its timing, only sampled.
 *
 * How: when such a loop starts, its progress is cut into steps (the
 * effect's own easing becomes `steps()`, which an animation applies before
 * its keyframes' easings) and its start moves onto a grid every stepped loop
 * shares, so they all change pose in the same frames and share those
 * redraws. Nothing is paused or driven from script. The browser still runs
 * each loop, on the compositor where it ran before, so a busy page doesn't
 * stall it, and a loop this never reaches runs at full rate, as it always did.
 *
 * While nobody can be looking at the page (another app in front), loops
 * show `UNATTENDED_LOOP_FPS` poses a second at most, as a theme's art slows
 * there.
 *
 * This module imports nothing, on purpose: the app loads it after startup
 * (main.tsx), and a module it shared with the startup code would be split
 * out of that code into a file of its own, growing what every start loads.
 * Whoever installs it hands it what it needs.
 */

/** The CSS custom property a loop sets to be stepped: poses a second. */
export const LOOP_FPS_PROPERTY = "--loop-fps";

/** The most poses a second while nobody can be looking at the page. */
export const UNATTENDED_LOOP_FPS = 10;

/** Whether the user can be looking at the page, and when that may have changed (pageAttention.ts). */
export interface LoopAttention {
  readonly isAttended: () => boolean;
  /** Calls `listener` when the answer may have changed; returns the way to stop. */
  readonly onChange: (listener: () => void) => () => void;
}

/**
 * Cuts a loop's progress into `fps` poses a second and moves its start (by
 * half a pose at most) so its poses change on the grid all stepped loops share.
 */
function stepLoop(animation: Animation, fps: number): void {
  const effect = animation.effect;
  if (!effect || animation.timeline !== document.timeline) return;
  const timing = effect.getComputedTiming();
  const duration = Number(timing.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const pose = 1000 / fps;
  effect.updateTiming({ easing: `steps(${Math.max(1, Math.round(duration / pose))})` });
  const startTime = animation.startTime;
  if (typeof startTime !== "number") return;
  // The loop's first pose begins once its delay has passed: that moment goes on the grid.
  const past = (((startTime + (timing.delay ?? 0)) % pose) + pose) % pose;
  const shift = past <= pose / 2 ? -past : pose - past;
  if (Math.abs(shift) > 0.01) animation.startTime = startTime + shift;
}

/**
 * Steps every loop that asks for it (`--loop-fps`): the ones already
 * running, and each new one from the moment it starts. Slows them while
 * nobody can be looking. Returns the way to stop: loops already stepped stay
 * as they are.
 */
export function installSteppedLoops(attention: LoopAttention): () => void {
  if (
    typeof document === "undefined" ||
    typeof document.getAnimations !== "function" ||
    typeof CSSAnimation === "undefined"
  ) {
    return () => {};
  }
  /** Each stepped loop with the rate its CSS asked for. */
  const asked = new WeakMap<Animation, number>();
  let attended = attention.isAttended();
  const shown = (fps: number) => (attended ? fps : Math.min(fps, UNATTENDED_LOOP_FPS));

  /**
   * Steps a loop whose element asks for it. One that isn't running yet (no
   * start time: just made, or made paused) is left for the next event it
   * sends: its start, or the end of its first time around.
   */
  const adopt = (animation: Animation) => {
    if (asked.has(animation) || !(animation instanceof CSSAnimation)) return;
    const effect = animation.effect;
    if (
      !(effect instanceof KeyframeEffect) ||
      !effect.target ||
      effect.pseudoElement ||
      effect.getTiming().iterations !== Number.POSITIVE_INFINITY ||
      typeof animation.startTime !== "number"
    ) {
      return;
    }
    const fps = Number.parseFloat(
      getComputedStyle(effect.target).getPropertyValue(LOOP_FPS_PROPERTY),
    );
    if (!(fps > 0)) return;
    asked.set(animation, fps);
    stepLoop(animation, shown(fps));
  };
  const onLoopEvent = (event: AnimationEvent) => {
    if (!(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations()) adopt(animation);
  };
  const onAttentionChange = () => {
    const next = attention.isAttended();
    if (next === attended) return;
    attended = next;
    for (const animation of document.getAnimations()) {
      const fps = asked.get(animation);
      if (fps !== undefined) stepLoop(animation, shown(fps));
    }
  };

  document.addEventListener("animationstart", onLoopEvent, true);
  // A loop missed at its start (it began paused) is caught as it comes around.
  document.addEventListener("animationiteration", onLoopEvent, true);
  const stopAttention = attention.onChange(onAttentionChange);
  for (const animation of document.getAnimations()) adopt(animation);
  return () => {
    document.removeEventListener("animationstart", onLoopEvent, true);
    document.removeEventListener("animationiteration", onLoopEvent, true);
    stopAttention();
  };
}
