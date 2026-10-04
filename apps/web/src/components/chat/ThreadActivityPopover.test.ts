import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadActivityTriggerState,
  foldedDoneStepCount,
  type ThreadTaskProgressState,
} from "./ThreadActivityPopover";
import {
  backgroundRunDetailLine,
  backgroundRunSourceLabel,
  deriveSubagentDisplayDetails,
  processStartedAt,
  type ThreadBackgroundRunItem,
} from "./threadActivity";

describe("deriveSubagentDisplayDetails", () => {
  it("promotes the goal and removes the workspace path from what is shown", () => {
    const details = deriveSubagentDisplayDetails({
      objective:
        "Read-only exploration in C:\\Users\\Will\\Desktop\\Projects\\badcode. Goal: inspect the toast emitters and warning taxonomy before changing behavior",
    });

    expect(details.goal).toBe(
      "inspect the toast emitters and warning taxonomy before changing behavior",
    );
    expect(details.context).toBe("Read-only exploration");
    expect(`${details.goal} ${details.context}`).not.toContain("C:\\Users\\Will");
  });

  it("removes a workspace path from task-in-location objectives without a Goal marker", () => {
    const details = deriveSubagentDisplayDetails({
      objective:
        "Read-only task in C:\\Users\\Will\\Desktop\\Projects\\badcode. Inspect the current working tree changes related to subagent styling",
    });

    expect(details.goal).toBe(
      "Inspect the current working tree changes related to subagent styling",
    );
    expect(details.context).toBe("Read-only task");
  });

  it("keeps ordinary objective text when no Goal marker is present", () => {
    const details = deriveSubagentDisplayDetails({
      objective: "Review the terminal drawer hydration path",
    });

    expect(details.goal).toBe("Review the terminal drawer hydration path");
    expect(details.context).toBeNull();
  });
});

function taskProgressFor(
  statuses: ReadonlyArray<"pending" | "inProgress" | "completed">,
): ThreadTaskProgressState {
  return {
    activePlan: {
      createdAt: "2026-06-23T00:00:00.000Z",
      startedAt: "2026-06-23T00:00:00.000Z",
      turnId: null,
      steps: statuses.map((status, index) => ({
        step: index === 0 ? "Wire the Activity popover" : `Step ${index + 1}`,
        status,
        startedAt: null,
        completedAt: null,
      })),
    },
    activeProposedPlan: null,
    badge: {
      label: "0/2",
      ariaLabel: "Tasks, 0 of 2 done, working on step 1",
      tone: "active",
      pulse: true,
    },
    label: "Tasks",
    live: true,
    currentWork: null,
  };
}

const terminalRun: ThreadBackgroundRunItem = {
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
};

describe("deriveThreadActivityTriggerState", () => {
  it("hides when there is no thread activity", () => {
    expect(
      deriveThreadActivityTriggerState({
        taskProgress: null,
        backgroundRuns: [],
      }),
    ).toBeNull();
  });

  it("draws the plan's steps as progress and names the button for the plan", () => {
    const state = deriveThreadActivityTriggerState({
      taskProgress: taskProgressFor(["inProgress", "pending"]),
      backgroundRuns: [],
    });

    expect(state?.tasks?.steps?.map((step) => step.status)).toEqual(["inProgress", "pending"]);
    expect(state?.tasks?.label).toBe("0/2");
    expect(state?.runCount).toBe(0);
    expect(state?.ariaLabel).toBe("Tasks, 0 of 2 done, working on step 1");
  });

  it("counts background runs alone when there is no plan", () => {
    const state = deriveThreadActivityTriggerState({
      taskProgress: null,
      backgroundRuns: [terminalRun],
    });

    expect(state?.tasks).toBeNull();
    expect(state?.runCount).toBe(1);
    expect(state?.ariaLabel).toBe("1 background run");
  });

  it("shows both halves when a plan and runs are active", () => {
    const state = deriveThreadActivityTriggerState({
      taskProgress: taskProgressFor(["inProgress", "pending"]),
      backgroundRuns: [
        terminalRun,
        {
          ...terminalRun,
          id: "provider:task-1",
          source: "provider",
          terminalId: null,
          canStop: false,
          label: "Keep preview running",
          urls: ["http://localhost:5953"],
        },
      ],
    });

    expect(state?.tasks?.label).toBe("0/2");
    expect(state?.runCount).toBe(2);
    expect(state?.ariaLabel).toBe("Thread activity");
    // The task in hand reads as happening now.
    expect(state?.summary).toContain("Wiring the Activity popover");
    expect(state?.summary).toContain("2 background runs");
  });
});

