import { describe, expect, it } from "vite-plus/test";

import { DEVICE_FLOAT_MIN_WIDTH, fitDeviceFloat, resizeDeviceFloat } from "./deviceFloatLayout";

const PHONE = 9 / 19.5;
const inside = (
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
) =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= viewport.width &&
  rect.y + rect.height <= viewport.height;

describe("deviceFloatLayout", () => {
  it("stays inside the window, shrinking below its usual minimum in a short one", () => {
    const short = { width: 1200, height: 300 };
    const rect = fitDeviceFloat({
      position: { x: 900, y: 200 },
      width: 260,
      aspect: PHONE,
      viewport: short,
    });
    expect(rect.width).toBeLessThan(DEVICE_FLOAT_MIN_WIDTH);
    expect(inside(rect, short)).toBe(true);
  });

  it("resizes from the left edge keeping the right edge, within the window", () => {
    const viewport = { width: 1440, height: 900 };
    const start = fitDeviceFloat({
      position: { x: 800, y: 60 },
      width: 260,
      aspect: PHONE,
      viewport,
    });
    const wider = resizeDeviceFloat(start, "left", -100, 0, PHONE, viewport);
    expect(wider.width).toBe(start.width + 100);
    expect(wider.x + wider.width).toBe(start.x + start.width);
    const huge = resizeDeviceFloat(start, "bottomRight", 2000, 2000, PHONE, viewport);
    expect(inside(huge, viewport)).toBe(true);

    // Dragging the left edge past the left margin clamps width without drifting the right edge.
    const nearLeft = fitDeviceFloat({
      position: { x: 40, y: 60 },
      width: 260,
      aspect: PHONE,
      viewport,
    });
    const clampedLeft = resizeDeviceFloat(nearLeft, "left", -500, 0, PHONE, viewport);
    expect(inside(clampedLeft, viewport)).toBe(true);
    expect(clampedLeft.x + clampedLeft.width).toBe(nearLeft.x + nearLeft.width);
  });
});
