import { describe, expect, it } from "vitest";

import { buildDrawOverlayScript, DRAW_OVERLAY_TEARDOWN_SCRIPT } from "./drawOverlayScript.ts";
import { buildPickOverlayScript, PICK_OVERLAY_TEARDOWN_SCRIPT } from "./pickOverlayScript.ts";

/**
 * The overlay is a string that only ever runs inside the guest page, where a
 * syntax error is invisible: Runtime.evaluate reports it to nobody, the overlay
 * never appears, and picking looks like a dead button. That has happened once
 * already -- an escape sequence collapsed inside the template literal and left
 * an unbalanced group. Parsing it here is what makes that loud.
 */
describe("buildPickOverlayScript", () => {
  const modes = ["element", "region"] as const;
  const schemes = ["light", "dark"] as const;

  for (const mode of modes) {
    for (const scheme of schemes) {
      it(`parses as JavaScript for ${mode} picking in ${scheme} mode`, () => {
        const script = buildPickOverlayScript(scheme, mode);
        expect(() => new Function(script)).not.toThrow();
      });
    }
  }

  it("parses the teardown script", () => {
    expect(() => new Function(PICK_OVERLAY_TEARDOWN_SCRIPT)).not.toThrow();
  });

  it("parses the drawing overlay in both of its modes", () => {
    expect(() => new Function(buildDrawOverlayScript("draw"))).not.toThrow();
    expect(() => new Function(buildDrawOverlayScript("erase"))).not.toThrow();
    expect(() => new Function(DRAW_OVERLAY_TEARDOWN_SCRIPT)).not.toThrow();
  });

  it("arms the pointer handlers each mode needs and no others", () => {
    const region = buildPickOverlayScript("dark", "region");
    const element = buildPickOverlayScript("dark", "element");

    // The drag handlers and the hover handler are mutually exclusive: leaving
    // hover armed during a region drag would repaint the highlight from under
    // the rectangle on every frame.
    expect(region).toContain("const REGION_MODE = true");
    expect(element).toContain("const REGION_MODE = false");
  });
});
