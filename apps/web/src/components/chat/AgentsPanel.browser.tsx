import "../../index.css";

import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { SubagentProgressItem, SubagentProgressState } from "../../session-logic";
import { AgentsPanel } from "./AgentsPanel";
import { ThreadActivityChip } from "./ThreadActivityPopover";
import type { ThreadBackgroundRunItem } from "./threadActivity";

const transcriptRpcMock = vi.hoisted(() => vi.fn());

vi.mock("./subagentTranscriptClient", () => ({
  readSubagentTranscriptPage: transcriptRpcMock,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-agents");

function buildSubagent(overrides: Partial<SubagentProgressItem> = {}): SubagentProgressItem {
  return {
    id: "agent-1",
    agentThreadId: "agent-1",
    transcriptAgentId: "agent-1",
    turnId: null,
    label: "Explore subagent",
    nickname: null,
    role: null,
    objective: "Sweep the router for panel wiring",
    status: "running",
    statusLabel: "Running",
    model: null,
    reasoningEffort: null,
    liveBody: null,
    telemetry: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:30.000Z",
    ...overrides,
  };
}

const TERMINAL_RUN: ThreadBackgroundRunItem = {
  id: "terminal:default",
  source: "terminal",
  terminalId: "default",
  terminalVisible: false,
  label: "Terminal 1",
  command: "vp run dev",
  detail: "Terminal 1 - C:\\repo",
  cwd: "C:\\repo",
  statusLabel: "Running",
  urls: [],
  pid: null,
  port: null,
  elapsed: "2m",
  canStop: true,
};

function renderPanel(
  props: Partial<Parameters<typeof AgentsPanel>[0]> = {},
  onToggleBackgroundRunTerminal = vi.fn(),
) {
  return render(
    <main style={{ boxSizing: "border-box", height: 640, width: 400 }}>
      <AgentsPanel
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        subagents={[]}
        backgroundRuns={[]}
        providerLabel="codex"
        onToggleBackgroundRunTerminal={onToggleBackgroundRunTerminal}
        onStopBackgroundRun={vi.fn()}
        {...props}
      />
    </main>,
  );
}

describe("AgentsPanel", () => {
  beforeEach(() => {
    transcriptRpcMock.mockReset();
    transcriptRpcMock.mockResolvedValue({
      entries: [{ role: "assistant", text: "Walked the route files.", toolUses: [] }],
      truncated: false,
      offset: 0,
      totalEntries: 1,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens from the header activity chip", async () => {
    const onToggleAgentsPanel = vi.fn();
    const subagentProgress: SubagentProgressState = {
      items: [],
      activeCount: 2,
      completedCount: 0,
      failedCount: 0,
      totalCount: 2,
      summary: "2 subagents running",
      badge: { label: "2", ariaLabel: "2 subagents running", tone: "active", pulse: true },
    };
    const mounted = await render(
      <main className="flex items-center gap-2">
        <ThreadActivityChip
          taskProgress={null}
          subagentProgress={subagentProgress}
          backgroundRuns={[]}
          pressed={false}
          onClick={onToggleAgentsPanel}
        />
      </main>,
    );

    try {
      const chip = page.getByRole("button", { name: "2 subagents running" });
      await expect.element(chip).toHaveAttribute("aria-pressed", "false");
      await chip.click();
      expect(onToggleAgentsPanel).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("draws a branch for every state the turn is in", async () => {
    const mounted = await renderPanel({
      subagents: [
        buildSubagent({ id: "running", label: "Router sweep", status: "running" }),
        buildSubagent({
          id: "waiting",
          label: "Migration writer",
          status: "waiting",
          statusLabel: "Needs approval",
        }),
        buildSubagent({
          id: "failed",
          label: "Type checker",
          status: "failed",
          statusLabel: "Failed",
        }),
        buildSubagent({
          id: "done",
          label: "Doc reader",
          status: "completed",
          statusLabel: "Done",
        }),
      ],
      backgroundRuns: [TERMINAL_RUN],
    });

    try {
      await expect.element(page.getByText("Router sweep")).toBeVisible();

      const branches = [...document.querySelectorAll("[data-agent-branch='true']")];
      expect(branches.map((branch) => branch.getAttribute("data-agent-branch-status"))).toEqual([
        "running",
        "running",
        "waiting",
        "failed",
        "completed",
      ]);
      expect(branches.map((branch) => branch.getAttribute("data-agent-branch-kind"))).toContain(
        "run",
      );

      // A run is transcript-less, so it says where it came from instead.
      const tags = [...document.querySelectorAll("[data-agent-branch-tag='true']")];
      expect(tags.map((tag) => tag.textContent)).toEqual(["terminal"]);
    } finally {
      await mounted.unmount();
    }
  });

  it("tags a detected run with the provider that reported it", async () => {
    const mounted = await renderPanel({
      backgroundRuns: [
        {
          ...TERMINAL_RUN,
          id: "detected:1",
          source: "detected",
          terminalId: null,
          label: "Dev server",
          port: 5173,
        },
      ],
    });

    try {
      await expect.element(page.getByText("codex · detected")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("toggles the terminal when a run branch is pressed instead of drilling in", async () => {
    const onToggleBackgroundRunTerminal = vi.fn();
    const mounted = await renderPanel(
      { backgroundRuns: [TERMINAL_RUN] },
      onToggleBackgroundRunTerminal,
    );

    try {
      await page.getByRole("button", { name: "Open Terminal 1 terminal" }).click();
      expect(onToggleBackgroundRunTerminal).toHaveBeenCalledWith("default");
      // Still the tree: a run never replaces the panel with a transcript.
      expect(document.querySelector("[data-agents-panel='tree']")).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("drills into a subagent's transcript and comes back to the tree", async () => {
    const mounted = await renderPanel({
      subagents: [buildSubagent({ label: "Router sweep" })],
    });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();

      await expect.element(page.getByText("Walked the route files.")).toBeVisible();
      expect(document.querySelector("[data-agents-panel='drill-in']")).not.toBeNull();

      await page.getByRole("button", { name: "Back to agents" }).click();

      await expect.element(page.getByText("Sweep the router for panel wiring")).toBeVisible();
      expect(document.querySelector("[data-agents-panel='tree']")).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("says so when the turn has nothing running", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText("No agents on this turn.")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });
});
