import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
        onOpenBackgroundRunTerminal={vi.fn()}
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
});
