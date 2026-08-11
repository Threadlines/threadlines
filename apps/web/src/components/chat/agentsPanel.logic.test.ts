import { describe, expect, it } from "vite-plus/test";

import { TurnId } from "@threadlines/contracts";

import type { SubagentProgressItem } from "../../session-logic";
import type { ThreadBackgroundRunItem } from "./threadActivity";
import {
  buildAgentBranches,
  buildAgentsPanelView,
  findAgentsPanelSubagent,
  formatAgentsHeaderMeta,
  formatLiveAgentStatusLine,
  selectSubagentsForTurns,
  summarizeLiveAgents,
  summarizeTurnAgents,
} from "./agentsPanel.logic";

const TURN_ONE = TurnId.make("turn-1");
const TURN_TWO = TurnId.make("turn-2");

function buildSubagent(overrides: Partial<SubagentProgressItem> = {}): SubagentProgressItem {
  return {
    id: "agent-1",
    agentThreadId: "agent-thread-1",
    transcriptAgentId: null,
    turnId: TURN_ONE,
    label: "Explore subagent",
    role: null,
    objective: "Sweep the router for panel wiring",
    status: "running",
    statusLabel: "Running",
    model: null,
    reasoningEffort: null,
    liveBody: null,
    telemetry: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  };
}

function buildRun(overrides: Partial<ThreadBackgroundRunItem> = {}): ThreadBackgroundRunItem {
  return {
    id: "run-1",
    source: "detected",
    label: "Dev server",
    detail: "node - vite dev",
    cwd: "C:\\repo",
    statusLabel: "Running",
    urls: [],
    terminalId: null,
    pid: 4321,
    port: 5173,
    elapsed: "2m",
    canStop: true,
    ...overrides,
  };
}

