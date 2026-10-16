import "../../index.css";

import type { OrchestrationWorkflowRun, WorkflowAgent } from "@threadlines/contracts";
import { ApprovalRequestId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { WorkflowRunCard, type WorkflowRunActions } from "./WorkflowRunCard";

const STARTED_AT = Date.now() - 90_000;

function agent(overrides: Partial<WorkflowAgent> & Pick<WorkflowAgent, "index">): WorkflowAgent {
  return { label: `review:${overrides.index}`, state: "queued", ...overrides };
}

function buildRun(overrides: Partial<OrchestrationWorkflowRun> = {}): OrchestrationWorkflowRun {
  return {
    taskId: "task-wf",
    runId: "wf_1",
    turnId: null,
    toolCallId: null,
    owner: { participantId: null },
    name: "review-changes",
    description: "Review every changed file, then verify each finding",
    status: "running",
    statusReason: null,
    hiddenScript: false,
    startedAt: new Date(STARTED_AT).toISOString(),
    endedAt: null,
    totalTokens: 48_000,
    totalToolCalls: 0,
    transcriptDir: null,
    scriptPath: null,
    summary: null,
    phases: [
      { index: 0, title: "Review" },
      { index: 1, title: "Verify" },
      { index: 2, title: "Report" },
    ],
    agents: [
      agent({ index: 0, phaseIndex: 0, state: "done", startedAt: STARTED_AT, durationMs: 30_000 }),
      agent({
        index: 1,
        phaseIndex: 1,
        state: "running",
        agentId: "agent-verify",
        startedAt: STARTED_AT + 40_000,
        lastStep: "Reading apps/server/src/ws.ts",
      }),
      agent({ index: 2, phaseIndex: 1, state: "queued" }),
    ],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildActions() {
  return {
    open: vi.fn<WorkflowRunActions["open"]>(),
    stop: vi.fn<WorkflowRunActions["stop"]>(),
    save: vi.fn<WorkflowRunActions["save"]>(),
    ultracode: false,
    sizeGuideline: null,
  } satisfies WorkflowRunActions;
}

async function renderCard(run: OrchestrationWorkflowRun, actions: WorkflowRunActions) {
  return render(
    <main style={{ width: 720, padding: 16 }}>
      <WorkflowRunCard run={run} actions={actions} />
    </main>,
  );
}

describe("WorkflowRunCard", () => {
  it("opens the live phase by itself, and stops or opens an agent from the card", async () => {
    const actions = buildActions();
    const mounted = await renderCard(buildRun(), actions);
    try {
      const card = page.getByRole("region", { name: "Workflow: Review changes" });
      await expect.element(card).toBeVisible();
      await expect.element(page.getByText("Reading apps/server/src/ws.ts")).toBeVisible();
      // The finished and the waiting phases stay closed.
      expect(document.querySelectorAll("[data-workflow-agent-row]")).toHaveLength(2);
      expect(
        document.querySelector('[data-workflow-phase="2"] button')?.hasAttribute("disabled"),
      ).toBe(true);

      await page.getByRole("button", { name: /review:1/ }).click();
      expect(actions.open).toHaveBeenCalledWith("task-wf", {
        tab: "agents",
        agentId: "agent-verify",
      });

      await page.getByRole("button", { name: "Stop" }).click();
      expect(actions.stop).toHaveBeenCalledWith("task-wf");
    } finally {
      await mounted.unmount();
    }
  });

  it("shows a big phase as dots, with a line only for agents still going or gone wrong", async () => {
    const agents = Array.from({ length: 20 }, (_, index) =>
      agent({
        index,
        phaseIndex: 0,
        state: index === 3 ? "failed" : index === 4 ? "running" : index < 10 ? "done" : "queued",
        ...(index === 3 ? { error: "Timed out" } : {}),
      }),
    );
    const mounted = await renderCard(
      buildRun({ phases: [{ index: 0, title: "Review" }], agents }),
      buildActions(),
    );
    try {
      await expect.element(page.getByRole("img", { name: "8 of 20 agents done" })).toBeVisible();
      expect(
        [...document.querySelectorAll("[data-workflow-agent-row]")].map((row) =>
          row.getAttribute("data-workflow-agent-row"),
        ),
      ).toEqual(["3", "4"]);
      await expect.element(page.getByText("Timed out")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("folds a finished run to a receipt that offers to save it", async () => {
    const actions = buildActions();
    const finished = buildRun({
      status: "completed",
      endedAt: new Date(STARTED_AT + 41 * 60_000).toISOString(),
      agents: buildRun().agents.map((entry) => ({ ...entry, state: "done" as const })),
    });
    const mounted = await renderCard(finished, actions);
    try {
      await expect.element(page.getByText("finished")).toBeVisible();
      await expect.element(page.getByText(/41m · 3 agents/)).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Stop" })).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Save as command…" }).click();
      expect(actions.save).toHaveBeenCalledWith("task-wf");
    } finally {
      await mounted.unmount();
    }

    const hidden = await renderCard({ ...finished, hiddenScript: true }, buildActions());
    try {
      await expect.element(page.getByRole("button", { name: "Open" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "View script" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Save as command…" }))
        .not.toBeInTheDocument();
    } finally {
      await hidden.unmount();
    }
  });
});

describe("ComposerPendingApprovalPanel for a workflow", () => {
  it("shows what the workflow will run, with its script one click away", async () => {
    const mounted = await render(
      <ComposerPendingApprovalPanel
        pendingCount={1}
        approval={{
          requestId: ApprovalRequestId.make("req-wf"),
          requestKind: "command",
          createdAt: "2026-10-15T10:00:00.000Z",
          toolName: "Workflow",
          workflow: {
            name: "review-changes",
            description: "Review every changed file",
            phases: [{ title: "Review", detail: "One agent per file" }, { title: "Verify" }],
            script: "export const meta = { name: 'review-changes' }",
          },
        }}
      />,
    );
    try {
      await expect.element(page.getByText("Run workflow “Review changes”?")).toBeVisible();
      await expect.element(page.getByText("One agent per file", { exact: false })).toBeVisible();
      await expect
        .element(page.getByText("export const meta", { exact: false }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "View script" }).click();
      await expect.element(page.getByText("export const meta", { exact: false })).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });
});
