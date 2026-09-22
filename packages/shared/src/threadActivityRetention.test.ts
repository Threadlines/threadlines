import { describe, expect, it } from "vite-plus/test";

import { retainThreadActivities } from "./threadActivityRetention.ts";

describe("retainThreadActivities", () => {
  it("keeps only the latest plan update from before the recent window", () => {
    const activities = [
      { id: "plan-1", kind: "turn.plan.updated", payload: { plan: [] } },
      { id: "plan-2", kind: "turn.plan.updated", payload: { plan: [] } },
      { id: "open", kind: "approval.requested", payload: { requestId: "r1" } },
      { id: "old-note", kind: "runtime.note" },
      { id: "recent-1", kind: "tool.started" },
      { id: "recent-2", kind: "tool.completed" },
    ];

    expect(retainThreadActivities(activities, 2).map((activity) => activity.id)).toEqual([
      "plan-2",
      "open",
      "recent-1",
      "recent-2",
    ]);
  });

  it("returns the log untouched while it fits the window", () => {
    const activities = [{ id: "a", kind: "runtime.note" }];
    expect(retainThreadActivities(activities, 5)).toEqual(activities);
  });
});
