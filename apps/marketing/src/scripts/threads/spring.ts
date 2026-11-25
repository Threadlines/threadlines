/**
 * How a hero thread behaves like a string (tuned by hand; keep the numbers):
 * one damped spring per thread (an offset and a velocity), spread along the
 * thread by a smooth bump centred where it was touched. Pure.
 */
import { smooth } from "./geometry";

/** A slow, soft return. */
export const OMEGA = 17;
/** One small overshoot at most, settled in about half a second. */
export const ZETA = 0.6;
/** A flick only on a pass faster than this, in px a second. */
export const FLICK_MIN_SPEED = 260;
/** The largest flick, in px. */
export const FLICK_MAX = 11;
/** How much of a flick the thread on each side of it takes, and how much later. */
export const NEIGHBOUR_SHARE = 0.2;
export const NEIGHBOUR_DELAY_MS = 70;
/** The same thread flicks at most this often. */
export const FLICK_REST_MS = 520;
/** A press within this of a thread holds it; a pass within FLICK_REACH flicks it. */
export const HOLD_REACH = 10;
export const FLICK_REACH = 18;
export const TAP_REACH = 20;

export interface Spring {
  ox: number;
  oy: number;
  vx: number;
  vy: number;
}

/** The stretch of a held thread pulled `L` px: short and firm, stiffening early. */
export const holdReach = (L: number) => 34 * Math.tanh(L / 60);

/** A held thread's offset toward the pointer. */
export function holdOffset(dx: number, dy: number): [number, number] {
  const L = Math.hypot(dx, dy) || 1;
  const reach = holdReach(L);
  return [(dx / L) * reach, (dy / L) * reach];
}

/** The flick a pass at `speed` px a second gives, in px. */
export const flickAmplitude = (speed: number) => Math.min(FLICK_MAX, Math.max(2, speed * 0.012));

/** The velocity kick for a pass in direction (dx, dy) at `speed`: mostly sideways. */
export function flickVelocity(dx: number, dy: number, speed: number): [number, number] {
  const len = Math.hypot(dx, dy) || 1;
  const v = flickAmplitude(speed) * OMEGA;
  return [(dx / len) * v, (dy / len) * 0.35 * v];
}

/** How far a point at `t` (0..1 along the pullable part) moves with an offset centred at `tg`. Both ends stay put. */
export const bumpAt = (t: number, tg: number) =>
  t <= tg ? smooth(t / Math.max(0.001, tg)) : smooth((1 - t) / Math.max(0.001, 1 - tg));

/**
 * Advances a free spring by `dt` seconds. Returns true once it has settled,
 * with offset and velocity exactly zero, so the thread gets its rest shape back.
 * With reduced motion it eases straight back, without ringing.
 */
export function stepSpring(s: Spring, dt: number, reduced: boolean): boolean {
  if (reduced) {
    s.ox *= 0.78;
    s.oy *= 0.78;
    s.vx = 0;
    s.vy = 0;
  } else {
    // Semi-implicit Euler, two substeps for stability.
    for (let n = 0; n < 2; n++) {
      const h = dt / 2;
      s.vx += (-OMEGA * OMEGA * s.ox - 2 * ZETA * OMEGA * s.vx) * h;
      s.vy += (-OMEGA * OMEGA * s.oy - 2 * ZETA * OMEGA * s.vy) * h;
      s.ox += s.vx * h;
      s.oy += s.vy * h;
    }
  }
  if (Math.hypot(s.ox, s.oy) < 0.25 && Math.hypot(s.vx, s.vy) < 6) {
    s.ox = 0;
    s.oy = 0;
    s.vx = 0;
    s.vy = 0;
    return true;
  }
  return false;
}
