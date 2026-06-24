import { describe, expect, it } from "vitest";

import type { SubagentProgressState } from "../../session-logic";
import {
  deriveSubagentDisplayDetails,
  deriveThreadActivityTriggerState,
  type ThreadTaskProgressState,
} from "./ThreadActivityPopover";

describe("deriveSubagentDisplayDetails", () => {
  it("promotes the goal and removes the workspace path from visible metadata", () => {
    const details = deriveSubagentDisplayDetails({
      objective:
        "Read-only exploration in C:\\Users\\Will\\Desktop\\Projects\\badcode. Goal: inspect the toast emitters and warning taxonomy before changing behavior",
      model: "gpt-5.5",
      reasoningEffort: "medium",
    });

    expect(details.goal).toBe(
      "inspect the toast emitters and warning taxonomy before changing behavior",
    );
    expect(details.context).toBe("Read-only exploration");
    expect(details.metadata.map((chip) => `${chip.title}:${chip.label}`)).toEqual([
      "Scope:Read-only exploration",
      "Model:gpt-5.5",
      "Reasoning:medium",
    ]);
    expect(details.metadata.map((chip) => chip.label).join(" ")).not.toContain("C:\\Users\\Will");
  });

  it("removes a workspace path from task-in-location objectives without a Goal marker", () => {
    const details = deriveSubagentDisplayDetails({
      objective:
        "Read-only task in C:\\Users\\Will\\Desktop\\Projects\\badcode. Inspect the current working tree changes related to subagent styling",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });

    expect(details.goal).toBe(
      "Inspect the current working tree changes related to subagent styling",
    );
    expect(details.context).toBe("Read-only task");
    expect(details.metadata.map((chip) => `${chip.title}:${chip.label}`)).toEqual([
      "Scope:Read-only task",
      "Model:gpt-5.5",
      "Reasoning:xhigh",
    ]);
  });

  it("keeps ordinary objective text when no Goal marker is present", () => {
    const details = deriveSubagentDisplayDetails({
      objective: "Review the terminal drawer hydration path",
      model: null,
      reasoningEffort: null,
    });

    expect(details.goal).toBe("Review the terminal drawer hydration path");
    expect(details.context).toBeNull();
    expect(details.metadata).toEqual([]);
  });
});

describe("deriveThreadActivityTriggerState", () => {
  it("hides when there is no thread activity", () => {
    expect(
      deriveThreadActivityTriggerState({
        taskProgress: null,
        subagentProgress: null,
        backgroundRuns: [],
      }),
    ).toBeNull();
  });

  it("uses task-specific trigger state when only tasks are active", () => {
    const taskProgress: ThreadTaskProgressState = {
      activePlan: {
        createdAt: "2026-06-23T00:00:00.000Z",
        turnId: null,
        steps: [
          { step: "Wire the Activity popover", status: "inProgress" },
          { step: "Run validation", status: "pending" },
        ],
      },
      activeProposedPlan: null,
      badge: {
        label: "1/2",
        ariaLabel: "Tasks, working on step 1 of 2",
        tone: "active",
        pulse: true,
      },
      label: "Tasks",
    };

    const state = deriveThreadActivityTriggerState({
      taskProgress,
      subagentProgress: null,
      backgroundRuns: [],
    });

    expect(state?.mode).toBe("tasks");
    expect(state?.badge?.label).toBe("1/2");
    expect(state?.chips).toHaveLength(1);
  });

  it("uses subagent-specific trigger state when only subagents are active", () => {
    const subagentProgress: SubagentProgressState = {
      items: [],
      activeCount: 2,
      completedCount: 0,
      failedCount: 0,
      totalCount: 2,
      summary: "2 subagents running",
      badge: {
        label: "2",
        ariaLabel: "2 subagents running",
        tone: "active",
        pulse: true,
      },
    };

    const state = deriveThreadActivityTriggerState({
      taskProgress: null,
      subagentProgress,
      backgroundRuns: [],
    });

    expect(state?.mode).toBe("subagents");
    expect(state?.badge?.label).toBe("2");
    expect(state?.chips[0]?.kind).toBe("subagents");
  });

  it("uses a background trigger state when only background runs are active", () => {
    const state = deriveThreadActivityTriggerState({
      taskProgress: null,
      subagentProgress: null,
      backgroundRuns: [
        {
          id: "terminal:default",
          source: "terminal",
          terminalId: "default",
          pid: null,
          port: null,
          elapsed: null,
          canStop: true,
          label: "Terminal 1",
          detail: "C:\\repo",
          cwd: "C:\\repo",
          statusLabel: "Running",
          urls: [],
        },
      ],
    });

    expect(state?.mode).toBe("background");
    expect(state?.badge?.label).toBe("1");
    expect(state?.chips[0]?.kind).toBe("background");
  });

  it("uses grouped chips when multiple activity kinds are active", () => {
    const taskProgress: ThreadTaskProgressState = {
      activePlan: {
        createdAt: "2026-06-23T00:00:00.000Z",
        turnId: null,
        steps: [
          { step: "Wire the Activity popover", status: "inProgress" },
          { step: "Run validation", status: "pending" },
        ],
      },
      activeProposedPlan: null,
      badge: {
        label: "1/2",
        ariaLabel: "Tasks, working on step 1 of 2",
        tone: "active",
        pulse: true,
      },
      label: "Tasks",
    };
    const subagentProgress: SubagentProgressState = {
      items: [],
      activeCount: 2,
      completedCount: 0,
      failedCount: 0,
      totalCount: 2,
      summary: "2 subagents running",
      badge: {
        label: "2",
        ariaLabel: "2 subagents running",
        tone: "active",
        pulse: true,
      },
    };

    const state = deriveThreadActivityTriggerState({
      taskProgress,
      subagentProgress,
      backgroundRuns: [
        {
          id: "terminal:default",
          source: "terminal",
          terminalId: "default",
          pid: null,
          port: null,
          elapsed: null,
          canStop: true,
          label: "Terminal 1",
          detail: "C:\\repo",
          cwd: "C:\\repo",
          statusLabel: "Running",
          urls: [],
        },
        {
          id: "provider:task-1",
          source: "provider",
          terminalId: null,
          pid: null,
          port: null,
          elapsed: null,
          canStop: false,
          label: "Keep preview running",
          detail: "Provider-managed",
          cwd: null,
          statusLabel: "Running",
          urls: ["http://localhost:5953"],
        },
      ],
    });

    expect(state?.mode).toBe("mixed");
    expect(state?.badge).toBeNull();
    expect(state?.chips.map((chip) => `${chip.kind}:${chip.label}`)).toEqual([
      "tasks:1/2",
      "subagents:2",
      "background:2",
    ]);
    expect(state?.summary).toContain("Wire the Activity popover");
    expect(state?.summary).toContain("2 subagents running");
    expect(state?.summary).toContain("2 background runs");
  });
});
