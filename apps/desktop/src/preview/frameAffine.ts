/**
 * Mapping a point from one frame's viewport into a frame inside it, for agent
 * input sent straight into that frame (PreviewAutomation `routePoint`).
 */

/** `x' = a·x + b·y + e`, `y' = c·x + d·y + f`: from one frame's viewport into another's. */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY_AFFINE: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const applyAffine = (m: Affine, p: { readonly x: number; readonly y: number }) => ({
  x: m.a * p.x + m.b * p.y + m.e,
  y: m.c * p.x + m.d * p.y + m.f,
});

/** `outer` then `inner`. */
export const composeAffine = (inner: Affine, outer: Affine): Affine => ({
  a: inner.a * outer.a + inner.b * outer.c,
  b: inner.a * outer.b + inner.b * outer.d,
  c: inner.c * outer.a + inner.d * outer.c,
  d: inner.c * outer.b + inner.d * outer.d,
  e: inner.a * outer.e + inner.b * outer.f + inner.e,
  f: inner.c * outer.e + inner.d * outer.f + inner.f,
});

/**
 * From a parent's viewport into a child frame's, given the corners of the
 * frame's content box as the parent draws them (top-left, top-right,
 * bottom-right, bottom-left) and the frame's own viewport size. Null for a
 * frame drawn flat.
 */
export function frameAffine(
  quad: ReadonlyArray<number>,
  size: { readonly width: number; readonly height: number },
): Affine | null {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = quad;
  // Where one pixel of the frame along each of its axes lands in the parent.
  const ux = (x1 - x0) / size.width;
  const uy = (y1 - y0) / size.width;
  const vx = (x3 - x0) / size.height;
  const vy = (y3 - y0) / size.height;
  const det = ux * vy - vx * uy;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const a = vy / det;
  const b = -vx / det;
  const c = -uy / det;
  const d = ux / det;
  return { a, b, c, d, e: -(a * x0 + b * y0), f: -(c * x0 + d * y0) };
}