describe("foldedDoneStepCount", () => {
  const statuses = (done: number, open: number) => [
    ...Array.from({ length: done }, () => ({ status: "completed" as const })),
    ...Array.from({ length: open }, () => ({ status: "pending" as const })),
  ];

  it("keeps short plans open and folds the finished head of long ones", () => {
    expect(foldedDoneStepCount(statuses(3, 3))).toBe(0);
    expect(foldedDoneStepCount(statuses(7, 5))).toBe(7);
  });

  it("folds a finished plan whole once it is more than a few steps", () => {
    expect(foldedDoneStepCount(statuses(3, 0))).toBe(0);
    expect(foldedDoneStepCount(statuses(6, 0))).toBe(6);
  });
});

describe("backgroundRunSourceLabel", () => {
  const baseRun: ThreadBackgroundRunItem = {
    id: "terminal:default",
    source: "terminal",
    terminalId: "default",
    pid: null,
    port: null,
    elapsed: null,
    canStop: true,
    label: "vp run dev:desktop",
    detail: "Terminal 1",
    cwd: "C:\\repo",
    statusLabel: "Running",
    urls: [],
  };

  it("distinguishes active terminals from agent-owned background runs", () => {
    expect(backgroundRunSourceLabel({ ...baseRun, terminalVisible: true })).toBe("Active terminal");
    expect(backgroundRunSourceLabel({ ...baseRun, terminalVisible: false })).toBe("Terminal");
    expect(
      backgroundRunSourceLabel({
        ...baseRun,
        id: "detected-localhost:5953:4242",
        source: "detected",
        terminalId: null,
        port: 5953,
      }),
    ).toBe("Detected agent preview");
    expect(
      backgroundRunSourceLabel({
        ...baseRun,
        id: "detected-process:4242",
        source: "detected",
        terminalId: null,
        port: null,
      }),
    ).toBe("Detected agent process");
    expect(
      backgroundRunSourceLabel({
        ...baseRun,
        id: "provider:task-1",
        source: "provider",
        providerKind: "task",
        terminalId: null,
      }),
    ).toBe("Agent task");
    expect(
      backgroundRunSourceLabel({
        ...baseRun,
        id: "provider:command-1",
        source: "provider",
        providerKind: "command",
        terminalId: null,
      }),
    ).toBe("Agent command");
  });
});

describe("background run rows", () => {
  const commandRun: ThreadBackgroundRunItem = {
    id: "provider:task-dev",
    source: "provider",
    providerKind: "task",
    terminalId: null,
    pid: null,
    port: null,
    elapsed: null,
    canStop: true,
    label: "Start web dev server",
    command: "vp run dev",
    detail: "Local Bash task",
    cwd: null,
    statusLabel: "Running",
    urls: [],
  };

  it("shows what the run printed, else its command, else a plain sentence", () => {
    expect(backgroundRunDetailLine({ ...commandRun, outputLine: "ready in 412 ms" })).toEqual({
      kind: "output",
      text: "ready in 412 ms",
    });
    expect(backgroundRunDetailLine(commandRun)).toEqual({ kind: "command", text: "vp run dev" });
    expect(
      backgroundRunDetailLine({
        ...commandRun,
        label: "Background task",
        command: null,
        detail: "The agent started this but didn't say what it is.",
        described: false,
      }),
    ).toEqual({ kind: "prose", text: "The agent started this but didn't say what it is." });
  });

  it("dates a process from the elapsed time the machine reported", () => {
    const reportedAtMs = Date.parse("2026-06-23T12:00:00.000Z");
    expect(processStartedAt("01:02:03", reportedAtMs)).toBe("2026-06-23T10:57:57.000Z");
    expect(processStartedAt("1-00:00:30", reportedAtMs)).toBe("2026-06-22T11:59:30.000Z");
    expect(processStartedAt("n/a", reportedAtMs)).toBeNull();
  });
});