describe("buildAgentBranches", () => {
  it("puts the branches that need attention first and keeps each group oldest-first", () => {
    const branches = buildAgentBranches({
      subagents: [
        buildSubagent({
          id: "done",
          status: "completed",
          statusLabel: "Done",
          createdAt: "2026-08-11T10:00:00.000Z",
        }),
        buildSubagent({
          id: "running-late",
          status: "running",
          createdAt: "2026-08-11T10:05:00.000Z",
        }),
        buildSubagent({
          id: "failed",
          status: "failed",
          statusLabel: "Failed",
          createdAt: "2026-08-11T10:01:00.000Z",
        }),
        buildSubagent({
          id: "running-early",
          status: "running",
          createdAt: "2026-08-11T10:02:00.000Z",
        }),
        buildSubagent({
          id: "waiting",
          status: "waiting",
          statusLabel: "Needs approval",
          createdAt: "2026-08-11T10:03:00.000Z",
        }),
      ],
      backgroundRuns: [],
    });

    expect(branches.map((branch) => branch.key)).toEqual([
      "subagent:running-early",
      "subagent:running-late",
      "subagent:waiting",
      "subagent:failed",
      "subagent:done",
    ]);
  });

  it("treats a started agent as running and an interrupted one as failed", () => {
    const branches = buildAgentBranches({
      subagents: [
        buildSubagent({ id: "starting", status: "starting" }),
        buildSubagent({ id: "interrupted", status: "interrupted" }),
      ],
      backgroundRuns: [],
    });

    expect(branches.map((branch) => `${branch.key}:${branch.status}`)).toEqual([
      "subagent:starting:running",
      "subagent:interrupted:failed",
    ]);
  });

  it("shows the live step for a running agent and drops it once the agent finishes", () => {
    const [running, finished] = buildAgentBranches({
      subagents: [
        buildSubagent({
          id: "running",
          telemetry: {
            step: "Running the test suite",
            lastToolName: "Bash",
            totalTokens: 1_200,
            toolUses: 4,
            durationMs: null,
          },
        }),
        buildSubagent({
          id: "finished",
          status: "completed",
          statusLabel: "Done",
          liveBody: "Wrapped up",
          telemetry: {
            step: "Summarizing",
            lastToolName: null,
            totalTokens: 900,
            toolUses: 2,
            durationMs: 42_000,
          },
        }),
      ],
      backgroundRuns: [],
    });

    expect(running?.output).toBe("Running the test suite");
    expect(running?.task).toBe("Sweep the router for panel wiring");
    expect(finished?.output).toBeNull();
  });

  it("falls back to the agent's streamed prose when the provider reports no step", () => {
    const [branch] = buildAgentBranches({
      subagents: [buildSubagent({ liveBody: "  Reading   the   route  \n  files " })],
      backgroundRuns: [],
    });

    expect(branch?.output).toBe("Reading the route files");
  });

  it("marks a run with its provenance and the terminal it toggles", () => {
    const branches = buildAgentBranches({
      subagents: [],
      backgroundRuns: [
        buildRun({ id: "detected-run" }),
        buildRun({
          id: "terminal-run",
          source: "terminal",
          terminalId: "terminal-a",
          terminalVisible: true,
          label: "Terminal 1",
        }),
      ],
      providerLabel: "codex",
    });

    expect(branches.map((branch) => branch.tag)).toEqual(["codex · detected", "terminal"]);
    const terminalBranch = branches.find((branch) => branch.key === "run:terminal-run");
    expect(terminalBranch?.kind === "run" && terminalBranch.terminalId).toBe("terminal-a");
    expect(terminalBranch?.kind === "run" && terminalBranch.terminalVisible).toBe(true);
  });

  it("names a run's served URL as its latest output", () => {
    const [branch] = buildAgentBranches({
      subagents: [],
      backgroundRuns: [buildRun({ urls: ["http://localhost:5173"] })],
    });

    expect(branch?.output).toBe("http://localhost:5173");
  });

  it("keeps subagents and runs in one ordering, agents ahead of untimed runs", () => {
    const branches = buildAgentBranches({
      subagents: [buildSubagent({ id: "agent", status: "running" })],
      backgroundRuns: [buildRun({ id: "run" })],
    });

    expect(branches.map((branch) => branch.key)).toEqual(["subagent:agent", "run:run"]);
  });
});

describe("buildAgentsPanelView", () => {
  const historyOf = (item: SubagentProgressItem, resultBody: string | null = null) => ({
    item,
    resultBody,
  });

  it("keeps finished agents listed after the live items empty", () => {
    const view = buildAgentsPanelView({
      subagents: [],
      backgroundRuns: [],
      history: [
        historyOf(
          buildSubagent({
            id: "done",
            agentThreadId: "agent-done",
            status: "completed",
            statusLabel: "Completed",
            model: "claude-opus-5",
            reasoningEffort: "high",
            telemetry: {
              step: null,
              lastToolName: null,
              totalTokens: 24_000,
              toolUses: null,
              durationMs: null,
            },
            updatedAt: "2026-08-11T10:00:00.000Z",
          }),
          "- The route never mounted the panel.\nMore detail below.",
        ),
      ],
      nowMs: Date.parse("2026-08-11T10:12:00.000Z"),
    });

    expect(view.hasAny).toBe(true);
    expect(view.current).toEqual([]);
    expect(view.earlier.map((branch) => branch.status)).toEqual(["completed"]);
    expect(view.earlier[0]?.task).toBe("The route never mounted the panel.");
    expect(view.earlier[0]?.meta).toEqual(["claude-opus-5", "high", "24k tokens", "12m ago"]);
    // Nothing is streaming, so a history row has no live output line.
    expect(view.earlier[0]?.output).toBeNull();
  });

  it("orders the history newest first", () => {
    const view = buildAgentsPanelView({
      subagents: [],
      backgroundRuns: [],
      history: [
        historyOf(
          buildSubagent({
            id: "older",
            agentThreadId: "agent-older",
            status: "completed",
            updatedAt: "2026-08-11T08:00:00.000Z",
          }),
        ),
        historyOf(
          buildSubagent({
            id: "newer",
            agentThreadId: "agent-newer",
            status: "completed",
            updatedAt: "2026-08-11T09:30:00.000Z",
          }),
        ),
      ],
    });

    expect(view.earlier.map((branch) => branch.item.id)).toEqual(["newer", "older"]);
  });

  it("lets the live record win over its own history counterpart", () => {
    const view = buildAgentsPanelView({
      subagents: [buildSubagent({ id: "agent", agentThreadId: "agent-thread", status: "running" })],
      backgroundRuns: [],
      history: [
        historyOf(
          buildSubagent({ id: "agent", agentThreadId: "agent-thread", status: "completed" }),
        ),
      ],
    });

    expect(view.current.map((branch) => branch.status)).toEqual(["running"]);
    expect(view.earlier).toEqual([]);
  });

  it("renders a failed history record as a failure rather than a quiet completion", () => {
    const view = buildAgentsPanelView({
      subagents: [],
      backgroundRuns: [],
      history: [
        historyOf(
          buildSubagent({
            id: "boom",
            agentThreadId: "agent-boom",
            status: "failed",
            statusLabel: "Failed",
          }),
        ),
      ],
    });

    expect(view.earlier[0]?.status).toBe("failed");
  });

  it("reports nothing at all only for a thread that has never run an agent", () => {
    expect(buildAgentsPanelView({ subagents: [], backgroundRuns: [] }).hasAny).toBe(false);
  });
});

