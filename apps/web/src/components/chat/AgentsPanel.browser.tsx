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

      expect(document.querySelector("[data-agents-panel='tree']")).not.toBeNull();
      // The objective is no longer a line of its own; the row still carries it.
      expect(
        document
          .querySelector("[data-agent-branch='true'] > button, [data-agent-branch='true'] > div")
          ?.getAttribute("title"),
      ).toBe("Sweep the router for panel wiring");
    } finally {
      await mounted.unmount();
    }
  });

  /** The instruction block above the drilled-in thread, if there is one. */
  function drilledInInstructionText(): string | null {
    return (
      document.querySelector("[data-subagent-transcript-instruction='true']")?.textContent ?? null
    );
  }

  function headerObjectiveText(): string | null {
    return document.querySelector("[data-subagent-inspector-goal='true']")?.textContent ?? null;
  }

  it("stands the objective in as the instruction rather than saying it twice", async () => {
    // The default transcript opens on the agent's own work, with no leading
    // message: the shape a forked Codex child arrives in.
    const mounted = await renderPanel({ subagents: [buildSubagent({ label: "Router sweep" })] });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();
      await expect.element(page.getByText("Walked the route files.")).toBeVisible();

      expect(drilledInInstructionText()).toContain("Sweep the router for panel wiring");
      expect(headerObjectiveText()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("drops the header objective when a leading message already carries it", async () => {
    // A Claude child: its first stored record is the spawn prompt the row's
    // objective was derived from, so the header would only repeat it.
    transcriptRpcMock.mockResolvedValue({
      entries: [
        {
          role: "user",
          text: "Sweep the router for panel wiring. Report back with a list.",
          toolUses: [],
        },
        { role: "assistant", text: "Walked the route files.", toolUses: [] },
      ],
      truncated: false,
      offset: 0,
      totalEntries: 2,
    });
    const mounted = await renderPanel({ subagents: [buildSubagent({ label: "Router sweep" })] });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();
      await expect.element(page.getByText(/Report back with a list/)).toBeVisible();

      expect(drilledInInstructionText()).toContain("Report back with a list");
      expect(headerObjectiveText()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the header objective when the instruction says something else", async () => {
    transcriptRpcMock.mockResolvedValue({
      entries: [
        { role: "user", text: "Continue where the last agent stopped.", toolUses: [] },
        { role: "assistant", text: "Walked the route files.", toolUses: [] },
      ],
      truncated: false,
      offset: 0,
      totalEntries: 2,
    });
    const mounted = await renderPanel({ subagents: [buildSubagent({ label: "Router sweep" })] });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();
      await expect.element(page.getByText("Continue where the last agent stopped.")).toBeVisible();

      expect(headerObjectiveText()).toContain("Sweep the router for panel wiring");
    } finally {
      await mounted.unmount();
    }
  });

  it("says so only when the thread has never run an agent", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText(/No agents yet\./u)).toBeVisible();
      expect(
        document
          .querySelector("[data-agents-panel-empty='true']")
          ?.getAttribute("data-agents-panel-empty-state"),
      ).toBe("never-ran");
    } finally {
      await mounted.unmount();
    }
  });

  it("waits on an in-flight turn instead of claiming the thread never ran an agent", async () => {
    // The turn is dispatched but the provider has not been handed off yet, so
    // there is nothing to list and agents may still be spawned.
    const mounted = await renderPanel({ turnInFlight: true });

    try {
      await expect.element(page.getByText(/Waiting on the turn\./u)).toBeVisible();
      expect(document.body.textContent).not.toContain("No agents yet");
      expect(
        document
          .querySelector("[data-agents-panel-empty='true']")
          ?.getAttribute("data-agents-panel-empty-state"),
      ).toBe("waiting");
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

  it("branches the live turn off a trunk and files the history flat, on one gutter", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <AgentsPanel
          environmentId={ENVIRONMENT_ID}
          threadId={THREAD_ID}
          subagents={[
            buildSubagent({
              label: "Router sweep",
              liveBody: "Reading the strip's measurements.",
              telemetry: {
                step: null,
                lastToolName: null,
                durationMs: 92_000,
                totalTokens: 48_120,
                toolUses: 12,
              },
            }),
          ]}
          backgroundRuns={[]}
          history={[
            buildHistoryEntry({
              item: buildSubagent({
                id: "agent-old",
                agentThreadId: "agent-old",
                transcriptAgentId: "agent-old",
                label: "Panel audit",
                status: "completed",
                statusLabel: "Completed",
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                updatedAt: "2026-08-11T09:00:00.000Z",
              }),
              resultBody: "The strip never sized its tabs.",
            }),
          ]}
          providerLabel="codex"
          embedded
          onToggleBackgroundRunTerminal={vi.fn()}
          onStopBackgroundRun={vi.fn()}
        />
      </main>,
    );

    try {
      await expect.element(page.getByText("Panel audit")).toBeVisible();

      const panel = document.querySelector("[data-agents-panel='tree']")!.getBoundingClientRect();
      const rows = [...document.querySelectorAll("[data-agent-branch='true']")] as HTMLElement[];
      // Both the live turn and the Earlier history render through this row, in
      // its two shapes: the live turn branches, the record is filed flat.
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.getAttribute("data-agent-branch-variant"))).toEqual([
        "branch",
        "flat",
      ]);

      for (const row of rows) {
        const name = row.querySelector("[data-agent-branch-meta='true']")
          ?.previousElementSibling as HTMLElement;
        const meta = row.querySelector("[data-agent-branch-meta='true']") as HTMLElement;
        expect(meta).not.toBeNull();

        // Under the name, not beside it.
        expect(meta.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          name.getBoundingClientRect().bottom - 1,
        );
        // Which is the point: `model · effort · tokens` fits at 330px now instead
        // of being cut off by a 45% cap.
        expect(meta.scrollWidth).toBeLessThanOrEqual(meta.clientWidth + 1);
        // Meta and the signal line read at one size, as the left sidebar's do.
        expect(getComputedStyle(meta).fontSize).toBe("11px");
        expect(
          getComputedStyle(row.querySelector("[data-agent-branch-output='true']")!).fontSize,
        ).toBe("11px");
        // Three lines, and no more: name, meta, and one signal line. The
        // objective used to take a fourth.
        expect(row.querySelector("[data-agent-branch-task='true']")).toBeNull();
        expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(66);
      }

      const [liveRow, historyRow] = rows as [HTMLElement, HTMLElement];

      // The live row hangs off the trunk on a slim tree gutter, and its arm still
      // meets the status dot after the row's padding tightened.
      const arm = (
        liveRow.querySelector("[data-agent-branch-arm='true']") as HTMLElement
      ).getBoundingClientRect();
      const node = (
        liveRow.querySelector("[data-agent-branch-node='true']") as HTMLElement
      ).getBoundingClientRect();
      expect(Math.abs((arm.top + arm.bottom) / 2 - (node.top + node.bottom) / 2)).toBeLessThan(1.5);
      expect(node.left - panel.left).toBeLessThanOrEqual(22);

      // The record does not: no arm, no indent, content on the panel's own 12px
      // gutter, level with the Earlier label above it.
      const earlier = document.querySelector("[data-agents-panel-earlier='true']")!;
      const earlierBox = earlier.getBoundingClientRect();
      expect(historyRow.querySelector("[data-agent-branch-arm='true']")).toBeNull();
      const historyName = historyRow.querySelector("[data-agent-branch-meta='true']")!
        .previousElementSibling as HTMLElement;
      const historyNameLeft = historyName.getBoundingClientRect().left - panel.left;
      expect(historyNameLeft).toBeCloseTo(12, 0);
      expect(
        earlier.querySelector("span.truncate")!.getBoundingClientRect().left - panel.left,
      ).toBeCloseTo(historyNameLeft, 0);

      // Its meta is `model · effort · tokens`; when it ran sits on the row's own
      // right edge instead, where a left thread row puts it.
      const historyMeta = historyRow.querySelector("[data-agent-branch-meta='true']")!;
      expect(historyMeta.textContent).toBe("gpt-5.6-sol · high");
      const time = historyRow.querySelector("[data-agent-branch-time='true']") as HTMLElement;
      expect(time.textContent).toMatch(/ago$/u);
      expect(panel.right - time.getBoundingClientRect().right).toBeLessThanOrEqual(34);

      // The trunk stops where the history starts: alive branches, done is filed.
      const trunk = document.querySelector("[data-agents-panel-trunk='true']")!;
      expect(trunk.getBoundingClientRect().bottom).toBeLessThanOrEqual(earlierBox.top + 0.5);
    } finally {
      await mounted.unmount();
    }
  });

  it("shows a disclosure at the right edge of a row that opens something, on hover", async () => {
    const mounted = await renderPanel({
      subagents: [
        // Transcript-backed, so clicking it drills in.
        buildSubagent({ label: "Router sweep" }),
        // No agent thread, so there is nothing to open and nothing to promise.
        buildSubagent({
          id: "agent-mute",
          agentThreadId: null,
          transcriptAgentId: null,
          label: "Unspawned sweep",
        }),
      ],
    });

    try {
      await expect.element(page.getByText("Unspawned sweep")).toBeVisible();
      const rows = [...document.querySelectorAll("[data-agent-branch='true']")] as HTMLElement[];
      const [openable, inert] = rows as [HTMLElement, HTMLElement];

      const chevron = openable.querySelector("[data-agent-branch-disclosure='true']");
      expect(chevron).not.toBeNull();
      expect(inert.querySelector("[data-agent-branch-disclosure='true']")).toBeNull();

      // Transparent until the row is hovered or focused: an always-drawn icon on
      // every row would be noise, and colour is the only thing that changes.
      const transparent = /(?:,|\/)\s*0\s*\)/u;
      expect(getComputedStyle(chevron!).color).toMatch(transparent);
      await page.getByRole("button", { name: "Open Router sweep transcript" }).hover();
      await vi.waitFor(() => {
        if (transparent.test(getComputedStyle(chevron!).color)) {
          throw new Error("The disclosure never appeared on hover.");
        }
      });
      // And it sits at the row's right edge, not in the text.
      expect(
        openable.getBoundingClientRect().right - chevron!.getBoundingClientRect().right,
      ).toBeLessThanOrEqual(16);
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

  it("fronts even a short tool run with a receipt, so the drill-in is prose and receipts", async () => {
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

      // The run is folded, not inlined, and the rows only arrive on request.
      await vi.waitFor(() => {
        expect(
          document.querySelector("[data-subagent-transcript-tool-run-toggle='true']"),
        ).not.toBeNull();
      });
      await expect.element(page.getByText("2 actions")).toBeVisible();
      expect(document.querySelector("[data-subagent-transcript-entry='tool']")).toBeNull();

      await page.getByRole("button", { name: /2 actions/u }).click();
      await expect.element(page.getByText("handler")).toBeVisible();
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

  it("shows the launcher as flat rows on the panel gutter, and opens one from a row", async () => {
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
      await expect.element(page.getByText("Working tree changes on this branch.")).toBeVisible();
      await expect.element(page.getByText("Subagents and background runs.")).toBeVisible();
      // No tab is open, so no surface is mounted behind the launcher.
      expect(document.querySelector("[data-testid='never-rendered']")).toBeNull();

      const panel = document
        .querySelector("[data-chat-right-panel='true']")!
        .getBoundingClientRect();
      const rows = [
        ...document.querySelectorAll("[data-right-panel-launcher-row]"),
      ] as HTMLElement[];
      expect(rows).toHaveLength(3);
      // "Open a panel" sits on the same gutter the rows do.
      const sectionLabelText = document.querySelector(
        "[data-right-panel-launcher='true'] span.truncate",
      )!;
      const labelLeft = sectionLabelText.getBoundingClientRect().left - panel.left;
      expect(labelLeft).toBeCloseTo(12, 0);

      for (const row of rows) {
        const box = row.getBoundingClientRect();
        // Full-width rows in the left sidebar's rhythm, not a grid of tiles: the
        // row spans the panel and its own height is a row's, not a card's.
        expect(Math.round(box.width)).toBe(Math.round(panel.width));
        expect(box.height).toBeGreaterThanOrEqual(38);
        expect(box.height).toBeLessThanOrEqual(46);
        // Nothing boxed: structure comes from the dividers between rows.
        expect(getComputedStyle(row).borderTopWidth).toBe("0px");
        expect(getComputedStyle(row).borderRadius).toBe("0px");
        // Row content opens on the panel's one gutter, level with the label.
        const icon = row.firstElementChild as HTMLElement;
        expect(icon.getBoundingClientRect().left - panel.left).toBeCloseTo(labelLeft, 0);
        // A description is read, not guessed at: it fits its line whole.
        const description = row.querySelector("span > span:last-child") as HTMLElement;
        expect(description.textContent).toMatch(/\.$/u);
        expect(description.scrollWidth).toBeLessThanOrEqual(description.clientWidth + 1);
      }

      (document.querySelector("[data-right-panel-launcher-row='diff']") as HTMLElement).click();
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

  it("scrolls the tab row instead of shrinking or clipping tabs when it overflows", async () => {
    // Three tabs and the `+` come to ~200px now that the ✕ shares the glyph's
    // slot instead of holding a column of its own, which fits both the 330px
    // default and the 272px floor. It still does not fit the Windows overlay,
    // whose right padding is the controls cluster (~154px), so that case scrolls
    // as the browser panel's does: labels stay whole, tabs stay the same width,
    // the ones off screen are reachable rather than cut in half, and the `+`
    // stays put -- beside the last tab while they fit, out at the usable right
    // edge once they do not, with the tabs scrolling under it either way.
    // Which case a width falls into is measured, not assumed: the point is that
    // both behaviours hold, not where the boundary between them happens to sit.
    const widthsByPanel = new Map<string, ReadonlyArray<number>>();
    const stripHeights = new Map<string, number>();
    for (const width of [330, 272]) {
      const mounted = await render(
        <main style={{ boxSizing: "border-box", height: 640, width }}>
          <ChatRightPanel
            openTabs={["sourceControl", "diff", "agents"]}
            availableTabs={["sourceControl", "diff", "agents"]}
            activeTab="agents"
            onSelectTab={vi.fn()}
            onCloseTab={vi.fn()}
          >
            <div />
          </ChatRightPanel>
        </main>,
      );

      try {
        await expect.element(page.getByRole("tab", { name: "Changes" })).toBeVisible();
        const strip = document.querySelector("[data-right-panel-strip='true']") as HTMLElement;
        const row = document.querySelector("[data-right-panel-tabs-row='true']") as HTMLElement;
        const tablist = document.querySelector("[data-right-panel-tablist='true']") as HTMLElement;
        const viewport = row.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
        const plus = document.querySelector("[data-right-panel-add-tab='true']") as HTMLElement;
        const scrollbar = () =>
          row.querySelector<HTMLElement>(
            '[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]',
          );

        // Measured with the panel at this width, and again with the row padded
        // clear of the Windows controls cluster -- the tightest strip there is.
        for (const wco of [false, true]) {
          row.style.paddingRight = wco ? "154px" : "";
          // Layout settles synchronously on read, so this is the real answer for
          // this width rather than a guess baked into the test.
          const overflowing = viewport.scrollWidth - viewport.clientWidth > 0;
          // The bar is mounted off a resize observation, so it arrives a frame
          // after the padding that caused the overflow.
          await vi.waitFor(() => {
            if (overflowing !== (scrollbar()?.getClientRects().length === 1)) {
              throw new Error("The overlay scrollbar never matched the overflow state.");
            }
          });
          stripHeights.set(`${width}:${wco}`, strip.getBoundingClientRect().height);
          const tabs = [...document.querySelectorAll("[data-right-panel-tab]")] as HTMLElement[];
          expect(tabs).toHaveLength(3);
          const content = tablist.parentElement!.getBoundingClientRect();

          for (const tab of tabs) {
            // The label, not the glyph slot that now precedes it.
            const label = tab.querySelector(
              "[role='tab'] span:not([data-right-panel-tab-glyph])",
            ) as HTMLElement;
            // No label is ever abbreviated to "Cha…".
            expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
            expect(getComputedStyle(label).textOverflow).toBe("clip");
            // And no tab is cut off against the strip: every one is drawn whole
            // inside the scroll content, however little of it is on screen.
            const box = tab.getBoundingClientRect();
            expect(box.left).toBeGreaterThanOrEqual(content.left - 0.5);
            expect(box.right).toBeLessThanOrEqual(content.right + 0.5);
          }
          expect(
            [...document.querySelectorAll("[data-right-panel-tab] [role='tab']")].map(
              (tab) => tab.textContent,
            ),
          ).toEqual(["Changes", "Diff", "Agents"]);
          widthsByPanel.set(
            `${width}:${wco}`,
            tabs.map((tab) => Math.round(tab.getBoundingClientRect().width)),
          );

          // The + is anchored beside the scroller rather than riding inside it,
          // it never leaves the strip, and it is always the thing under the
          // pointer -- however far the tabs have scrolled behind it.
          const rowBox = row.getBoundingClientRect();
          // What the strip actually has to spend, which in the overlay case is
          // everything left of the window controls.
          const usableRight = rowBox.right - parseFloat(getComputedStyle(row).paddingRight);
          const plusBox = plus.getBoundingClientRect();
          expect(plusBox.left).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().right - 0.5);
          expect(plusBox.right).toBeLessThanOrEqual(usableRight + 0.5);
          const hit = document.elementFromPoint(
            (plusBox.left + plusBox.right) / 2,
            (plusBox.top + plusBox.bottom) / 2,
          );
          expect(plus.contains(hit)).toBe(true);

          const overflow = viewport.scrollWidth - viewport.clientWidth;
          if (!overflowing) {
            // The default width holds all three and the +, with room over. The
            // scroller takes its width from the tabs, so the + parks right after
            // the last one rather than out at the far edge, and there is no bar.
            expect(overflow).toBe(0);
            const lastTab = tabs[tabs.length - 1]!.getBoundingClientRect();
            expect(plusBox.left - lastTab.right).toBeLessThan(8);
            // Beside the last tab, so demonstrably not flush against the usable
            // edge the overflowing case pins it to. How much room is left over
            // depends on the width, and is not the point.
            expect(usableRight - plusBox.right).toBeGreaterThan(8);
          } else {
            // Everything tighter gives the scroller every pixel the + does not
            // need: the + goes flush to the usable right edge and the tabs scroll
            // under it, all the way to the far end.
            expect(overflow).toBeGreaterThan(0);
            expect(usableRight - plusBox.right).toBeLessThanOrEqual(1);
            viewport.scrollLeft = overflow;
            expect(
              document.querySelector("[data-right-panel-tab='agents']")!.getBoundingClientRect()
                .right,
            ).toBeLessThanOrEqual(viewport.getBoundingClientRect().right + 0.5);
            viewport.scrollLeft = 0;

            // And it says so with the browser strip's hairline overlay bar:
            // visible without hovering, inside the row, costing it no height.
            const bar = scrollbar()!;
            expect(getComputedStyle(bar).opacity).toBe("1");
            expect(getComputedStyle(bar).position).toBe("absolute");
            const barBox = bar.getBoundingClientRect();
            expect(barBox.height).toBeLessThanOrEqual(6);
            // And opaque, since it lies across the tabs: a translucent thumb let
            // a label show through and the two read as one layer. Asserted on the
            // computed colour because the alpha lives in a class that would fail
            // silently, leaving the primitive's translucent default in place.
            const thumbColor = getComputedStyle(
              bar.querySelector('[data-slot="scroll-area-thumb"]')!,
            ).backgroundColor;
            expect(thumbColor.startsWith("rgba(")).toBe(false);
            expect(thumbColor).not.toContain("/");
            expect(barBox.bottom).toBeLessThanOrEqual(rowBox.bottom + 0.5);
          }
        }
        row.style.paddingRight = "";
      } finally {
        await mounted.unmount();
      }
    }

    // The clincher: a tab is the same width in a 272px panel, or in a row shared
    // with the window controls, as it is in a 330px one. Nothing shrinks, so
    // nothing has to be abbreviated to fit.
    const reference = widthsByPanel.get("330:false");
    for (const widths of widthsByPanel.values()) {
      expect(widths).toEqual(reference);
    }
    // And the strip is the same height whether it is scrolling or not: the bar
    // and the fades are overlays, as the browser strip's are, so overflow never
    // costs the row a pixel of the titlebar it shares.
    expect([...stripHeights.values()]).toEqual(
      Array.from(stripHeights, () => stripHeights.get("330:false")),
    );
  });

  it("brings the active tab into view when the row is scrolled past it", async () => {
    // Narrow enough that the three tabs genuinely do not fit, so whichever one is
    // active is the one the strip has to reach.
    const panel = (activeTab: "sourceControl" | "agents") => (
      <main style={{ boxSizing: "border-box", height: 640, width: 200 }}>
        <ChatRightPanel
          openTabs={["sourceControl", "diff", "agents"]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={activeTab}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div />
        </ChatRightPanel>
      </main>
    );
    const mounted = await render(panel("agents"));

    try {
      await expect.element(page.getByRole("tab", { name: "Changes" })).toBeVisible();
      const viewport = document.querySelector(
        '[data-right-panel-tabs-row="true"] [data-slot="scroll-area-viewport"]',
      ) as HTMLElement;
      const rightEdge = () => viewport.getBoundingClientRect().right + 0.5;
      const leftEdge = () => viewport.getBoundingClientRect().left - 0.5;
      const tabBox = (tab: string) =>
        document.querySelector(`[data-right-panel-tab='${tab}']`)!.getBoundingClientRect();

      // Opening the panel on the last tab has already scrolled the row to it.
      await vi.waitFor(() => {
        if (viewport.scrollLeft <= 0 || tabBox("agents").right > rightEdge()) {
          throw new Error("The strip never scrolled the active tab into view.");
        }
      });

      // Selecting one off the other end brings it back, by the shortest scroll.
      mounted.rerender(panel("sourceControl"));
      await vi.waitFor(() => {
        if (tabBox("sourceControl").left < leftEdge()) {
          throw new Error("The strip never scrolled back to the newly active tab.");
        }
      });
      expect(viewport.scrollLeft).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("leaves one open tab a tab, not a bar across the strip", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["sourceControl"]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab="sourceControl"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div />
        </ChatRightPanel>
      </main>,
    );

    try {
      await expect.element(page.getByRole("tab", { name: "Changes" })).toBeVisible();
      const row = (
        document.querySelector("[data-right-panel-tabs-row='true']") as HTMLElement
      ).getBoundingClientRect();
      const tab = (
        document.querySelector("[data-right-panel-tab='sourceControl']") as HTMLElement
      ).getBoundingClientRect();
      const plus = (
        document.querySelector("[data-right-panel-add-tab='true']") as HTMLElement
      ).getBoundingClientRect();

      expect(tab.width).toBeLessThan(row.width / 2);
      expect(plus.left - tab.right).toBeLessThan(8);
      // The rest of the strip is empty rather than tab.
      expect(row.right - plus.right).toBeGreaterThan(row.width / 3);
    } finally {
      await mounted.unmount();
    }
  });

  it("parks the + at the strip's left edge while the launcher is showing", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={[]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={null}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div />
        </ChatRightPanel>
      </main>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Open panel" })).toBeVisible();
      const row = (
        document.querySelector("[data-right-panel-tabs-row='true']") as HTMLElement
      ).getBoundingClientRect();
      const plus = (
        document.querySelector("[data-right-panel-add-tab='true']") as HTMLElement
      ).getBoundingClientRect();

      expect(document.querySelectorAll("[data-right-panel-tab]")).toHaveLength(0);
      expect(plus.left - row.left).toBeLessThan(12);
    } finally {
      await mounted.unmount();
    }
  });

  it("shares the titlebar row with the window controls on Windows", async () => {
    // The overlay's env() geometry does not exist in the test browser, so this
    // covers the wiring the wco variant needs: one strip row, of titlebar
    // height, padded clear of the min/max/close cluster, and draggable.
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["agents"]}
          availableTabs={["agents"]}
          activeTab="agents"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div />
        </ChatRightPanel>
      </main>,
    );

    try {
      const strip = await vi.waitFor(() => {
        const found = document.querySelector("[data-right-panel-strip='true']");
        if (!found) throw new Error("The strip never rendered.");
        return found as HTMLElement;
      });
      const tabsRow = strip.querySelector("[data-right-panel-tabs-row='true']") as HTMLElement;

      // One row, and it is the strip's only one.
      expect(strip.children).toHaveLength(1);
      expect(strip.firstElementChild).toBe(tabsRow);
      expect(strip.className).toContain("drag-region");
      // Titlebar height, and clear of the controls cluster.
      expect(tabsRow.className).toContain("wco:min-h-[env(titlebar-area-height)]");
      expect(tabsRow.className).toContain("wco:pr-[calc(100vw-env(titlebar-area-width)");
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
      const close = page.getByRole("button", { name: "Close Changes" });
      // The ✕ takes the glyph's place rather than a column of its own: it covers
      // the glyph, and the tab is only as wide as its padding, glyph and label,
      // so nothing about the strip's width depends on a control that is
      // invisible until the pointer arrives.
      const closeBox = (await close.element()).getBoundingClientRect();
      const tab = document.querySelector("[data-right-panel-tab='sourceControl']") as HTMLElement;
      const glyphBox = tab.querySelector("[data-right-panel-tab-glyph]")!.getBoundingClientRect();
      const labelBox = tab
        .querySelector("[role='tab'] span:not([data-right-panel-tab-glyph])")!
        .getBoundingClientRect();
      const tabBox = tab.getBoundingClientRect();
      expect(
        Math.abs(closeBox.left + closeBox.width / 2 - (glyphBox.left + glyphBox.width / 2)),
      ).toBeLessThan(3);
      expect(closeBox.right).toBeLessThanOrEqual(labelBox.left + 1);
      expect(tabBox.right - labelBox.right).toBeLessThan(closeBox.width);

      await close.click();
      expect(onCloseTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });
});
