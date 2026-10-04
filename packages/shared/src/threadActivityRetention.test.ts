import { describe, expect, it } from "vite-plus/test";

import { MAX_RETAINED_PLAN_UPDATES, retainThreadActivities } from "./threadActivityRetention.ts";

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

  it("keeps every plan update from the turn that last updated the plan", () => {
    const activities = [
      { id: "plan-old-turn", kind: "turn.plan.updated", turnId: "turn-1", payload: {} },
      { id: "plan-start", kind: "turn.plan.updated", turnId: "turn-2", payload: {} },
      { id: "note", kind: "runtime.note", turnId: "turn-2" },
      { id: "plan-step-2", kind: "turn.plan.updated", turnId: "turn-2", payload: {} },
      { id: "recent-1", kind: "tool.started", turnId: "turn-2" },
      { id: "recent-2", kind: "tool.completed", turnId: "turn-2" },
    ];

    // The task list times its steps from these, so they outlive the window.
    expect(retainThreadActivities(activities, 2).map((activity) => activity.id)).toEqual([
      "plan-start",
      "plan-step-2",
      "recent-1",
      "recent-2",
    ]);
  });

  it("keeps no more than the newest plan updates of an endlessly replanning turn", () => {
    const planUpdates = Array.from({ length: MAX_RETAINED_PLAN_UPDATES + 20 }, (_, index) => ({
      id: `plan-${index}`,
      kind: "turn.plan.updated",
      turnId: "turn-1",
      payload: {},
    }));
    const activities = [
      ...planUpdates,
      { id: "recent-1", kind: "tool.started", turnId: "turn-1" },
      { id: "recent-2", kind: "tool.completed", turnId: "turn-1" },
    ];

    const retainedPlans = retainThreadActivities(activities, 2).filter(
      (activity) => activity.kind === "turn.plan.updated",
    );
    expect(retainedPlans).toHaveLength(MAX_RETAINED_PLAN_UPDATES);
    expect(retainedPlans.at(-1)?.id).toBe(`plan-${MAX_RETAINED_PLAN_UPDATES + 19}`);
  });

  it("returns the log untouched while it fits the window", () => {
    const activities = [{ id: "a", kind: "runtime.note" }];
    expect(retainThreadActivities(activities, 5)).toEqual(activities);
  });
});
