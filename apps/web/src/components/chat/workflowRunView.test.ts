import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationWorkflowRun, WorkflowAgent } from "@threadlines/contracts";

import {
  summarizeWorkflowRun,
  workflowAgentNowText,
  workflowLargeNote,
  workflowPhaseGroups,
  workflowPhaseMeta,
  workflowTimelineLayout,
} from "./workflowRunView";

const START_MS = Date.parse("2026-10-15T10:00:00.000Z");

function agent(overrides: Partial<WorkflowAgent> & Pick<WorkflowAgent, "index">): WorkflowAgent {
  return { label: `agent-${overrides.index}`, state: "queued", ...overrides };
}

function run(overrides: Partial<OrchestrationWorkflowRun> = {}): OrchestrationWorkflowRun {
  return {
    taskId: "task-1",
    runId: "wf_1",
    turnId: null,
    toolCallId: null,
    owner: { participantId: null },
    name: "review-changes",
    description: null,
    status: "running",
    statusReason: null,
    hiddenScript: false,
    startedAt: new Date(START_MS).toISOString(),
    endedAt: null,
    totalTokens: 0,
    totalToolCalls: 0,
    transcriptDir: null,
    scriptPath: null,
    summary: null,
    phases: [],
    agents: [],
    updatedAt: new Date(START_MS).toISOString(),
    ...overrides,
  };
}

describe("workflowPhaseGroups", () => {
  it("groups agents by phase in phase order and reads each phase's state", () => {
    const groups = workflowPhaseGroups(
      run({
        phases: [
          { index: 0, title: "Review" },
          { index: 1, title: "phase 2" },
          { index: 2, title: "Report" },
        ],
        agents: [
          agent({ index: 0, phaseIndex: 0, state: "done", startedAt: START_MS, durationMs: 4_000 }),
          agent({ index: 1, phaseIndex: 0, state: "failed", startedAt: START_MS }),
          agent({ index: 2, phaseIndex: 1, state: "running", startedAt: START_MS + 5_000 }),
          agent({ index: 3, phaseIndex: 1, state: "queued" }),
          // Tagged with a phase the run never reported.
          agent({ index: 4, phaseIndex: 9, state: "done" }),
        ],
      }),
      START_MS + 10_000,
    );

    expect(groups.map((group) => [group.title, group.state, group.agents.length])).toEqual([
      ["Review", "done", 2],
      ["Step 2", "live", 2],
      ["Report", "waiting", 0],
      ["Agents", "done", 1],
    ]);
    expect(workflowPhaseMeta(groups[1]!)).toBe("0 of 2 done");
    expect(workflowPhaseMeta(groups[2]!)).toBe("Not started");
  });

  it("stops calling a phase live once the run has ended", () => {
    const [group] = workflowPhaseGroups(
      run({
        status: "stopped",
        phases: [{ index: 0, title: "Review" }],
        agents: [agent({ index: 0, phaseIndex: 0, state: "running", startedAt: START_MS })],
      }),
      START_MS + 1_000,
    );
    // Nothing in it ran to the end: not a check mark.
    expect(group?.state).toBe("skipped");
  });
});

describe("summarizeWorkflowRun", () => {
  it("names the current phase and its position", () => {
    const summary = summarizeWorkflowRun(
      run({
        phases: [
          { index: 0, title: "Review" },
          { index: 1, title: "Verify" },
        ],
        agents: [
          agent({ index: 0, phaseIndex: 0, state: "done" }),
          agent({ index: 1, phaseIndex: 1, state: "running" }),
        ],
      }),
    );
    expect(summary).toMatchObject({
      title: "Review changes",
      total: 2,
      done: 1,
      phaseTitle: "Verify",
      phasePosition: { index: 2, of: 2 },
    });
  });
});

describe("workflowAgentNowText", () => {
  it("says why an agent started over when it has no step yet", () => {
    expect(
      workflowAgentNowText(
        agent({ index: 0, state: "running", attempt: 2, retryReason: "throttled" }),
      ),
    ).toBe("Rate limited, trying again");
    expect(workflowAgentNowText(agent({ index: 0, state: "running", attempt: 2 }))).toBe(
      "Stalled, started over",
    );
  });

  it("reads a structured result by its summary", () => {
    expect(
      workflowAgentNowText(
        agent({
          index: 0,
          state: "done",
          resultPreview: '{"verdict":"Bug is real","severity":"high"}',
        }),
      ),
    ).toBe("Bug is real");
  });
});

describe("workflowLargeNote", () => {
  const agents = Array.from({ length: 12 }, (_, index) => agent({ index, state: "queued" }));

  it("warns past the chosen size, and never under ultracode", () => {
    expect(workflowLargeNote({ run: run({ agents }), ultracode: false, sizeGuideline: null })).toBe(
      null,
    );
    expect(
      workflowLargeNote({ run: run({ agents }), ultracode: false, sizeGuideline: "medium" }),
    ).toBe("Large workflow: 12 agents");
    expect(
      workflowLargeNote({ run: run({ agents }), ultracode: true, sizeGuideline: "medium" }),
    ).toBe(null);
  });

  it("projects tokens from the agents finished so far", () => {
    const halfDone = agents.map((entry, index) =>
      index < 6 ? { ...entry, state: "done" as const } : entry,
    );
    expect(
      workflowLargeNote({
        run: run({ agents: halfDone, totalTokens: 900_000 }),
        ultracode: false,
        sizeGuideline: null,
      }),
    ).toBe("Large workflow: 12 agents, about 1.8m tokens at this pace");
  });
});

describe("workflowTimelineLayout", () => {
  it("draws started agents on one axis with their wait, and skips the rest", () => {
    const layout = workflowTimelineLayout(
      run({
        status: "completed",
        endedAt: new Date(START_MS + 100_000).toISOString(),
        agents: [
          agent({ index: 0, state: "done", startedAt: START_MS, durationMs: 50_000 }),
          agent({
            index: 1,
            state: "done",
            queuedAt: START_MS,
            startedAt: START_MS + 50_000,
            durationMs: 50_000,
          }),
          agent({ index: 2, state: "skipped" }),
        ],
      }),
      START_MS + 500_000,
    );

    const bars = layout.groups.flatMap((group) => group.bars);
    expect(bars.map((bar) => [bar.agent.index, bar.left, bar.width, bar.waitLeft])).toEqual([
      [0, 0, 50, null],
      [1, 50, 50, 0],
    ]);
    expect(layout.spanMs).toBe(100_000);
    expect(layout.ticks.map((tick) => tick.label)).toEqual(["0", "30s", "1m", "1m 30s"]);
  });
});
