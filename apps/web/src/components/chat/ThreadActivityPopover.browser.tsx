import "../../index.css";

import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { SubagentProgressItem, SubagentProgressState } from "../../session-logic";
import { ThreadActivityPopover, type ThreadTaskProgressState } from "./ThreadActivityPopover";

const TASK_BADGE = {
  label: "1/2",
  ariaLabel: "Tasks, working on step 1 of 2",
  tone: "active",
  pulse: true,
} as const;

const ACTIVE_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const ACTIVE_THREAD_ID = ThreadId.make("thread-activity");

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
        activeThreadEnvironmentId={ACTIVE_ENVIRONMENT_ID}
        activeThreadId={ACTIVE_THREAD_ID}
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
          activeThreadEnvironmentId={ACTIVE_ENVIRONMENT_ID}
          activeThreadId={ACTIVE_THREAD_ID}
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

  it("shows live subagent text only while the agent is running", async () => {
    const baseItem: Omit<SubagentProgressItem, "id" | "status" | "statusLabel" | "liveBody"> = {
      agentThreadId: "agent-1",
      turnId: null,
      label: "Subagent",
      role: "code-reviewer",
      objective: "Audit the SQL changes",
      model: null,
      reasoningEffort: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    };
    const subagentProgress: SubagentProgressState = {
      items: [
        {
          ...baseItem,
          id: "agent-running",
          status: "running",
          statusLabel: "Working",
          liveBody: "Scanning migrations now.",
        },
        {
          ...baseItem,
          id: "agent-done",
          status: "completed",
          statusLabel: "Done",
          // A settled agent must not resurface stale progress text even if a
          // late-merged snapshot still carries it.
          liveBody: "stale live text",
        },
      ],
      activeCount: 1,
      completedCount: 1,
      failedCount: 0,
      totalCount: 2,
      summary: "1 of 2 subagents active",
      badge: {
        label: "1/2",
        ariaLabel: "1 of 2 subagents active",
        tone: "active",
        pulse: true,
      },
    };

    const mounted = await render(
      <main style={{ minHeight: 360, padding: 24, width: 960 }}>
        <ThreadActivityPopover
          activeThreadEnvironmentId={ACTIVE_ENVIRONMENT_ID}
          activeThreadId={ACTIVE_THREAD_ID}
          taskProgress={null}
          subagentProgress={subagentProgress}
          backgroundRuns={[]}
          onToggleBackgroundRunTerminal={vi.fn()}
          onStopBackgroundRun={vi.fn()}
        />
      </main>,
    );

    try {
      await page.getByRole("button", { name: subagentProgress.badge.ariaLabel }).click();
      await expect.element(page.getByText("Scanning migrations now.")).toBeVisible();
      const liveNodes = document.querySelectorAll("[data-subagent-progress-live]");
      expect(liveNodes).toHaveLength(1);
      expect(liveNodes[0]?.textContent).toBe("Scanning migrations now.");
      expect(document.body.textContent).not.toContain("stale live text");
    } finally {
      await mounted.unmount();
    }
  });

  it("shows nested agents as a hierarchy and expands a read-only transcript", async () => {
    const subagentProgress: SubagentProgressState = {
      items: [
        {
          agentThreadId: "agent-parent",
          agentPath: "/root/research",
          parentAgentPath: null,
          treeDepth: 0,
          id: "agent-parent",
          turnId: null,
          label: "Research subagent",
          role: "research",
          objective: "Map the current architecture",
          status: "running",
          statusLabel: "Running",
          model: null,
          reasoningEffort: null,
          liveBody: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
        {
          agentThreadId: "agent-child",
          agentPath: "/root/research/database",
          parentAgentPath: "/root/research",
          treeDepth: 1,
          id: "agent-child",
          turnId: null,
          label: "Database subagent",
          role: "database",
          objective: "Inspect persistence",
          status: "running",
          statusLabel: "Running",
          model: null,
          reasoningEffort: null,
          liveBody: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      activeCount: 2,
      completedCount: 0,
      failedCount: 0,
      totalCount: 2,
      summary: "2 subagents active",
      badge: {
        label: "2",
        ariaLabel: "2 subagents active",
        tone: "active",
        pulse: true,
      },
    };
    const mounted = await render(
      <main style={{ minHeight: 360, padding: 24, width: 960 }}>
        <ThreadActivityPopover
          activeThreadEnvironmentId={ACTIVE_ENVIRONMENT_ID}
          activeThreadId={ACTIVE_THREAD_ID}
          taskProgress={null}
          subagentProgress={subagentProgress}
          backgroundRuns={[]}
          onToggleBackgroundRunTerminal={vi.fn()}
          onStopBackgroundRun={vi.fn()}
        />
      </main>,
    );

    try {
      await page.getByRole("button", { name: subagentProgress.badge.ariaLabel }).click();
      const parent = document.querySelector<HTMLElement>(
        "[data-subagent-agent-path='/root/research']",
      );
      const child = document.querySelector<HTMLElement>(
        "[data-subagent-agent-path='/root/research/database']",
      );
      expect(parent?.dataset.subagentTreeDepth).toBe("0");
      expect(child?.dataset.subagentTreeDepth).toBe("1");
      expect(child?.classList.contains("ml-3")).toBe(true);

      const inspect = page.getByRole("button", { name: "Inspect Database transcript" });
      await inspect.click();
      await expect.element(page.getByText("Read-only transcript")).toBeVisible();
      expect(document.querySelector("[data-subagent-transcript='true']")).not.toBeNull();
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
          activeThreadEnvironmentId={ACTIVE_ENVIRONMENT_ID}
          activeThreadId={ACTIVE_THREAD_ID}
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
