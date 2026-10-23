import { describe, expect, it } from "vite-plus/test";

import { applyAffine, composeAffine, frameAffine, frameToParentAffine } from "./frameAffine.ts";

const at = (
  quad: ReadonlyArray<number>,
  size: { width: number; height: number },
  x: number,
  y: number,
) => {
  const into = frameAffine(quad, size);
  if (into === null) throw new Error("no mapping");
  return applyAffine(into, { x, y });
};

describe("frameAffine", () => {
  it("maps a point into a frame however the parent draws it", () => {
    // Placed at (100,100), unscaled.
    expect(
      at([100, 100, 400, 100, 400, 300, 100, 300], { width: 300, height: 200 }, 250, 200),
    ).toEqual({ x: 150, y: 100 });
    // Drawn at half size (a zoom or a transform).
    expect(
      at([450, 100, 650, 100, 650, 200, 450, 200], { width: 400, height: 200 }, 550, 150),
    ).toEqual({ x: 200, y: 100 });
    // Stretched on one axis only, and mirrored on the other.
    expect(at([500, 0, 100, 0, 100, 100, 500, 100], { width: 200, height: 100 }, 300, 50)).toEqual({
      x: 100,
      y: 50,
    });
    // Turned a quarter clockwise about its top-left corner.
    const turned = at(
      [300, 100, 300, 300, 200, 300, 200, 100],
      { width: 200, height: 100 },
      250,
      150,
    );
    expect(turned.x).toBeCloseTo(50);
    expect(turned.y).toBeCloseTo(50);
    // Drawn flat: no mapping.
    expect(frameAffine([0, 0, 100, 0, 100, 0, 0, 0], { width: 100, height: 100 })).toBeNull();
  });

  it("maps a point in a frame back out to where the parent draws it", () => {
    const turned = [300, 100, 300, 300, 200, 300, 200, 100];
    const size = { width: 200, height: 100 };
    const out = applyAffine(frameToParentAffine(turned, size), { x: 50, y: 50 });
    expect(out.x).toBeCloseTo(250);
    expect(out.y).toBeCloseTo(150);
  });

  it("follows a frame inside a frame", () => {
    const outer = frameAffine([100, 320, 400, 320, 400, 480, 100, 480], {
      width: 300,
      height: 160,
    })!;
    const inner = frameAffine([20, 40, 220, 40, 220, 140, 20, 140], { width: 200, height: 100 })!;
    expect(applyAffine(composeAffine(inner, outer), { x: 170, y: 410 })).toEqual({ x: 50, y: 50 });
  });
});
