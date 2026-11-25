/**
 * The threads' shapes (docs/design/design-language.md, "Marketing site"):
 * curves, the gathered curtains in the hero, the twist where the nine threads
 * cross over each other, and the ribbons each thread is painted as. Pure: every
 * function takes measured boxes and returns points, so it can be tested.
 */

export type Pt = readonly [number, number];

/** A box measured relative to the drawing's origin. */
export interface Box {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
}

/** One decimal: path data stays short. */
export const f = (value: number) => Math.round(value * 10) / 10;

/** A polyline as path data. */
export const poly = (pts: ReadonlyArray<Pt>) =>
  pts.length === 0 ? "" : "M" + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join("L");

/** Smoothstep, clamped to 0..1. */
export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function lengthOf(pts: ReadonlyArray<Pt>): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return total;
}

/** A cubic Bézier as points, about every `step` px, without its first point. */
export function bez(p0: Pt, p1: Pt, p2: Pt, p3: Pt, step = 3): Pt[] {
  const n = Math.max(8, Math.ceil(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / step));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** The switch curve: vertical at both ends (the end slope can be set). */
export function sbend(a: Pt, b: Pt, k = 0.55, endSlope = 0, k2 = k): Pt[] {
  const dy = b[1] - a[1];
  return bez(a, [a[0], a[1] + dy * k], [b[0] - endSlope * dy * k2, b[1] - dy * k2], b);
}

/** A quarter turn between a vertical and a horizontal run. */
export function quarter(a: Pt, b: Pt, verticalFirst: boolean): Pt[] {
  const k = 0.552;
  return verticalFirst
    ? bez(a, [a[0], a[1] + (b[1] - a[1]) * k], [b[0] - (b[0] - a[0]) * k, b[1]], b)
    : bez(a, [a[0] + (b[0] - a[0]) * k, a[1]], [b[0], b[1] - (b[1] - a[1]) * k], b);
}

/** x as a monotone cubic of y through the knots, flat at the top. */
export function curtain(knots: ReadonlyArray<Pt>, step = 3, endSlope: number | "secant" = 0): Pt[] {
  const n = knots.length;
  const sec: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    sec.push((knots[i + 1]![0] - knots[i]![0]) / (knots[i + 1]![1] - knots[i]![1]));
  }
  const d = knots.map((_, i) => {
    if (i === 0) return 0;
    if (i === n - 1) return endSlope === "secant" ? sec[n - 2]! : endSlope;
    const a = sec[i - 1]!;
    const b = sec[i]!;
    return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b);
  });
  const out: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = knots[i]!;
    const [x1, y1] = knots[i + 1]!;
    const h = y1 - y0;
    const steps = Math.max(4, Math.ceil(h / step));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        (2 * t3 - 3 * t2 + 1) * x0 +
          (t3 - 2 * t2 + t) * h * d[i]! +
          (-2 * t3 + 3 * t2) * x1 +
          (t3 - t2) * h * d[i + 1]!,
        y0 + h * t,
      ]);
    }
  }
  return out;
}

/** A filled stroke whose width follows width(distance, total) along the points: paint, not wire. */
export function ribbonOf(
  pts: ReadonlyArray<Pt>,
  width: (distance: number, total: number) => number,
): string {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  }
  const total = lens[lens.length - 1]!;
  const left: Pt[] = [];
  const right: Pt[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const w = width(lens[i]!, total) / 2;
    left.push([p[0] + nx * w, p[1] + ny * w]);
    right.push([p[0] - nx * w, p[1] - ny * w]);
  });
  return poly([...left, ...right.toReversed()]) + "Z";
}

