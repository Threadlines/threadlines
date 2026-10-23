import { describe, expect, it } from "vite-plus/test";

import { hasActionableProposedPlan } from "./proposedPlans.ts";

const plan = (overrides: {
  readonly id: string;
  readonly implementedAt?: string | null;
  readonly dismissedAt?: string | null;
}) => ({
  id: overrides.id,
  turnId: "turn-1",
  implementedAt: overrides.implementedAt ?? null,
  dismissedAt: overrides.dismissedAt ?? null,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
});

const actionable = (proposedPlans: ReadonlyArray<ReturnType<typeof plan>>) =>
  hasActionableProposedPlan({ latestTurnId: "turn-1", proposedPlans, idOf: (entry) => entry.id });

describe("hasActionableProposedPlan", () => {
  it("waits on the user only while the newest plan is neither implemented nor dismissed", () => {
    expect(actionable([plan({ id: "a" })])).toBe(true);
    expect(actionable([plan({ id: "a", implementedAt: "2026-10-23T10:01:00.000Z" })])).toBe(false);
    expect(actionable([plan({ id: "a", dismissedAt: "2026-10-23T10:01:00.000Z" })])).toBe(false);
  });
});