describe("findAgentsPanelSubagent", () => {
  it("resolves an agent that exists only in the thread's history", () => {
    const view = buildAgentsPanelView({
      subagents: [],
      backgroundRuns: [],
      history: [
        {
          item: buildSubagent({ id: "old", agentThreadId: "agent-old", status: "completed" }),
          resultBody: null,
        },
      ],
    });

    expect(findAgentsPanelSubagent(view, "agent-old")?.id).toBe("old");
    expect(findAgentsPanelSubagent(view, "agent-missing")).toBeNull();
    expect(findAgentsPanelSubagent(view, null)).toBeNull();
  });
});

describe("formatLiveAgentStatusLine", () => {
  it("names the freshest live signal and nothing else", () => {
    const line = formatLiveAgentStatusLine([
      buildSubagent({
        id: "stale",
        status: "running",
        telemetry: {
          step: "Reading the router",
          lastToolName: null,
          totalTokens: null,
          toolUses: null,
          durationMs: null,
        },
        updatedAt: "2026-08-11T10:00:00.000Z",
      }),
      buildSubagent({
        id: "fresh",
        nickname: "Agent panel tests",
        status: "running",
        telemetry: {
          step: "reading AgentsPanel.browser.tsx",
          lastToolName: null,
          totalTokens: null,
          toolUses: null,
          durationMs: null,
        },
        updatedAt: "2026-08-11T10:00:30.000Z",
      }),
    ]);

    expect(line).toEqual({
      agentThreadId: "agent-thread-1",
      name: "Agent panel tests",
      step: "reading AgentsPanel.browser.tsx",
    });
  });

  it("falls back to the agent's own newest prose when there is no reported step", () => {
    const line = formatLiveAgentStatusLine([
      buildSubagent({ status: "running", liveBody: "  Walking the\n  route files  " }),
    ]);

    expect(line?.step).toBe("Walking the");
  });

  it("says nothing once no agent is live", () => {
    expect(
      formatLiveAgentStatusLine([
        buildSubagent({
          status: "completed",
          telemetry: {
            step: "Reading the router",
            lastToolName: null,
            totalTokens: null,
            toolUses: null,
            durationMs: null,
          },
        }),
      ]),
    ).toBeNull();
    expect(formatLiveAgentStatusLine([buildSubagent({ status: "running" })])).toBeNull();
  });
});

