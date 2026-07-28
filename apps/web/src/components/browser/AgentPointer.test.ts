import { describe, expect, it } from "vitest";

import { travelDurationMs } from "./AgentPointer";

/**
 * The glide is the whole point of moving rather than reappearing, and both ends
 * of it are wrong in a way that looks like a bug rather than a bad number.
 */
describe("travelDurationMs", () => {
  it("arrives instantly the first time, instead of flying in from the corner", () => {
    // Before the first action the pointer has no position, and animating from
    // the origin would send it across the page on every fresh turn.
    expect(travelDurationMs(null, { x: 400, y: 300 })).toBe(0);
  });

  it("keeps a short hop long enough to read as movement", () => {
    expect(travelDurationMs({ x: 100, y: 100 }, { x: 104, y: 100 })).toBe(220);
  });

  it("caps a long haul so the page does not change mid-flight", () => {
    // A click at the far corner would otherwise still be travelling while the
    // page it landed on has already navigated.
    expect(travelDurationMs({ x: 0, y: 0 }, { x: 1600, y: 1200 })).toBe(560);
  });

  it("scales with distance between those bounds", () => {
    const near = travelDurationMs({ x: 0, y: 0 }, { x: 300, y: 0 });
    const far = travelDurationMs({ x: 0, y: 0 }, { x: 500, y: 0 });

    expect(near).toBeGreaterThan(220);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(560);
  });
});