/** The index of the last entry at or before `d`. */
function indexAt(dist: ReadonlyArray<number>, d: number) {
  let lo = 0;
  let hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The stretch of a polyline between distances a and b along it (`dist`: the distance at each point), as path data. */
export function stretch(
  pts: ReadonlyArray<Pt>,
  dist: ReadonlyArray<number>,
  a: number,
  b: number,
): string {
  const L = dist[dist.length - 1] ?? 0;
  const from = Math.max(0, a);
  const to = Math.min(L, b);
  if (to - from < 0.5 || pts.length < 2) return "";
  const at = (d: number): Pt => {
    const i = Math.min(indexAt(dist, d), pts.length - 2);
    const span = dist[i + 1]! - dist[i]! || 1;
    const t = (d - dist[i]!) / span;
    return [
      pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t,
      pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t,
    ];
  };
  const out: Pt[] = [at(from)];
  for (let i = indexAt(dist, from) + 1; i < pts.length && dist[i]! < to; i++) out.push(pts[i]!);
  out.push(at(to));
  return "M" + out.map((p) => `${f(p[0])} ${f(p[1])}`).join("L");
}

// ---------------------------------------------------------------------------
// The twist: the left curtain's threads and the right curtain's arrive as two
// flat bands, cross over each other twice (left in front, then right), and run
// into the ring on the window's edge like thread through the eye of a needle.
// Nine separate lines the whole way.

export interface TwistSpec {
  /** The ring's centre x, over the thread's name in the window. */
  readonly x: number;
  /** The window's top edge, where the ring sits. */
  readonly ringY: number;
  /** Threads in the left band; the rest are in the right. */
  readonly nLeft: number;
  readonly count: number;
  /** Stroke plus a clear gap between neighbours in a band. */
  readonly bandPitch: number;
  /** How far each band swings from the middle. */
  readonly amplitude: number;
  /** Height of the twist. */
  readonly height: number;
  /** From the twist's foot to the ring. */
  readonly tail: number;
  /** The ring's outer radius. */
  readonly ringR: number;
}

/** The tuned twist (about 98px tall and 41px wide on wide screens). */
export function twistSpec(input: {
  x: number;
  ringY: number;
  phone: boolean;
  nLeft?: number;
  count?: number;
}): TwistSpec {
  const { phone } = input;
  return {
    x: input.x,
    ringY: input.ringY,
    nLeft: input.nLeft ?? 5,
    count: input.count ?? 9,
    bandPitch: phone ? 3.1 : 3.7,
    amplitude: phone ? 9.5 : 13.5,
    height: phone ? 78 : 98,
    tail: phone ? 28 : 34,
    ringR: 10.5,
  };
}

/** Where the twist starts. */
export const twistTop = (spec: TwistSpec) => spec.ringY - spec.tail - spec.height;

/** A band's centre at depth `s` into the twist: vertical at both ends, crossing at a quarter and three quarters. */
export function bandAt(spec: TwistSpec, band: 0 | 1, s: number) {
  const th = (Math.PI * 2 * s) / spec.height;
  const sign = band === 0 ? -1 : 1;
  return {
    x: spec.x + sign * spec.amplitude * Math.cos(th),
    dx: -sign * spec.amplitude * Math.sin(th) * ((Math.PI * 2) / spec.height),
    front: band === 0 ? Math.sin(th) > 0 : Math.sin(th) < 0,
  };
}

export const bandOf = (spec: TwistSpec, j: number): 0 | 1 => (j < spec.nLeft ? 0 : 1);

/** Thread `j` at depth `s` into the twist: offset across its band, perpendicular to the band. */
export function lineAt(spec: TwistSpec, j: number, s: number): Pt {
  const band = bandOf(spec, j);
  const n = band === 0 ? spec.nLeft : spec.count - spec.nLeft;
  const k = band === 0 ? j : j - spec.nLeft;
  const off = (k - (n - 1) / 2) * spec.bandPitch;
  const c = bandAt(spec, band, s);
  const len = Math.hypot(1, c.dx);
  return [c.x + off / len, twistTop(spec) + s - (off * c.dx) / len];
}

/** Where thread `j` enters the ring: spread round its top so neighbours never touch. */
export function ringEntry(spec: TwistSpec, j: number) {
  const spread = (Math.PI / 180) * 66;
  const ang = -spread + (2 * spread * j) / (spec.count - 1);
  const r = spec.ringR;
  return {
    p: [spec.x + Math.sin(ang) * (r - 3), spec.ringY - Math.cos(ang) * (r - 3)] as Pt,
    dir: [Math.sin(ang), -Math.cos(ang)] as Pt,
    edge: [spec.x + Math.sin(ang) * r, spec.ringY - Math.cos(ang) * r] as Pt,
  };
}

/** Thread `j` through the twist and into the ring. */
export function twistAndInto(spec: TwistSpec, j: number): Pt[] {
  const twist: Pt[] = [];
  for (let s = 1; s <= spec.height + 0.01; s += 1) twist.push(lineAt(spec, j, s));
  const end = twist[twist.length - 1]!;
  const r = ringEntry(spec, j);
  const into = bez(
    end,
    [end[0], end[1] + spec.tail * 0.45],
    [r.edge[0] - r.dir[0] * spec.tail * 0.4, r.edge[1] - r.dir[1] * spec.tail * 0.4],
    r.p,
  );
  return [...twist, ...into];
}

/** The stretches where thread `j`'s band passes in front; they cut a casing out of the other band. */
export function frontRuns(spec: TwistSpec, j: number): Pt[][] {
  const band = bandOf(spec, j);
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  for (let s = 0; s <= spec.height + 0.01; s += 1) {
    if (bandAt(spec, band, s).front) run.push(lineAt(spec, j, s));
    else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// ---------------------------------------------------------------------------
// The hero: nine threads fall from the logos, gather either side of the
// headline like curtains, and run into the twist.

export interface HeroBoxes {
  /** Each agent's chip, in thread order. */
  readonly chips: ReadonlyArray<Box>;
  readonly h1: Box;
  readonly sub: Box;
  readonly cta: Box;
  readonly window: Box;
  /** The ring's x: the centre of the thread's name in the window. */
  readonly ringX: number;
}

export interface HeroThread {
  readonly j: number;
  readonly band: 0 | 1;
  /** Where the thread leaves its logo. */
  readonly start: Pt;
  /** From the logo to the top of the twist: the part a pointer can pull. */
  readonly head: Pt[];
  /** Through the twist and into the ring. */
  readonly tail: Pt[];
  readonly frontRuns: Pt[][];
}

export interface HeroDrawing {
  readonly spec: TwistSpec;
  readonly threads: HeroThread[];
  readonly strokeW: number;
  /** The ribbon's width at the logo, tapering to strokeW. */
  readonly drop: number;
  readonly taper: number;
  /** The drawing's height. */
  readonly height: number;
}

/**
 * The hero's threads for these boxes. `split`: two groups of logos stand
 * either side of the headline (wide screens), so the threads fall straight;
 * otherwise they arc out from one row of logos.
 */
export function heroDrawing(
  boxes: HeroBoxes,
  opts: { phone: boolean; split: boolean; nLeft?: number },
): HeroDrawing {
  const { phone, split } = opts;
  const { chips, h1, sub, cta, window: w } = boxes;
  const count = chips.length;
  const nLeft = opts.nLeft ?? 5;
  const g = phone ? 4.4 : 12;
  const pad = phone ? 10 : 40;
  const yD = cta.b + (phone ? 10 : 6);
  const yTop = split ? chips[0]!.b : h1.t - 10;
  const leftZone = [h1.l - pad, sub.l - pad, cta.l - pad * 0.8] as const;
  const rightZone = [h1.r + pad, sub.r + pad, cta.r + pad * 0.8] as const;
  const innerL0 = split ? Math.min(chips[nLeft - 1]!.cx, leftZone[0]) : leftZone[0];
  const innerR0 = split ? Math.max(chips[nLeft]!.cx, rightZone[0]) : rightZone[0];
  const knotsL: Pt[] = [
    [innerL0, yTop],
    [innerL0, h1.b],
    [Math.max(innerL0, Math.min(leftZone[1], leftZone[2])), sub.b + 4],
    [Math.max(innerL0, leftZone[2]), yD],
  ];
  const knotsR: Pt[] = [
    [innerR0, yTop],
    [innerR0, h1.b],
    [Math.min(innerR0, Math.max(rightZone[1], rightZone[2])), sub.b + 4],
    [Math.min(innerR0, rightZone[2]), yD],
  ];
  const innerL: Pt[] = [[innerL0, yTop], ...curtain(knotsL, 3, "secant")];
  const innerR: Pt[] = [[innerR0, yTop], ...curtain(knotsR, 3, "secant")];
  const pitchL = split ? (chips[nLeft - 1]!.cx - chips[0]!.cx) / (nLeft - 1) : g;
  const pitchR = split ? (chips[count - 1]!.cx - chips[nLeft]!.cx) / (count - nLeft - 1) : g;
  const spacing = (y: number, p: number) =>
    p + (g - p) * smooth((y - yTop - 8) / Math.max(40, h1.b - yTop + 20));

  const spec = twistSpec({ x: boxes.ringX, ringY: w.t, phone, nLeft, count });
  const threads = chips.map((chip, j): HeroThread => {
    const left = j < nLeft;
    const k = left ? nLeft - 1 - j : j - nLeft;
    const inner = left ? innerL : innerR;
    const p = left ? pitchL : pitchR;
    const curtainPts = inner.map(([x, y]): Pt => [
      left ? x - k * spacing(y, p) : x + k * spacing(y, p),
      y,
    ]);
    const start: Pt = [chip.cx, chip.b - 2];
    const slot = lineAt(spec, j, 0);
    let lead: Pt[];
    if (split) {
      lead = [start, ...curtainPts.filter((q) => q[1] > start[1] + 1)];
    } else {
      const a0 = curtainPts[0]!;
      const dy = a0[1] - start[1];
      const dx = a0[0] - start[0];
      lead = [
        start,
        ...bez(start, [start[0] + dx * 0.3, start[1] + dy * 0.5], [a0[0], a0[1] - dy * 0.5], a0),
        ...curtainPts.slice(1),
      ];
    }
    const last = lead[lead.length - 1]!;
    const prev = lead[lead.length - 2] ?? last;
    const m = (last[0] - prev[0]) / Math.max(0.5, last[1] - prev[1]);
    const hh = slot[1] - last[1];
    const head = [
      ...lead,
      ...bez(
        last,
        [last[0] + m * hh * 0.42, last[1] + hh * 0.42],
        [slot[0], slot[1] - hh * 0.5],
        slot,
      ),
    ];
    return {
      j,
      band: bandOf(spec, j),
      start,
      head,
      tail: twistAndInto(spec, j),
      frontRuns: frontRuns(spec, j),
    };
  });
  return {
    spec,
    threads,
    strokeW: phone ? 1.5 : 1.9,
    drop: phone ? 3.8 : 5,
    taper: phone ? 8 : 11,
    height: Math.ceil(w.t + 12),
  };
}

/** The ribbon width at distance `d` from the logo: a drop at the logo tapering to the thread. */
export const threadWidth =
  (drawing: Pick<HeroDrawing, "strokeW" | "drop" | "taper">) => (d: number) =>
    drawing.strokeW + (drawing.drop - drawing.strokeW) * Math.exp(-d / drawing.taper);
