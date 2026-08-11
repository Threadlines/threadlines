import "../../index.css";

import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type {
  SubagentProgressItem,
  SubagentProgressState,
  ThreadSubagentHistoryEntry,
} from "../../session-logic";
import { resetAgentsPanelSourceForTests } from "../../agentsPanelStore";
import { AgentsPanel } from "./AgentsPanel";
import { ChatRightPanel } from "../ChatRightPanel";
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

function buildHistoryEntry(entry: {
  item: SubagentProgressItem;
  resultBody?: string | null;
}): ThreadSubagentHistoryEntry {
  return { item: entry.item, resultBody: entry.resultBody ?? null };
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
    // The drill-in selection is shared module state now, so each case starts
    // from the tree rather than whatever the last one drilled into.
    resetAgentsPanelSourceForTests();
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

  it("says so only when the thread has never run an agent", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText(/No agents yet\./u)).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps finished agents listed under Earlier once the live items empty", async () => {
    // The turn has settled, so the live source is empty and only the thread's
    // durable history is left. This is the state the panel used to collapse in.
    const mounted = await renderPanel({
      subagents: [],
      history: [
        buildHistoryEntry({
          item: buildSubagent({
            id: "agent-old",
            agentThreadId: "agent-old",
            transcriptAgentId: "agent-old",
            label: "Router sweep",
            status: "completed",
            statusLabel: "Completed",
            model: "claude-opus-5",
            reasoningEffort: "high",
            updatedAt: "2026-08-11T09:00:00.000Z",
          }),
          resultBody: "- The route never mounted the panel.\nMore detail below.",
        }),
      ],
    });

    try {
      await expect.element(page.getByText("Router sweep")).toBeVisible();
      expect(document.querySelector("[data-agents-panel-empty='true']")).toBeNull();
      expect(document.querySelector("[data-agents-panel-earlier='true']")?.textContent).toBe(
        "Earlier",
      );
      // The report leads, with the markdown that opened it stripped.
      await expect.element(page.getByText("The route never mounted the panel.")).toBeVisible();
      const meta = document.querySelector("[data-agent-branch-meta='true']")?.textContent ?? "";
      expect(meta).toContain("claude-opus-5");
      expect(meta).toContain("high");
    } finally {
      await mounted.unmount();
    }
  });

  it("orders the history newest first and drills into a history-only agent", async () => {
    const mounted = await renderPanel({
      subagents: [],
      history: [
        buildHistoryEntry({
          item: buildSubagent({
            id: "agent-older",
            agentThreadId: "agent-older",
            transcriptAgentId: "agent-older",
            label: "Older sweep",
            status: "completed",
            statusLabel: "Completed",
            updatedAt: "2026-08-11T08:00:00.000Z",
          }),
        }),
        buildHistoryEntry({
          item: buildSubagent({
            id: "agent-newer",
            agentThreadId: "agent-newer",
            transcriptAgentId: "agent-newer",
            label: "Newer sweep",
            status: "completed",
            statusLabel: "Completed",
            updatedAt: "2026-08-11T09:30:00.000Z",
          }),
        }),
      ],
    });

    try {
      await expect.element(page.getByText("Newer sweep")).toBeVisible();
      const order = [...document.querySelectorAll("[data-agent-branch='true']")]
        .map((row) => row.textContent ?? "")
        .join("|");
      expect(order.indexOf("Newer sweep")).toBeLessThan(order.indexOf("Older sweep"));

      // A receipt for a long-finished agent has to resolve against the history,
      // which is the only place that agent still exists.
      await page.getByRole("button", { name: "Open Older sweep transcript" }).click();
      await expect.element(page.getByText("Walked the route files.")).toBeVisible();
      expect(document.querySelector("[data-agents-panel='drill-in']")).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("lets a live agent win over its own history record", async () => {
    const mounted = await renderPanel({
      subagents: [buildSubagent({ label: "Router sweep", telemetry: null })],
      history: [
        buildHistoryEntry({
          item: buildSubagent({ label: "Router sweep", status: "completed" }),
          resultBody: "Done.",
        }),
      ],
    });

    try {
      const rows = [...document.querySelectorAll("[data-agent-branch='true']")];
      expect(rows.length).toBe(1);
      expect(rows[0]?.getAttribute("data-agent-branch-status")).toBe("running");
      expect(document.querySelector("[data-agents-panel-earlier='true']")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("folds a long tool run in the drilled-in transcript into one receipt that opens in place", async () => {
    const toolUse = (name: string) => ({ name, summary: `${name}: src/thing.ts` });
    transcriptRpcMock.mockResolvedValue({
      entries: [
        { role: "assistant", text: "Looking for the handler.", toolUses: [] },
        {
          role: "assistant",
          text: "",
          toolUses: [toolUse("Read"), toolUse("Read"), toolUse("Read"), toolUse("Edit")],
          at: "2026-08-11T10:00:00.000Z",
        },
        {
          role: "assistant",
          text: "",
          toolUses: [toolUse("Bash")],
          at: "2026-08-11T10:01:10.000Z",
        },
        { role: "assistant", text: "Fixed it.", toolUses: [] },
      ],
      truncated: false,
      offset: 0,
      totalEntries: 4,
    });

    const mounted = await renderPanel({
      subagents: [
        buildSubagent({ label: "Router sweep", status: "completed", statusLabel: "Completed" }),
      ],
    });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();

      // The agent's prose always renders; the machinery between it does not.
      await expect.element(page.getByText("Looking for the handler.")).toBeVisible();
      await expect.element(page.getByText("Fixed it.")).toBeVisible();

      const receipt = await vi.waitUntil(() =>
        document.querySelector<HTMLElement>("[data-subagent-transcript-tool-run-toggle='true']"),
      );
      expect(receipt.textContent).toContain("5 actions");
      expect(receipt.textContent).toContain("Read ×3");
      expect(receipt.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-subagent-transcript-entry='tool']")).toBeNull();

      receipt.click();

      await vi.waitFor(() => {
        expect(receipt.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelector("[data-subagent-transcript-entry='tool']")).not.toBeNull();
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("leaves a short tool run inline rather than fronting it with a receipt", async () => {
    transcriptRpcMock.mockResolvedValue({
      entries: [
        { role: "assistant", text: "Checking two things.", toolUses: [] },
        {
          role: "assistant",
          text: "",
          toolUses: [
            { name: "Read", summary: "Read: a.ts" },
            { name: "Grep", summary: "Grep: handler" },
          ],
        },
      ],
      truncated: false,
      offset: 0,
      totalEntries: 2,
    });

    const mounted = await renderPanel({
      subagents: [
        buildSubagent({ label: "Router sweep", status: "completed", statusLabel: "Completed" }),
      ],
    });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();
      await expect.element(page.getByText("Checking two things.")).toBeVisible();

      await vi.waitFor(() => {
        expect(document.querySelector("[data-subagent-transcript-entry='tool']")).not.toBeNull();
      });
      expect(
        document.querySelector("[data-subagent-transcript-tool-run-toggle='true']"),
      ).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("marks a spawned agent with the thread provider's glyph but leaves runs their tag", async () => {
    const mounted = await renderPanel({
      subagents: [buildSubagent({ label: "Router sweep" })],
      backgroundRuns: [TERMINAL_RUN],
      providerLabel: "claudeAgent",
    });

    try {
      await expect.element(page.getByText("Router sweep")).toBeVisible();

      const rows = [...document.querySelectorAll("[data-agent-branch='true']")];
      const subagentRow = rows.find(
        (row) => row.getAttribute("data-agent-branch-kind") === "subagent",
      );
      const runRow = rows.find((row) => row.getAttribute("data-agent-branch-kind") === "run");
      expect(subagentRow?.querySelector("[data-agent-branch-provider='true'] svg")).not.toBeNull();
      expect(runRow?.querySelector("[data-agent-branch-provider='true']")).toBeNull();
      expect(runRow?.querySelector("[data-agent-branch-tag='true']")?.textContent).toBe("terminal");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the sidebar's tab strip above a drilled-in transcript", async () => {
    const onSelectTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["sourceControl", "agents"]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab="agents"
          onSelectTab={onSelectTab}
          onCloseTab={vi.fn()}
        >
          <AgentsPanel
            environmentId={ENVIRONMENT_ID}
            threadId={THREAD_ID}
            subagents={[buildSubagent({ label: "Router sweep" })]}
            backgroundRuns={[]}
            providerLabel="codex"
            embedded
            onToggleBackgroundRunTerminal={vi.fn()}
            onStopBackgroundRun={vi.fn()}
          />
        </ChatRightPanel>
      </main>,
    );

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();
      await expect.element(page.getByText("Walked the route files.")).toBeVisible();
      expect(document.querySelector("[data-agents-panel='drill-in']")).not.toBeNull();

      // The tabs stay reachable from inside the transcript.
      const changesTab = page.getByRole("tab", { name: "Changes" });
      await expect.element(changesTab).toBeVisible();
      await changesTab.click();
      expect(onSelectTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });

  it("shows the launcher when the sidebar has no tabs open, and opens one from a tile", async () => {
    const onSelectTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={[]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={null}
          onSelectTab={onSelectTab}
          onCloseTab={vi.fn()}
        >
          <div data-testid="never-rendered" />
        </ChatRightPanel>
      </main>,
    );

    try {
      await expect
        .element(page.getByText("Working tree changes on this thread's branch."))
        .toBeVisible();
      await expect
        .element(page.getByText("Subagents and background runs on this thread."))
        .toBeVisible();
      // No tab is open, so no surface is mounted behind the launcher.
      expect(document.querySelector("[data-testid='never-rendered']")).toBeNull();

      (document.querySelector("[data-right-panel-launcher-tile='diff']") as HTMLElement).click();
      expect(onSelectTab).toHaveBeenCalledWith("diff");
    } finally {
      await mounted.unmount();
    }
  });

  it("offers every surface in the + menu and marks the ones already open", async () => {
    const onSelectTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["agents"]}
          availableTabs={["sourceControl", "agents"]}
          activeTab="agents"
          onSelectTab={onSelectTab}
          onCloseTab={vi.fn()}
        >
          <div />
        </ChatRightPanel>
      </main>,
    );

    try {
      await page.getByRole("button", { name: "Open panel" }).click();

      const changesItem = await vi.waitFor(() => {
        const item = document.querySelector("[data-right-panel-menu-tab='sourceControl']");
        if (!item) throw new Error("The + menu never listed Changes.");
        return item as HTMLElement;
      });
      // Diff is not a surface this thread has, so it is absent entirely.
      expect(document.querySelector("[data-right-panel-menu-tab='diff']")).toBeNull();
      // An already-open surface stays listed, marked, and focuses its tab.
      expect(
        document
          .querySelector("[data-right-panel-menu-tab='agents']")
          ?.getAttribute("data-right-panel-menu-tab-open"),
      ).toBe("true");
      expect(changesItem.getAttribute("data-right-panel-menu-tab-open")).toBeNull();

      changesItem.click();
      expect(onSelectTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });

  it("closes a tab from its hover ✕", async () => {
    const onCloseTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["sourceControl", "agents"]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab="sourceControl"
          onSelectTab={vi.fn()}
          onCloseTab={onCloseTab}
        >
          <div />
        </ChatRightPanel>
      </main>,
    );

    try {
      await page.getByRole("button", { name: "Close Changes" }).click();
      expect(onCloseTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });
});
