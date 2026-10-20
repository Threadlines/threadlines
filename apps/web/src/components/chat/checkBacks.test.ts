import { describe, expect, it } from "vite-plus/test";

import { describeCheckBack, formatCheckBackCountdown } from "./checkBacks";

const base = {
  id: "wake-1",
  participantId: null,
  exact: true,
  recurring: false,
  durable: false,
} as const;

describe("check-back wording", () => {
  it("says when a one-shot comes back and how long until then, and how often a repeating one does", () => {
    const now = new Date(2026, 9, 20, 15, 28).getTime();
    const oneShot = describeCheckBack(
      { ...base, scheduledFor: new Date(2026, 9, 20, 15, 42).toISOString() },
      now,
    );
    expect(oneShot.label).toMatch(/^Checks back at 3:42/u);
    expect(oneShot.when).toBe("in 14m");
    const tomorrow = describeCheckBack(
      { ...base, exact: false, scheduledFor: new Date(2026, 9, 21, 9, 0).toISOString() },
      now,
    );
    expect(tomorrow.label).toMatch(/^Checks back tomorrow at 9:00/u);
    const repeating = describeCheckBack(
      {
        ...base,
        exact: false,
        recurring: true,
        schedule: "every 5 minutes",
        scheduledFor: new Date(2026, 9, 20, 15, 30).toISOString(),
      },
      now,
    );
    expect(repeating.label).toBe("Checks back every 5 minutes");
    expect(repeating.when).toMatch(/^next around 3:30/u);
    expect(formatCheckBackCountdown(new Date(now + 3 * 3_600_000).toISOString(), now)).toBe(
      "in 3h",
    );
  });
});
