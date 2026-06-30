import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SubagentProgressState } from "../../session-logic";
import { ThreadActivityPopover, type ThreadTaskProgressState } from "./ThreadActivityPopover";

const TASK_BADGE = {
  label: "1/2",
  ariaLabel: "Tasks, working on step 1 of 2",
  tone: "active",
  pulse: true,
} as const;

function buildTaskProgress(activeStep: string): ThreadTaskProgressState {
  return {
    activePlan: {
      createdAt: "2026-06-25T12:00:00.000Z",
      turnId: null,
      steps: [
        { step: activeStep, status: "inProgress" },
        { step: "Run validation", status: "pending" },
      ],
    },
    activeProposedPlan: null,
    badge: TASK_BADGE,
    label: "Tasks",
  };
}

async function renderOpenPopover(activeStep: string) {
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
        taskProgress={buildTaskProgress(activeStep)}
        subagentProgress={null}
        backgroundRuns={[]}
        onToggleBackgroundRunTerminal={vi.fn()}
        onStopBackgroundRun={vi.fn()}
      />
    </main>,
  );

  await page.getByRole("button", { name: TASK_BADGE.ariaLabel }).click();
  await expect.element(page.getByText("Current tasks")).toBeVisible();

  return mounted;
}

describe("ThreadActivityPopover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not render task summary disclosure when the summary fits", async () => {
    const fittingSummary = "Review iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii";
    const mounted = await renderOpenPopover(fittingSummary);

    try {
      await vi.waitFor(() => {
        const summaryText = document.querySelector<HTMLElement>("[data-task-summary-text='true']");
        expect(summaryText?.textContent).toBe(fittingSummary);
        expect(summaryText?.scrollWidth ?? 0).toBeLessThanOrEqual(
          (summaryText?.clientWidth ?? 0) + 1,
        );
        expect(summaryText?.closest("[data-task-summary-toggle='true']")).toBeNull();
      });

      expect(document.querySelector("[data-task-summary-toggle='true']")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("renders task summary disclosure when the summary is clipped", async () => {
    const clippedSummary =
      "Add symlink-specific status and reason through server contracts, UI state, persistence, reconnection flows, and focused regression coverage.";
    const mounted = await renderOpenPopover(clippedSummary);

    try {
      await vi.waitFor(() => {
        const summaryText = document.querySelector<HTMLElement>("[data-task-summary-text='true']");
        const toggle = document.querySelector<HTMLButtonElement>(
          "[data-task-summary-toggle='true']",
        );

        expect(summaryText?.textContent).toBe(clippedSummary);
        expect(summaryText?.scrollWidth ?? 0).toBeGreaterThan((summaryText?.clientWidth ?? 0) + 1);
        expect(toggle).not.toBeNull();
        expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      });

      document.querySelector<HTMLButtonElement>("[data-task-summary-toggle='true']")?.click();

      await vi.waitFor(() => {
        expect(
          document
            .querySelector<HTMLButtonElement>("[data-task-summary-toggle='true']")
            ?.getAttribute("aria-expanded"),
        ).toBe("true");
      });
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
          subagentProgress={null}
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

  it("omits the tasks icon when mixed activity has no tasks", async () => {
    const subagentProgress: SubagentProgressState = {
      items: [],
      activeCount: 1,
      completedCount: 0,
      failedCount: 0,
      totalCount: 1,
      summary: "1 subagent active",
      badge: {
        label: "1",
        ariaLabel: "1 subagent active",
        tone: "active",
        pulse: true,
      },
    };
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
          subagentProgress={subagentProgress}
          backgroundRuns={[
            {
              id: "provider:command-1",
              source: "provider",
              providerKind: "command",
              terminalId: null,
              pid: null,
              port: null,
              elapsed: null,
              canStop: false,
              label: "Get-Content command",
              detail: "Agent command",
              cwd: null,
              statusLabel: "Running",
              urls: [],
            },
          ]}
          onToggleBackgroundRunTerminal={vi.fn()}
          onStopBackgroundRun={vi.fn()}
        />
      </main>,
    );

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Thread activity']",
      );

      expect(trigger).not.toBeNull();
      expect(trigger?.querySelector("[data-activity-trigger-icon='tasks']")).toBeNull();
      expect(trigger?.querySelector("[data-activity-trigger-icon='subagents']")).not.toBeNull();
      expect(trigger?.querySelector("[data-activity-trigger-icon='background']")).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
