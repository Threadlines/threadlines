import { describe, expect, it } from "vite-plus/test";

import { computeRevealStep, updateIncomingRate } from "./useStreamingTextReveal";

describe("computeRevealStep", () => {
  it("reveals at the incoming rate and never passes the real text", () => {
    const shown = computeRevealStep({ shown: 100, total: 160, rate: 1_000, dtSeconds: 1 / 60 });
    expect(shown).toBeCloseTo(100 + 1_000 / 60, 3);
    expect(computeRevealStep({ shown: 159, total: 160, rate: 1_000, dtSeconds: 1 })).toBe(160);
  });

  it("speeds up once the backlog exceeds the allowed trail", () => {
    const rate = 1_000;
    const calm = computeRevealStep({ shown: 0, total: 100, rate, dtSeconds: 0.016 });
    const behind = computeRevealStep({ shown: 0, total: 1_000, rate, dtSeconds: 0.016 });
    expect(behind).toBeGreaterThan(calm);
  });
});

describe("updateIncomingRate", () => {
  it("seeds from the first flush and then smooths", () => {
    const first = updateIncomingRate(null, 50, 0.05);
    expect(first).toBe(1_000);
    const second = updateIncomingRate(first, 20, 0.05);
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(400);
  });
});
