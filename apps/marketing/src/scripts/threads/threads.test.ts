import { describe, expect, it } from "vite-plus/test";

import { type Box, heroDrawing, lineAt, ringEntry, stretch, twistSpec } from "./geometry";
import { holdReach, type Spring, stepSpring } from "./spring";

const box = (l: number, t: number, w: number, h: number): Box => ({
  l,
  t,
  w,
  h,
  r: l + w,
  b: t + h,
  cx: l + w / 2,
  cy: t + h / 2,
});

describe("the twist", () => {
  for (const phone of [false, true]) {
    it(`keeps nine separate lines all the way into the ring${phone ? " on a phone" : ""}`, () => {
      const spec = twistSpec({ x: 600, ringY: 700, phone });
      const stroke = phone ? 1.5 : 1.9;
      for (let s = 0; s <= spec.height; s += 0.5) {
        // Neighbours in a band never touch: their centres stay more than a stroke apart.
        for (let j = 0; j < spec.count - 1; j++) {
          if (j === spec.nLeft - 1) continue;
          const a = lineAt(spec, j, s);
          const b = lineAt(spec, j + 1, s);
          expect(
            Math.hypot(a[0] - b[0], a[1] - b[1]),
            `threads ${j} and ${j + 1} at ${s}`,
          ).toBeGreaterThan(stroke + 0.6);
        }
      }
      const entries = Array.from({ length: spec.count }, (_, j) => ringEntry(spec, j).p);
      for (let j = 0; j < entries.length - 1; j++) {
        const [a, b] = [entries[j]!, entries[j + 1]!];
        expect(
          Math.hypot(a[0] - b[0], a[1] - b[1]),
          `ring entries ${j} and ${j + 1}`,
        ).toBeGreaterThan(stroke);
      }
    });
  }

  it("draws the hero with every thread starting at its logo and ending in the ring", () => {
    const chips = [
      ...Array.from({ length: 5 }, (_, i) => box(140 + i * 52, 90, 42, 42)),
      ...Array.from({ length: 4 }, (_, i) => box(1090 + i * 52, 90, 42, 42)),
    ];
    const drawing = heroDrawing(
      {
        chips,
        h1: box(420, 150, 600, 120),
        sub: box(440, 285, 560, 60),
        cta: box(570, 360, 300, 85),
        window: box(144, 655, 1152, 660),
        ringX: 700,
      },
      { phone: false, split: true },
    );
    expect(drawing.threads).toHaveLength(9);
    for (const thread of drawing.threads) {
      const chip = chips[thread.j]!;
      expect(thread.start[0]).toBeCloseTo(chip.cx);
      const end = thread.tail[thread.tail.length - 1]!;
      expect(Math.hypot(end[0] - 700, end[1] - 655)).toBeLessThan(drawing.spec.ringR);
      // The pullable part ends where the twist begins, so a pulled string never moves the twist.
      const headEnd = thread.head[thread.head.length - 1]!;
      expect(headEnd[1]).toBeCloseTo(
        drawing.spec.ringY - drawing.spec.tail - drawing.spec.height,
        5,
      );
    }
  });
});

describe("a string", () => {
  it("returns exactly to rest from a held stretch, and the loop can stop", () => {
    const [ox, oy] = [holdReach(200), 0];
    expect(ox).toBeLessThanOrEqual(34);
    const s: Spring = { ox, oy, vx: 0, vy: 0 };
    let frames = 0;
    while (!stepSpring(s, 1 / 60, false)) {
      frames++;
      expect(frames).toBeLessThan(120);
    }
    expect(s).toEqual({ ox: 0, oy: 0, vx: 0, vy: 0 });
    // Settled stays settled: the next step reports rest at once, so the loop stops.
    expect(stepSpring(s, 1 / 60, false)).toBe(true);
  });

  it("eases straight back without ringing under reduced motion", () => {
    const s: Spring = { ox: 20, oy: -5, vx: 300, vy: 0 };
    let last = Math.hypot(s.ox, s.oy);
    while (!stepSpring(s, 1 / 60, true)) {
      const now = Math.hypot(s.ox, s.oy);
      expect(now).toBeLessThan(last);
      last = now;
    }
    expect(s.ox).toBe(0);
  });
});

describe("a pulse's stretch", () => {
  it("is cut from the lane's own points, so it stays on a bent string", () => {
    // An L-shaped lane: 100px right, then 100px down.
    const pts = [
      [0, 0],
      [100, 0],
      [100, 100],
    ] as const;
    const dist = [0, 100, 200];
    const d = stretch(pts, dist, 80, 140);
    const points = d
      .slice(1)
      .split("L")
      .map((xy) => xy.split(" ").map(Number) as [number, number]);
    expect(points[0]).toEqual([80, 0]);
    expect(points).toContainEqual([100, 0]);
    expect(points[points.length - 1]).toEqual([100, 40]);
    // Off either end it is clipped, and nothing is left past the end.
    expect(stretch(pts, dist, -30, 10)).toBe("M0 0L10 0");
    expect(stretch(pts, dist, 210, 260)).toBe("");
  });
});
