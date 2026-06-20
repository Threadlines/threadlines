import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@threadlines/contracts";

import {
  filterSupersededManualContextCompactionActivities,
  hasActiveContextCompactionActivity,
} from "./contextCompactionActivities";

function makeActivity(input: {
  readonly id: string;
  readonly tone?: OrchestrationThreadActivity["tone"];
  readonly kind?: OrchestrationThreadActivity["kind"];
  readonly summary?: string;
  readonly payload?: unknown;
  readonly turnId?: TurnId | null;
  readonly createdAt?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: input.tone ?? "info",
    kind: input.kind ?? "context-compaction",
    summary: input.summary ?? "Compacting context...",
    payload: input.payload ?? {},
    turnId: input.turnId === undefined ? TurnId.make("turn-1") : input.turnId,
    createdAt: input.createdAt ?? "2026-06-19T20:14:01.000Z",
  };
}

describe("contextCompactionActivities", () => {
  it("keeps a manual synthetic compaction active when no concrete provider activity exists", () => {
    const activities = [
      makeActivity({
        id: "manual-start",
        payload: {
          status: "inProgress",
          state: "waiting",
          detail: { trigger: "manual" },
        },
      }),
    ];

    expect(filterSupersededManualContextCompactionActivities(activities)).toHaveLength(1);
    expect(hasActiveContextCompactionActivity(activities)).toBe(true);
  });

  it("hides the manual synthetic row once a concrete provider compaction activity starts", () => {
    const activities = [
      makeActivity({
        id: "manual-start",
        createdAt: "2026-06-19T20:14:01.000Z",
        payload: {
          status: "inProgress",
          state: "waiting",
          detail: { trigger: "manual" },
        },
      }),
      makeActivity({
        id: "provider-start",
        createdAt: "2026-06-19T20:14:02.000Z",
        payload: {
          status: "inProgress",
          sourceItemType: "context_compaction",
        },
      }),
    ];

    const filtered = filterSupersededManualContextCompactionActivities(activities);
    expect(filtered.map((activity) => activity.id)).toEqual(["provider-start"]);
    expect(hasActiveContextCompactionActivity(activities)).toBe(true);
  });

  it("does not keep a stale manual synthetic row active after provider completion", () => {
    const activities = [
      makeActivity({
        id: "manual-start",
        createdAt: "2026-06-19T20:14:01.000Z",
        payload: {
          status: "inProgress",
          state: "waiting",
          detail: { trigger: "manual" },
        },
      }),
      makeActivity({
        id: "provider-complete",
        createdAt: "2026-06-19T20:14:39.000Z",
        summary: "Context compacted",
        payload: {
          status: "completed",
          sourceItemType: "context_compaction",
        },
      }),
    ];

    const filtered = filterSupersededManualContextCompactionActivities(activities);
    expect(filtered.map((activity) => activity.id)).toEqual(["provider-complete"]);
    expect(hasActiveContextCompactionActivity(activities)).toBe(false);
  });
});
