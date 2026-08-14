import "../../index.css";

import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type {
  SubagentProgressItem,
  ThreadSubagentHistoryEntry,
  WorkLogEntry,
} from "../../session-logic";
import { resetAgentsPanelSourceForTests } from "../../agentsPanelStore";
import { AgentsPanel } from "./AgentsPanel";
import { ChatRightPanel } from "../ChatRightPanel";
import { buildRightPanelLauncherStates } from "./rightPanelLauncherState";
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

  it("bridges child activity into one expandable receipt when the provider transcript omits tools", async () => {
    transcriptRpcMock.mockResolvedValue({
      entries: [{ role: "assistant", text: "I am checking the route.", toolUses: [] }],
      truncated: false,
      offset: 0,
      totalEntries: 1,
    });
    const workEntries: WorkLogEntry[] = [
      {
        id: "command-1",
        createdAt: "2026-08-13T20:30:00.000Z",
        completedAt: "2026-08-13T20:30:02.000Z",
        label: "Ran command",
        rawCommand: "rg -n handler apps/web",
        outputPreview: "apps/web/router.ts:42",
        tone: "tool",
        itemType: "command_execution",
        executionState: "completed",
        sourceAgentThreadId: "agent-1",
        toolCallId: "call-1",
      },
      {
        id: "command-2",
        createdAt: "2026-08-13T20:30:05.000Z",
        label: "Ran command",
        rawCommand: "vp run typecheck",
        tone: "tool",
        itemType: "command_execution",
        executionState: "running",
        sourceAgentThreadId: "agent-1",
        toolCallId: "call-2",
      },
    ];
    const mounted = await renderPanel({
      subagents: [buildSubagent({ label: "Router sweep" })],
      workEntries,
    });

    try {
      await page.getByRole("button", { name: "Open Router sweep transcript" }).click();
      await expect.element(page.getByText("I am checking the route.")).toBeVisible();

      const receipt = await vi.waitUntil(() =>
        document.querySelector<HTMLElement>("[data-subagent-transcript-activity-toggle='true']"),
      );
      expect(receipt.textContent).toContain("Activity");
      expect(receipt.textContent).toContain("2 actions");
      expect(receipt.textContent).toContain("Running command");
      expect(receipt.textContent).toContain("vp run typecheck");
      expect(receipt.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-subagent-transcript-entry='tool']")).toBeNull();

      receipt.click();
      await vi.waitFor(() => {
        expect(receipt.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelectorAll("[data-subagent-transcript-entry='tool']")).toHaveLength(
          2,
        );
      });
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
      const sourceTab = page.getByRole("tab", { name: "Source" });
      await expect.element(sourceTab).toBeVisible();
      await sourceTab.click();
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

  it("dims the launcher rows whose surfaces are empty, and opens them anyway", async () => {
    const onSelectTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={[]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={null}
          launcherSurfaceStates={buildRightPanelLauncherStates({
            workingTreeFileCount: 0,
            reviewableTurnCount: 0,
            diffHasExplicitTarget: false,
            agents: { subagents: [], backgroundRuns: [], history: [] },
          })}
          onSelectTab={onSelectTab}
          onCloseTab={vi.fn()}
        >
          <div data-testid="never-rendered" />
        </ChatRightPanel>
      </main>,
    );

    try {
      await expect.element(page.getByText("No uncommitted changes.")).toBeVisible();
      await expect.element(page.getByText("No changes to review.")).toBeVisible();
      await expect.element(page.getByText("No agents yet.")).toBeVisible();

      const rows = [
        ...document.querySelectorAll("[data-right-panel-launcher-row]"),
      ] as HTMLElement[];
      const foregroundLabel = getComputedStyle(document.body).color;
      // Source is never dimmed by a clean tree -- branching, committing and
      // opening a pull request are all reasons to go there with nothing
      // changed -- so only the two surfaces that really are empty are.
      const dimmedRows = rows.filter(
        (row) => row.dataset.rightPanelLauncherRow !== "sourceControl",
      );
      expect(dimmedRows).toHaveLength(2);
      expect(
        rows.find((row) => row.dataset.rightPanelLauncherRow === "sourceControl")?.dataset
          .rightPanelLauncherRowEmpty,
      ).toBeUndefined();
      for (const row of dimmedRows) {
        expect(row.dataset.rightPanelLauncherRowEmpty).toBe("true");
        // Dimmed, not disabled: nothing here says the row cannot be used.
        expect(row.hasAttribute("disabled")).toBe(false);
        expect(row.getAttribute("aria-disabled")).toBeNull();
        expect(getComputedStyle(row).pointerEvents).not.toBe("none");
        expect(getComputedStyle(row).textDecorationLine).toBe("none");
        const label = row.querySelector("span > span:first-child") as HTMLElement;
        expect(getComputedStyle(label).color).not.toBe(foregroundLabel);
      }

      // Every dimmed row still opens its surface.
      for (const row of rows) {
        row.click();
      }
      expect(onSelectTab.mock.calls.map((call) => call[0])).toEqual([
        "sourceControl",
        "diff",
        "agents",
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("reports the working tree and the thread's agents on the launcher's rows", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={[]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={null}
          launcherSurfaceStates={buildRightPanelLauncherStates({
            workingTreeFileCount: 12,
            reviewableTurnCount: 4,
            diffHasExplicitTarget: false,
            agents: {
              subagents: [buildSubagent({ label: "Router sweep" })],
              backgroundRuns: [],
              history: [
                buildHistoryEntry({
                  item: buildSubagent({
                    id: "old",
                    agentThreadId: "agent-old",
                    status: "completed",
                  }),
                }),
              ],
            },
          })}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div data-testid="never-rendered" />
        </ChatRightPanel>
      </main>,
    );

    try {
      // Source and Diff open onto the same working tree, so they report it alike.
      await expect.element(page.getByText("12 files changed.").first()).toBeVisible();
      expect(document.querySelectorAll("[data-right-panel-launcher-row-empty]")).toHaveLength(0);
      await expect.element(page.getByText("1 of 2 agents running.")).toBeVisible();

      for (const row of [
        ...document.querySelectorAll("[data-right-panel-launcher-row]"),
      ] as HTMLElement[]) {
        // A count is read, not guessed at: it fits its line whole at 330px.
        const description = row.querySelector("span > span:last-child") as HTMLElement;
        expect(description.scrollWidth).toBeLessThanOrEqual(description.clientWidth + 1);
      }
    } finally {
      await mounted.unmount();
    }
  });

  it("never dims a Diff tab that is pointed at a file, even on a clean tree", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["diff"]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={null}
          launcherSurfaceStates={buildRightPanelLauncherStates({
            workingTreeFileCount: 0,
            reviewableTurnCount: 0,
            diffHasExplicitTarget: true,
            agents: { subagents: [], backgroundRuns: [], history: [] },
          })}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div data-testid="never-rendered" />
        </ChatRightPanel>
      </main>,
    );

    try {
      const diffRow = document.querySelector(
        "[data-right-panel-launcher-row='diff']",
      ) as HTMLElement;
      expect(diffRow.dataset.rightPanelLauncherRowEmpty).toBeUndefined();
      await expect.element(page.getByText("Review this thread's diff.")).toBeVisible();
      // The tree really is clean, and Source reports that without dimming for it.
      expect(
        (document.querySelector("[data-right-panel-launcher-row='sourceControl']") as HTMLElement)
          .dataset.rightPanelLauncherRowEmpty,
      ).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps Diff lit after a commit, when only the working tree went quiet", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={[]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab={null}
          launcherSurfaceStates={buildRightPanelLauncherStates({
            workingTreeFileCount: 0,
            reviewableTurnCount: 6,
            diffHasExplicitTarget: false,
            agents: { subagents: [], backgroundRuns: [], history: [] },
          })}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        >
          <div data-testid="never-rendered" />
        </ChatRightPanel>
      </main>,
    );

    try {
      const diffRow = document.querySelector(
        "[data-right-panel-launcher-row='diff']",
      ) as HTMLElement;
      expect(diffRow.dataset.rightPanelLauncherRowEmpty).toBeUndefined();
      // The longest line the launcher can produce still fits its row whole.
      const description = diffRow.querySelector("span > span:last-child") as HTMLElement;
      expect(description.textContent).toBe("No uncommitted changes, 6 turns to review.");
      expect(description.scrollWidth).toBeLessThanOrEqual(description.clientWidth + 1);
      // Source reports the quiet tree, and stays lit for the branch and commit
      // controls that are the reason to open it after a commit.
      expect(
        (document.querySelector("[data-right-panel-launcher-row='sourceControl']") as HTMLElement)
          .dataset.rightPanelLauncherRowEmpty,
      ).toBeUndefined();
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

      const sourceItem = await vi.waitFor(() => {
        const item = document.querySelector("[data-right-panel-menu-tab='sourceControl']");
        if (!item) throw new Error("The + menu never listed Source.");
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
      expect(sourceItem.getAttribute("data-right-panel-menu-tab-open")).toBeNull();

      sourceItem.click();
      expect(onSelectTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });

  it("dims an empty Diff entry in the + menu without disabling it", async () => {
    const onSelectTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["sourceControl"]}
          availableTabs={["sourceControl", "diff", "agents"]}
          activeTab="sourceControl"
          launcherSurfaceStates={buildRightPanelLauncherStates({
            workingTreeFileCount: 0,
            reviewableTurnCount: 0,
            diffHasExplicitTarget: false,
            agents: {
              subagents: [buildSubagent({ label: "Router sweep" })],
              backgroundRuns: [],
              history: [],
            },
          })}
          onSelectTab={onSelectTab}
          onCloseTab={vi.fn()}
        >
          <div />
        </ChatRightPanel>
      </main>,
    );

    try {
      await page.getByRole("button", { name: "Open panel" }).click();

      const diffItem = await vi.waitFor(() => {
        const item = document.querySelector("[data-right-panel-menu-tab='diff']");
        if (!item) throw new Error("The + menu never listed Diff.");
        return item as HTMLElement;
      });
      const agentsItem = document.querySelector(
        "[data-right-panel-menu-tab='agents']",
      ) as HTMLElement;

      expect(diffItem.dataset.rightPanelMenuTabEmpty).toBe("true");
      expect(agentsItem.dataset.rightPanelMenuTabEmpty).toBeUndefined();
      expect(getComputedStyle(diffItem).color).not.toBe(getComputedStyle(agentsItem).color);
      // Empty is only a visual state: opening Diff still reaches its own empty
      // surface, where the fuller explanation belongs.
      expect(diffItem.hasAttribute("disabled")).toBe(false);
      expect(diffItem.getAttribute("aria-disabled")).toBeNull();
      expect(getComputedStyle(diffItem).pointerEvents).not.toBe("none");

      diffItem.click();
      expect(onSelectTab).toHaveBeenCalledWith("diff");
    } finally {
      await mounted.unmount();
    }
  });

  it("labels every tab while they fit, and drops all the labels rather than scrolling", async () => {
    // Both panel widths that matter -- the 330px default and the 272px floor --
    // and each of them twice: as the panel has the row to itself, and with the
    // row padded clear of the Windows controls cluster (~154px), which is the
    // tightest this strip ever gets and the case that used to lose sight of the
    // tab you came from behind a scroll. Which side of the boundary a width falls
    // on is measured, not assumed; the point is that both behaviours hold.
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
        await expect.element(page.getByRole("tab", { name: "Source" })).toBeVisible();
        const strip = document.querySelector("[data-right-panel-strip='true']") as HTMLElement;
        const row = document.querySelector("[data-right-panel-tabs-row='true']") as HTMLElement;
        const viewport = row.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
        const plus = document.querySelector("[data-right-panel-add-tab='true']") as HTMLElement;
        const mode = () => strip.getAttribute("data-right-panel-strip-mode");
        const tabs = () =>
          [...document.querySelectorAll("[data-right-panel-tab]")] as HTMLElement[];
        const expectPlusUsable = () => {
          const box = plus.getBoundingClientRect();
          const usableRight =
            row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight);
          expect(box.right).toBeLessThanOrEqual(usableRight + 0.5);
          const hit = document.elementFromPoint(
            (box.left + box.right) / 2,
            (box.top + box.bottom) / 2,
          );
          expect(plus.contains(hit)).toBe(true);
        };

        // The panel with the row to itself: three whole labels, nothing scrolling,
        // and the + parked directly after the last tab rather than out at the edge.
        // True at the floor as well as the default -- collapsing is not a width
        // threshold, it is whether these particular labels fit.
        expect(mode()).toBe("labels");
        const labelledHeight = strip.getBoundingClientRect().height;
        const labelledWidths = tabs().map((tab) => Math.round(tab.getBoundingClientRect().width));
        expect(
          [...document.querySelectorAll("[data-right-panel-tab] [role='tab']")].map(
            (tab) => tab.textContent,
          ),
        ).toEqual(["Source", "Diff", "Agents"]);
        for (const tab of tabs()) {
          const label = tab.querySelector("[data-right-panel-tab-label]") as HTMLElement;
          expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
          expect(getComputedStyle(label).textOverflow).toBe("clip");
        }
        expect(viewport.scrollWidth - viewport.clientWidth).toBe(0);
        expect(
          plus.getBoundingClientRect().left - tabs().at(-1)!.getBoundingClientRect().right,
        ).toBeLessThan(8);
        expectPlusUsable();

        // Now the row the window controls take their cut of. Two labelled tabs
        // already do not fit; the answer is every label, not a scrollbar.
        row.style.paddingRight = "154px";
        await vi.waitFor(() => {
          if (mode() !== "icons") {
            throw new Error("The strip never collapsed its labels.");
          }
        });

        // All of them, not just the inactive ones: one labelled tab beside two
        // glyphs reads as three different kinds of thing.
        expect(document.querySelectorAll("[data-right-panel-tab-label]")).toHaveLength(0);
        expect(document.querySelectorAll("[data-right-panel-tab-icon-only='true']")).toHaveLength(
          3,
        );
        // And nothing is abbreviated on the way: the name is a tooltip, or nowhere.
        expect(
          tabs().map((tab) => tab.querySelector("[role='tab']")!.getAttribute("aria-label")),
        ).toEqual(["Source", "Diff", "Agents"]);
        for (const tab of tabs()) {
          const box = tab.getBoundingClientRect();
          // Square-ish: the glyph and its padding, nothing else.
          expect(box.width).toBeGreaterThanOrEqual(24);
          expect(box.width).toBeLessThanOrEqual(34);
          expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(6);
          expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth + 1);
        }
        const iconWidths = tabs().map((tab) => Math.round(tab.getBoundingClientRect().width));
        const total = (widths: ReadonlyArray<number>) =>
          widths.reduce((sum, next) => sum + next, 0);
        expect(total(iconWidths)).toBeLessThan(total(labelledWidths));
        // The + is still the anchored, clickable control it was, and the strip is
        // the same height: collapsing is a width decision, not a layout one.
        expectPlusUsable();
        expect(strip.getBoundingClientRect().height).toBeCloseTo(labelledHeight, 1);

        // Give the room back and the labels come back with it, unchanged.
        row.style.paddingRight = "";
        await vi.waitFor(() => {
          if (mode() !== "labels") {
            throw new Error("The strip never put its labels back.");
          }
        });
        expect(tabs().map((tab) => Math.round(tab.getBoundingClientRect().width))).toEqual(
          labelledWidths,
        );
      } finally {
        await mounted.unmount();
      }
    }
  });

  it("crosses the label boundary once per crossing rather than oscillating on it", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 420 }}>
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
      await expect.element(page.getByRole("tab", { name: "Source" })).toBeVisible();
      const strip = document.querySelector("[data-right-panel-strip='true']") as HTMLElement;
      const row = document.querySelector("[data-right-panel-tabs-row='true']") as HTMLElement;
      const mode = () => strip.getAttribute("data-right-panel-strip-mode");
      // The boundary is computed from the strip's own inputs -- the labelled row
      // it measures against and the width the anchored controls take out of the
      // row -- rather than guessed at, so this test does not encode a font.
      const labelled = (row.querySelector("[data-right-panel-tabs-measure='true']") as HTMLElement)
        .offsetWidth;
      const actions = (row.querySelector("[data-right-panel-strip-actions='true']") as HTMLElement)
        .offsetWidth;
      const paddingLeaving = (available: number) =>
        `${row.clientWidth - parseFloat(getComputedStyle(row).paddingLeft) - actions - available}px`;
      const settle = async () => {
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise((resolve) => {
            requestAnimationFrame(() => resolve(null));
          });
        }
      };

      let flips = 0;
      const observer = new MutationObserver(() => {
        flips += 1;
      });
      observer.observe(strip, { attributeFilter: ["data-right-panel-strip-mode"] });
      try {
        expect(mode()).toBe("labels");

        // Four pixels short: the labels go, once.
        row.style.paddingRight = paddingLeaving(labelled - 4);
        await vi.waitFor(() => {
          if (mode() !== "icons") {
            throw new Error("The strip never collapsed its labels.");
          }
        });
        expect(flips).toBe(1);

        // Four pixels back the other way -- a drag jittering on the boundary.
        // They fit again by the strict measure, and the strip stays put anyway:
        // that gap is the hysteresis, and it is what stops the flicker.
        row.style.paddingRight = paddingLeaving(labelled + 4);
        await settle();
        expect(mode()).toBe("icons");
        expect(flips).toBe(1);

        // Real headroom does bring them back, and once.
        row.style.paddingRight = paddingLeaving(labelled + 20);
        await vi.waitFor(() => {
          if (mode() !== "labels") {
            throw new Error("Real headroom never brought the labels back.");
          }
        });
        await settle();
        expect(flips).toBe(2);
      } finally {
        observer.disconnect();
      }
    } finally {
      await mounted.unmount();
    }
  });

  it("names an icon-only tab with a styled tooltip that arrives with the pointer", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 200 }}>
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
      const strip = await vi.waitFor(() => {
        const found = document.querySelector("[data-right-panel-strip='true']");
        if (found?.getAttribute("data-right-panel-strip-mode") !== "icons") {
          throw new Error("The strip never collapsed to icons at 200px.");
        }
        return found as HTMLElement;
      });
      const tabButton = strip.querySelector(
        "[data-right-panel-tab='diff'] [role='tab']",
      ) as HTMLElement;
      // The app's own tooltip, not the unstyled OS one a `title` would give.
      expect(tabButton.getAttribute("title")).toBeNull();

      await page.getByRole("tab", { name: "Diff" }).hover();
      // No dwell: on a tab with no label, waiting reads as an unnamed control.
      const tooltip = await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="tooltip-popup"]');
        if (popup === null) {
          throw new Error("Hovering an icon-only tab never named it.");
        }
        return popup as HTMLElement;
      });
      expect(tooltip.textContent).toBe("Diff");
    } finally {
      await mounted.unmount();
    }
  });

  it("leaves a labelled tab's name on the tab rather than in a tooltip", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 420 }}>
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
      await expect.element(page.getByRole("tab", { name: "Source" })).toBeVisible();
      await page.getByRole("tab", { name: "Source" }).hover();
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise((resolve) => {
          requestAnimationFrame(() => resolve(null));
        });
      }
      // The label is right there; a tooltip repeating it is noise.
      expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("brings the active tab into view when the row is scrolled past it", async () => {
    // Narrow enough that even the collapsed icons do not fit -- scrolling is the
    // last resort now, past dropping every label -- so whichever tab is active is
    // the one the strip has to reach.
    const panel = (activeTab: "sourceControl" | "agents") => (
      <main style={{ boxSizing: "border-box", height: 640, width: 110 }}>
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
      await expect.element(page.getByRole("tab", { name: "Source" })).toBeVisible();
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
      await expect.element(page.getByRole("tab", { name: "Source" })).toBeVisible();
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

  it("gives an inactive tab distinct resting and hover surfaces", async () => {
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 330 }}>
        <ChatRightPanel
          openTabs={["sourceControl", "agents"]}
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
      await expect.element(page.getByRole("tab", { name: "Agents" })).toBeVisible();
      const panel = document.querySelector("[data-chat-right-panel='true']") as HTMLElement;
      const inactiveTab = document.querySelector("[data-right-panel-tab='agents']") as HTMLElement;
      const panelBackground = getComputedStyle(panel).backgroundColor;
      const restingBackground = getComputedStyle(inactiveTab).backgroundColor;

      expect(restingBackground).not.toBe(panelBackground);

      await page.getByRole("tab", { name: "Agents" }).hover();
      await vi.waitFor(() => {
        if (getComputedStyle(inactiveTab).backgroundColor === restingBackground) {
          throw new Error("The inactive tab never gained its separate hover surface.");
        }
      });
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

  it("reveals a tab's ✕ on its right edge, costing the tab no width", async () => {
    const onCloseTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 420 }}>
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
      await expect.element(page.getByRole("tab", { name: "Source" })).toBeVisible();
      const tab = document.querySelector("[data-right-panel-tab='sourceControl']") as HTMLElement;
      const tabButton = tab.querySelector("[role='tab']") as HTMLElement;
      const glyph = tab.querySelector("[data-right-panel-tab-glyph]") as HTMLElement;
      const label = tab.querySelector("[data-right-panel-tab-label]") as HTMLElement;
      const close = tab.querySelector("[data-right-panel-close-tab]") as HTMLElement;
      const restingWidth = tab.getBoundingClientRect().width;

      // Nothing on show for a tab nobody is pointing at.
      expect(getComputedStyle(close).opacity).toBe("0");

      // Keyboard reaches it the same way the pointer does: focus the tab, then
      // the ✕ is the next stop and shows itself on arrival.
      tabButton.focus();
      await userEvent.keyboard("{Tab}");
      await vi.waitFor(() => {
        if (document.activeElement !== close) {
          throw new Error("Tabbing off the tab never reached its ✕.");
        }
        if (getComputedStyle(close).opacity !== "1") {
          throw new Error("focus-visible never revealed the ✕.");
        }
      });

      await page.getByRole("tab", { name: "Source" }).hover();
      await vi.waitFor(() => {
        if (getComputedStyle(close).opacity !== "1") {
          throw new Error("Hover never revealed the ✕.");
        }
      });

      // The whole point of overlaying it: the tab is the same box revealed as it
      // is at rest, so nothing in the strip's width is spent on it.
      expect(tab.getBoundingClientRect().width).toBeCloseTo(restingWidth, 1);

      const closeBox = close.getBoundingClientRect();
      const tabBox = tab.getBoundingClientRect();
      // On the right edge, and the icon stays exactly where it was -- the ✕ used
      // to take the glyph's slot, which moved the one thing naming the surface.
      expect(closeBox.left).toBeGreaterThan(glyph.getBoundingClientRect().right);
      expect(tabBox.right - closeBox.right).toBeLessThanOrEqual(4);
      expect(getComputedStyle(glyph).opacity).toBe("1");
      // The label slides under it behind a short fade rather than being clipped
      // to an ellipsis or pushed along.
      expect(getComputedStyle(label).maskImage).toContain("gradient");
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);

      await page.getByRole("button", { name: "Close Source" }).click();
      expect(onCloseTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });

  it("closes an icon-only tab from the active tab's ✕, and any of them by middle-click", async () => {
    // With no label to overlay there is nowhere for a per-tab ✕ to go that does
    // not turn a 28px box into two opposite meanings, so an inactive icon offers
    // none: hovering it goes to its surface. The active icon's ✕ takes the whole
    // box -- a real target, not a badge on a corner -- and middle-click closes
    // any of them outright, so no panel width strands a tab open.
    const onCloseTab = vi.fn();
    const mounted = await render(
      <main style={{ boxSizing: "border-box", height: 640, width: 200 }}>
        <ChatRightPanel
          openTabs={["sourceControl", "diff", "agents"]}
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
      const strip = await vi.waitFor(() => {
        const found = document.querySelector("[data-right-panel-strip='true']");
        if (found?.getAttribute("data-right-panel-strip-mode") !== "icons") {
          throw new Error("The strip never collapsed to icons at 200px.");
        }
        return found as HTMLElement;
      });

      expect(strip.querySelector("[data-right-panel-close-tab='diff']")).toBeNull();
      expect(strip.querySelector("[data-right-panel-close-tab='agents']")).toBeNull();
      const activeTab = strip.querySelector(
        "[data-right-panel-tab='sourceControl']",
      ) as HTMLElement;
      const close = activeTab.querySelector("[data-right-panel-close-tab]") as HTMLElement;
      const closeGlyph = close.querySelector("[data-right-panel-close-glyph]") as HTMLElement;
      const activeBox = activeTab.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      expect(closeBox.width).toBeGreaterThanOrEqual(24);
      expect(closeBox.width).toBeCloseTo(activeBox.width, 0);
      expect(closeBox.height).toBeCloseTo(activeBox.height, 0);

      const restingGlyphBackground = getComputedStyle(closeGlyph).backgroundColor;
      await page.getByRole("button", { name: "Close Source" }).hover();
      await vi.waitFor(() => {
        if (getComputedStyle(close).opacity !== "1") {
          throw new Error("Hovering the active icon tab never revealed its ✕.");
        }
        if (getComputedStyle(closeGlyph).backgroundColor === restingGlyphBackground) {
          throw new Error("The icon-only ✕ never gained its hover fill.");
        }
      });

      await page.getByRole("button", { name: "Close Source" }).click();
      expect(onCloseTab).toHaveBeenCalledWith("sourceControl");

      const diffTab = strip.querySelector("[data-right-panel-tab='diff']") as HTMLElement;
      diffTab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      expect(onCloseTab).toHaveBeenCalledWith("diff");
    } finally {
      await mounted.unmount();
    }
  });
});
