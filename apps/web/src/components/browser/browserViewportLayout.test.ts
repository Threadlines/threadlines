import { describe, expect, it } from "vite-plus/test";

import { resolveBrowserViewportLayout } from "./browserViewportLayout";

const container = { width: 400, height: 600 };

describe("resolveBrowserViewportLayout", () => {
  it("fills the panel when no size is set", () => {
    const layout = resolveBrowserViewportLayout({
      container,
      viewport: { width: null, height: null },
    });

    expect(layout).toMatchObject({ x: 0, y: 0, width: 400, height: 600, scale: 1, fills: true });
  });

  it("centres a device that already fits, at its own size", () => {
    const layout = resolveBrowserViewportLayout({
      container,
      viewport: { width: 200, height: 400 },
    });

    // Never scaled up: a phone blown up to fill a wide panel misrepresents it.
    expect(layout.scale).toBe(1);
    expect(layout).toMatchObject({ width: 200, height: 400, x: 100, y: 100 });
  });

  it("scales a device down to fit, keeping its proportions", () => {
    const layout = resolveBrowserViewportLayout({
      container,
      viewport: { width: 400, height: 1200 },
    });

    expect(layout.scale).toBeCloseTo(0.5, 5);
    expect(layout.width).toBeCloseTo(200, 5);
    expect(layout.height).toBeCloseTo(600, 5);
    expect(layout.y).toBe(0);
  });

  it("fits against the zoomed size, since zoom is what is drawn", () => {
    const unzoomed = resolveBrowserViewportLayout({
      container,
      viewport: { width: 400, height: 600 },
    });
    const zoomed = resolveBrowserViewportLayout({
      container,
      viewport: { width: 400, height: 600 },
      zoomFactor: 2,
    });

    expect(unzoomed.scale).toBe(1);
    expect(zoomed.scale).toBeCloseTo(0.5, 5);
    // Same footprint on screen: zoom doubled it, fitting halved it back.
    expect(zoomed.width).toBeCloseTo(unzoomed.width, 5);
  });

  it("treats a nonsense zoom as no zoom rather than collapsing the frame", () => {
    const layout = resolveBrowserViewportLayout({
      container,
      viewport: { width: 200, height: 300 },
      zoomFactor: 0,
    });

    expect(layout.scale).toBe(1);
    expect(layout.width).toBe(200);
  });
});
