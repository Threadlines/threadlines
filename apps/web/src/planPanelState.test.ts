import { describe, expect, it } from "vite-plus/test";

import { derivePlanTaskBadge } from "./planPanelState";
import type { ActivePlanState } from "./session-logic";

function plan(
  statuses: ReadonlyArray<ActivePlanState["steps"][number]["status"]>,
): ActivePlanState {
  return {
    createdAt: "2026-09-06T08:00:00.000Z",
    turnId: null,
    steps: statuses.map((status, index) => ({ step: `Step ${index + 1}`, status })),
  };
}

describe("derivePlanTaskBadge", () => {
  it("counts finished steps, not the step being worked on", () => {
    const badge = derivePlanTaskBadge({
      activePlan: plan(["completed", "inProgress", "pending"]),
      activeProposedPlan: null,
    });

    expect(badge).toMatchObject({ label: "1/3", tone: "active", pulse: true });
    expect(badge?.ariaLabel).toBe("Tasks, 1 of 3 done, working on step 2");
  });

  it("shows the queued count before anything starts and goes green when everything is done", () => {
    expect(
      derivePlanTaskBadge({ activePlan: plan(["pending", "pending"]), activeProposedPlan: null }),
    ).toMatchObject({ label: "2", tone: "ready", pulse: false });
    expect(
      derivePlanTaskBadge({
        activePlan: plan(["completed", "completed"]),
        activeProposedPlan: null,
      }),
    ).toMatchObject({ label: "2/2", tone: "complete", pulse: false });
  });
});
