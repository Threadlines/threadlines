import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { ActivePlanStep } from "../../session-logic";
import { Button } from "../ui/button";
import { ThreadActivityPopover, type ThreadTaskProgressState } from "./ThreadActivityPopover";

const TASK_BADGE = {
  label: "1/3",
  ariaLabel: "Tasks, 1 of 3 done, working on step 2",
  tone: "active",
  pulse: true,
} as const;

function step(
  text: string,
  status: ActivePlanStep["status"],
  startedAt: string | null = null,
  completedAt: string | null = null,
): ActivePlanStep {
  return { step: text, status, startedAt, completedAt };
}

function buildTaskProgress(
  steps: ReadonlyArray<ActivePlanStep>,
  overrides: Partial<ThreadTaskProgressState> = {},
): ThreadTaskProgressState {
  return {
    activePlan: {
      createdAt: "2026-06-25T12:00:00.000Z",
      startedAt: "2026-06-25T12:00:00.000Z",
      turnId: null,
      steps: [...steps],
    },
    activeProposedPlan: null,
    badge: TASK_BADGE,
    label: "Tasks",
    live: false,
    currentWork: null,
    ...overrides,
  };
}

const THREE_STEPS = [
  step("Read the code", "completed", "2026-06-25T12:00:00.000Z", "2026-06-25T12:04:00.000Z"),
  step("Build the popover", "inProgress", "2026-06-25T12:04:00.000Z"),
  step("Run validation", "pending"),
];

async function renderOpenPopover(taskProgress: ThreadTaskProgressState) {
  const mounted = await render(
    <main
      style={{
        boxSizing: "border-box",
        display: "flex",
        justifyContent: "flex-end",
        minHeight: 480,
        padding: 24,
        width: 960,
      }}
    >
      <ThreadActivityPopover
        taskProgress={taskProgress}
        backgroundRuns={[]}
        threadRef={null}
        onToggleBackgroundRunTerminal={vi.fn()}
        onStopBackgroundRun={vi.fn()}
      />
    </main>,
  );

  await page.getByRole("button", { name: TASK_BADGE.ariaLabel }).click();
  await expect.element(page.getByRole("region", { name: "Tasks" })).toBeVisible();

  return mounted;
}

describe("ThreadActivityPopover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("matches adjacent compact button height at phone widths", async () => {
    await page.viewport(500, 800);
    const mounted = await render(
      <main className="flex items-center gap-2">
        <ThreadActivityPopover
          taskProgress={buildTaskProgress(THREE_STEPS)}
          backgroundRuns={[]}
          threadRef={null}
          onToggleBackgroundRunTerminal={vi.fn()}
          onStopBackgroundRun={vi.fn()}
        />
        <Button size="xs" variant="outline" aria-label="Adjacent header action">
          +
        </Button>
      </main>,
    );

    try {
      const activityTrigger = page.getByRole("button", { name: TASK_BADGE.ariaLabel }).element();
      const adjacentButton = page.getByRole("button", { name: "Adjacent header action" }).element();

      expect(activityTrigger.getBoundingClientRect().height).toBe(28);
      expect(activityTrigger.getBoundingClientRect().height).toBe(
        adjacentButton.getBoundingClientRect().height,
      );
      // One progress block per step on the button itself.
      expect(
        activityTrigger.querySelectorAll("[data-plan-progress='trigger'] > span"),
      ).toHaveLength(3);
    } finally {
      await mounted.unmount();
      await page.viewport(1_600, 1_300);
    }
  });

  it("shows where each step stands, how long the finished ones took, and what the agent is on", async () => {
    const mounted = await renderOpenPopover(
      buildTaskProgress(THREE_STEPS, {
        live: true,
        currentWork: {
          label: "Reading CommandPalette.tsx",
          icon: "read",
          tone: "neutral",
          running: true,
        },
      }),
    );

    try {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-plan-step-status]")];
      expect(rows.map((row) => row.dataset.planStepStatus)).toEqual([
        "completed",
        "inProgress",
        "pending",
      ]);
      expect(rows[0]?.textContent).toContain("4m");
      // The task in hand reads as happening now, with the step the agent is on.
      expect(rows[1]?.textContent).toContain("Building the popover");
      await expect.element(page.getByText("Reading CommandPalette.tsx")).toBeVisible();
      await expect.element(page.getByText("1 of 3 done")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("folds the finished head of a long plan into one line that opens", async () => {
    const doneSteps = Array.from({ length: 6 }, (_, index) =>
      step(`Finished step ${index + 1}`, "completed"),
    );
    const mounted = await renderOpenPopover(
      buildTaskProgress([
        ...doneSteps,
        step("Current step", "inProgress"),
        step("Last", "pending"),
      ]),
    );

    try {
      const fold = page.getByRole("button", { name: /6 steps done/u });
      await expect.element(fold).toHaveAttribute("aria-expanded", "false");
      expect(document.body.textContent).not.toContain("Finished step 1");

      await fold.click();

      await expect.element(fold).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText("Finished step 1")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("opens task and background-run details from the mixed activity button", async () => {
    const mounted = await render(
      <main style={{ minHeight: 480, padding: 24, width: 960 }}>
        <ThreadActivityPopover
          taskProgress={buildTaskProgress(THREE_STEPS)}
          backgroundRuns={[
            {
              id: "provider:task-1",
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
              urls: ["http://localhost:5173/"],
              outputLine: "ready in 412 ms",
            },
          ]}
          threadRef={null}
          onToggleBackgroundRunTerminal={vi.fn()}
          onStopBackgroundRun={vi.fn()}
        />
      </main>,
    );

    try {
      await page.getByRole("button", { name: "Thread activity" }).click();
      await expect.element(page.getByRole("region", { name: "Tasks" })).toBeVisible();
      await expect
        .element(page.getByRole("region", { name: "Running in the background" }))
        .toBeVisible();
      await expect.element(page.getByText("ready in 412 ms")).toBeVisible();
      await expect.element(page.getByRole("link", { name: /localhost:5173/u })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Stop Start web dev server" }))
        .toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("labels the terminal run button as close when the terminal is already visible", async () => {
    const onToggleBackgroundRunTerminal = vi.fn();
    const mounted = await render(
      <main
        style={{
          boxSizing: "border-box",
          display: "flex",
          justifyContent: "flex-end",
          minHeight: 360,
          padding: 24,
          width: 960,
        }}
      >
        <ThreadActivityPopover
          taskProgress={null}
          backgroundRuns={[
            {
              id: "terminal:default",
              source: "terminal",
              terminalId: "default",
              terminalVisible: true,
              pid: null,
              port: null,
              elapsed: null,
              canStop: true,
              label: 'node -e "let n=0"',
              command: 'node -e "let n=0"',
              detail: "Terminal 1 - C:\\repo",
              cwd: "C:\\repo",
              statusLabel: "Running",
              urls: [],
            },
          ]}
          threadRef={null}
          onToggleBackgroundRunTerminal={onToggleBackgroundRunTerminal}
          onStopBackgroundRun={vi.fn()}
        />
      </main>,
    );

    try {
      await page.getByRole("button", { name: "1 background run" }).click();
      await page.getByRole("button", { name: 'Close node -e "let n=0"' }).click();
      expect(onToggleBackgroundRunTerminal).toHaveBeenCalledWith("default");
    } finally {
      await mounted.unmount();
    }
  });
});
