import { describe, expect, it } from "vite-plus/test";

import { duoLayout, duoTouchPoint, turnPoint, unturnPoint } from "./deviceFrameLayout";
import { deviceShape } from "./deviceShapes";

const duo = deviceShape({
  platform: "ios",
  model: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  physical: false,
});
if (duo?.kind !== "duo") throw new Error("the Duo's shape is missing");

describe("Duo layout", () => {
  it("maps a touch on the quarter-turned inner screen to its framebuffer, and marks the cover behind it", () => {
    const layout = duoLayout(
      {
        width: 2007,
        height: 2853,
        orientation: "landscape_left",
        screenId: 3,
        supportsHingeAngle: true,
        hingeAngle: 90,
      },
      duo,
    );
    expect(layout.panels.map((panel) => panel.id)).toEqual([1, 3]);
    expect(layout.turn).toBe(0);
    const inner = layout.panels[1]!;
    const screen = inner.box.screen;
    // A point near the inner screen's top left, as the user sees it.
    const hit = duoTouchPoint(
      layout,
      inner.x + screen.x + screen.width * 0.1,
      inner.y + screen.y + screen.height * 0.2,
    );
    expect(hit).toMatchObject({ panel: 3, active: true });
    expect(hit!.x).toBeCloseTo(0.2);
    expect(hit!.y).toBeCloseTo(0.9);
    const cover = layout.panels[0]!;
    expect(
      duoTouchPoint(layout, cover.x + cover.box.screen.x + 10, cover.y + cover.box.screen.y + 10),
    ).toMatchObject({ panel: 1, active: false });
  });

  it("turns points and back for every quarter turn", () => {
    for (const turn of [0, 90, 180, -90] as const) {
      const turned = turnPoint(30, 70, 200, 100, turn);
      expect(unturnPoint(turned.x, turned.y, 200, 100, turn)).toEqual({ x: 30, y: 70 });
    }
  });

  it("keeps the plain frame for an Android emulator without a hardware profile, unless it folds", () => {
    const emulator = { platform: "android", physical: false } as const;
    expect(deviceShape(emulator, { portraitAspect: 0.45 })).toBeNull();
    expect(
      deviceShape({ ...emulator, model: "medium_phone" }, { portraitAspect: 0.45 }),
    ).not.toBeNull();
    expect(deviceShape(emulator, { foldable: true, portraitAspect: 0.83 })).toMatchObject({
      body: { crease: "vertical" },
    });
  });
});