describe("summarizeLiveAgents", () => {
  it("counts live subagents and runs together and flags one waiting on the user", () => {
    expect(
      summarizeLiveAgents({
        subagents: [
          buildSubagent({ id: "a", status: "running" }),
          buildSubagent({ id: "b", status: "waiting" }),
          buildSubagent({ id: "c", status: "completed" }),
        ],
        backgroundRuns: [buildRun({ id: "run" })],
      }),
    ).toEqual({ count: 3, waitingCount: 1 });
  });

  it("says nothing when the thread is idle", () => {
    expect(
      summarizeLiveAgents({
        subagents: [buildSubagent({ status: "completed" })],
        backgroundRuns: [],
      }),
    ).toBeNull();
  });
});

describe("summarizeTurnAgents", () => {
  it("says nothing when the turn spawned no agents", () => {
    expect(summarizeTurnAgents([])).toBeNull();
  });

  it("counts the finished and the waiting alongside the total", () => {
    const summary = summarizeTurnAgents([
      buildSubagent({ id: "a", status: "running" }),
      buildSubagent({ id: "b", status: "running" }),
      buildSubagent({ id: "c", status: "completed" }),
      buildSubagent({ id: "d", status: "waiting" }),
    ]);

    expect(summary?.text).toBe("4 subagents · 1 done · 1 needs you");
    expect(summary?.total).toBe(4);
    expect(summary?.segments.map((segment) => segment.status)).toEqual([
      "running",
      "running",
      "waiting",
      "completed",
    ]);
  });

  it("keeps a lone agent singular and leaves empty counts out", () => {
    const summary = summarizeTurnAgents([buildSubagent({ id: "only", status: "running" })]);

    expect(summary?.text).toBe("1 subagent");
  });

  it("reports failures", () => {
    const summary = summarizeTurnAgents([
      buildSubagent({ id: "a", status: "failed" }),
      buildSubagent({ id: "b", status: "completed" }),
    ]);

    expect(summary?.text).toBe("2 subagents · 1 done · 1 failed");
  });
});

describe("selectSubagentsForTurns", () => {
  it("keeps only the agents the given turns spawned", () => {
    const selected = selectSubagentsForTurns(
      [
        buildSubagent({ id: "mine", turnId: TURN_ONE }),
        buildSubagent({ id: "other", turnId: TURN_TWO }),
        buildSubagent({ id: "unturned", turnId: null }),
      ],
      new Set([TURN_ONE]),
    );

    expect(selected.map((item) => item.id)).toEqual(["mine"]);
  });

  it("selects nothing when the row carries no turn", () => {
    expect(selectSubagentsForTurns([buildSubagent()], new Set())).toEqual([]);
  });
});

describe("formatAgentsHeaderMeta", () => {
  const nowMs = Date.parse("2026-08-11T10:05:00.000Z");

  it("reports the longest live run and what the agents have spent together", () => {
    const meta = formatAgentsHeaderMeta({
      subagents: [
        buildSubagent({
          id: "recent",
          createdAt: "2026-08-11T10:04:00.000Z",
          telemetry: {
            step: null,
            lastToolName: null,
            totalTokens: 2_000,
            toolUses: null,
            durationMs: null,
          },
        }),
        buildSubagent({
          id: "oldest",
          createdAt: "2026-08-11T10:01:30.000Z",
          telemetry: {
            step: null,
            lastToolName: null,
            totalTokens: 4_500,
            toolUses: null,
            durationMs: null,
          },
        }),
      ],
      nowMs,
    });

    expect(meta).toContain("3m 30s");
    expect(meta).toContain("tokens");
  });

  it("stays quiet when nothing is live and nothing was spent", () => {
    expect(
      formatAgentsHeaderMeta({
        subagents: [buildSubagent({ status: "completed", statusLabel: "Done" })],
        nowMs,
      }),
    ).toBeNull();
  });
});
