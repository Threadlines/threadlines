import { describe, expect, it } from "vitest";

import { coveredBoxIndices, coveredBoxIndicesSource } from "./regionSelection.ts";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe("coveredBoxIndices", () => {
  const region = box(0, 0, 100, 100);

  it("takes a box the rectangle mostly covers and leaves one it only clips", () => {
    const boxes = [
      // Fully inside.
      box(10, 10, 50, 50),
      // Nine tenths inside: a hurried drag, not a different intent.
      box(10, 10, 100, 110),
      // A tenth inside: the rectangle brushed past it.
      box(90, 90, 190, 190),
      // Not touching at all.
      box(200, 200, 300, 300),
    ];

    expect(coveredBoxIndices(boxes, region, 0.8)).toEqual([0, 1]);
  });

  it("leaves out the container the rectangle is merely drawn inside", () => {
    // The reason coverage is measured against the box rather than the region:
    // a rectangle drawn in the middle of a page overlaps every wrapper around
    // it, and intersection alone would select the whole document.
    expect(coveredBoxIndices([box(-500, -500, 1500, 1500)], region, 0.8)).toEqual([]);
  });

  it("ignores boxes with no area", () => {
    expect(coveredBoxIndices([box(10, 10, 10, 50), box(10, 10, 50, 10)], region, 0.8)).toEqual([]);
  });

  it("stays inlinable into the page overlay", () => {
    // The overlay evaluates this function's source inside the guest. If a
    // bundler ever rewrites it to reach for a helper, the overlay dies silently
    // and picking simply stops working.
    const source = coveredBoxIndicesSource();
    expect(source).toContain("Math.min");
    expect(source).not.toContain("import");
  });
});
