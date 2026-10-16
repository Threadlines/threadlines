import { describe, expect, it } from "vite-plus/test";

import {
  ClaudeWorkflowRunTracker,
  claudeWorkflowFinalOutput,
  claudeWorkflowLaunch,
  claudeWorkflowSnapshot,
  WORKFLOW_PROGRESS_INTERVAL_MS,
  type ClaudeWorkflowSnapshot,
} from "./ClaudeWorkflowRuns.ts";

const TASK_ID = "task-wf-1";
const T0 = 1_760_000_000_000;
const STARTED_AT = "2026-10-15T12:00:00.000Z";
const ENDED_AT = "2026-10-15T12:05:00.000Z";

const phase = (index: number, title: string) => ({ type: "workflow_phase", index, title });

/** A `workflow_agent` entry as Claude sends it: running, with its instructions. */
const agent = (index: number, state: string, extra: Record<string, unknown> = {}) => ({
  type: "workflow_agent",
  index,
  label: `scan:${index}`,
  phaseIndex: 0,
  agentId: `agent-${index}`,
  state,
  startedAt: 100,
  promptPreview: `Scan part ${index}`,
  ...extra,
});

const frame = (...entries: ReadonlyArray<unknown>): ClaudeWorkflowSnapshot => {
  const snapshot = claudeWorkflowSnapshot(entries);
  if (!snapshot) throw new Error("not a snapshot");
  return snapshot;
};

const progress = (
  tracker: ClaudeWorkflowRunTracker,
  nowMs: number,
  snapshot: ClaudeWorkflowSnapshot | undefined,
  totals: { readonly totalTokens?: number; readonly totalToolCalls?: number } = {},
) =>
  tracker.progress({
    taskId: TASK_ID,
    snapshot,
    totalTokens: totals.totalTokens,
    totalToolCalls: totals.totalToolCalls,
    nowMs,
  });

describe("claudeWorkflowSnapshot", () => {
  it("reads phases and agents, maps Claude's states, and skips entries it cannot read", () => {
    const snapshot = claudeWorkflowSnapshot([
      phase(0, "Research"),
      phase(1, "phase 2"),
      // Scheduled but not started: `start` without `startedAt`.
      { type: "workflow_agent", index: 0, label: "scan:repo", state: "start", queuedAt: 10 },
      {
        type: "workflow_agent",
        index: 1,
        label: "scan:docs",
        phaseIndex: 0,
        state: "start",
        queuedAt: 10,
        startedAt: 20,
        attempt: 2,
        lastAttemptReason: "stalled",
        lastToolSummary: "Read README.md",
        promptPreview: "Read the docs",
      },
      { type: "workflow_agent", index: 2, label: "verify", state: "progress" },
      { type: "workflow_agent", index: 3, label: "write", state: "done", resultPreview: "ok" },
      { type: "workflow_agent", index: 4, label: "skip", state: "error", skipped: true },
      { type: "workflow_agent", index: 5, label: "boom", state: "error", error: "crashed" },
      // Unreadable: blank label, negative index, unknown state, phase without a title.
      { type: "workflow_agent", index: 6, label: "   ", state: "done" },
      { type: "workflow_agent", index: -1, label: "negative", state: "done" },
      { type: "workflow_agent", index: 7, label: "paused", state: "paused" },
      { type: "workflow_phase", index: 3 },
      { type: "workflow_note", index: 8, label: "other" },
      null,
      "workflow_agent",
      [1, 2],
    ]);

    expect(snapshot?.phases).toEqual([
      { index: 0, title: "Research" },
      { index: 1, title: "phase 2" },
    ]);
    expect(snapshot?.agents.map((entry) => [entry.index, entry.state])).toEqual([
      [0, "queued"],
      [1, "running"],
      [2, "running"],
      [3, "done"],
      [4, "skipped"],
      [5, "failed"],
    ]);
    expect(snapshot?.agents[1]).toEqual({
      index: 1,
      label: "scan:docs",
      phaseIndex: 0,
      state: "running",
      attempt: 2,
      retryReason: "stalled",
      queuedAt: 10,
      startedAt: 20,
      lastStep: "Read README.md",
      instructionsPreview: "Read the docs",
    });
    // A frame without the field keeps what came before; it is not an empty run.
    expect(claudeWorkflowSnapshot(undefined)).toBeUndefined();
    expect(claudeWorkflowSnapshot({ agents: [] })).toBeUndefined();
  });

  it("reads a launch only from a Workflow result whose run really started", () => {
    expect(
      claudeWorkflowLaunch({
        status: "async_launched",
        taskType: "local_workflow",
        taskId: "task-wf-1",
        workflowName: "provider-research",
        runId: "wf_abc",
        summary: "Research the provider",
        transcriptDir: "/claude/projects/p/s/subagents/workflows/wf_abc",
        scriptPath: "/claude/projects/p/s/workflows/scripts/provider-research-wf_abc.js",
      }),
    ).toEqual({
      taskId: "task-wf-1",
      runId: "wf_abc",
      name: "provider-research",
      description: "Research the provider",
      transcriptDir: "/claude/projects/p/s/subagents/workflows/wf_abc",
      scriptPath: "/claude/projects/p/s/workflows/scripts/provider-research-wf_abc.js",
    });
    // A script that failed to compile is reported as launched with an error;
    // no task runs, so no run may be opened for it.
    expect(
      claudeWorkflowLaunch({
        status: "async_launched",
        taskType: "local_workflow",
        taskId: "task-wf-2",
        workflowName: "broken",
        runId: "wf_def",
        error: "SyntaxError: Unexpected token",
      }),
    ).toBeUndefined();
    expect(
      claudeWorkflowLaunch({ status: "async_launched", taskType: "local_agent", taskId: "t" }),
    ).toBeUndefined();
    expect(
      claudeWorkflowLaunch({ status: "completed", taskType: "local_workflow", taskId: "t" }),
    ).toBeUndefined();
  });

  it("reads a finished run's saved output", () => {
    expect(
      claudeWorkflowFinalOutput(
        JSON.stringify({
          workflowProgress: [phase(0, "Research"), agent(0, "done")],
          totalTokens: 900,
          totalToolCalls: 12,
        }),
      ),
    ).toEqual({
      snapshot: frame(phase(0, "Research"), agent(0, "done")),
      totalTokens: 900,
      totalToolCalls: 12,
    });
    expect(claudeWorkflowFinalOutput("{not json")).toBeUndefined();
    expect(claudeWorkflowFinalOutput("[]")).toBeUndefined();
  });
});

describe("ClaudeWorkflowRunTracker", () => {
  it("reports the start once, then the first snapshot whole", () => {
    const tracker = new ClaudeWorkflowRunTracker();
    expect(
      tracker.started({
        taskId: TASK_ID,
        toolCallId: "toolu_wf",
        name: "provider-research",
        startedAt: STARTED_AT,
      }),
    ).toEqual({
      taskId: TASK_ID,
      status: "running",
      startedAt: STARTED_AT,
      toolCallId: "toolu_wf",
      name: "provider-research",
    });
    // A resumed task restates its start; the run already has one.
    expect(tracker.started({ taskId: TASK_ID, startedAt: ENDED_AT })).toBeUndefined();

    const snapshot = frame(phase(0, "Research"), agent(0, "start"), agent(1, "start"));
    expect(progress(tracker, T0, snapshot, { totalTokens: 100, totalToolCalls: 2 })).toEqual({
      taskId: TASK_ID,
      phases: snapshot.phases,
      agents: snapshot.agents,
      totalTokens: 100,
      totalToolCalls: 2,
      hiddenScript: false,
    });
    // The same frame again changes nothing.
    expect(progress(tracker, T0 + 10_000, snapshot)).toBeUndefined();
  });

  it("holds progress-only changes for the interval but sends a state change at once", () => {
    const tracker = new ClaudeWorkflowRunTracker();
    progress(tracker, T0, frame(phase(0, "Research"), agent(0, "start"), agent(1, "start")));

    // Agent 0 only used tokens: held.
    expect(progress(tracker, T0 + 1_000, frame(agent(0, "progress", { tokens: 50 })))).toEqual(
      undefined,
    );
    // Agent 1 finished: goes out now, with agent 0's held progress folded in.
    const stateChange = progress(tracker, T0 + 2_000, frame(agent(1, "done")));
    expect(stateChange?.agents?.map((entry) => [entry.index, entry.state, entry.tokens])).toEqual([
      [0, "running", 50],
      [1, "done", undefined],
    ]);

    // More tokens inside the interval after that send: held again.
    expect(progress(tracker, T0 + 3_000, frame(agent(0, "progress", { tokens: 80 })))).toEqual(
      undefined,
    );
    // The next frame past the interval carries it, even without a snapshot of its own.
    expect(progress(tracker, T0 + 2_000 + WORKFLOW_PROGRESS_INTERVAL_MS, undefined)).toEqual({
      taskId: TASK_ID,
      agents: frame(agent(0, "progress", { tokens: 80 })).agents,
    });
  });

  it("sends what was held with the end, and ignores frames after it", () => {
    const tracker = new ClaudeWorkflowRunTracker();
    progress(tracker, T0, frame(phase(0, "Research"), agent(0, "start"), agent(1, "start")));
    expect(progress(tracker, T0 + 1_000, frame(agent(0, "progress", { tokens: 50 })))).toEqual(
      undefined,
    );

    expect(
      tracker.ended({
        taskId: TASK_ID,
        status: "completed",
        endedAt: ENDED_AT,
        summary: "Found three gaps",
        totalTokens: 500,
        nowMs: T0 + 1_500,
      }),
    ).toEqual({
      taskId: TASK_ID,
      agents: frame(agent(0, "progress", { tokens: 50 })).agents,
      totalTokens: 500,
      status: "completed",
      endedAt: ENDED_AT,
      summary: "Found three gaps",
    });
    expect(tracker.isEnded(TASK_ID)).toBe(true);
    expect(tracker.liveTaskIds()).toEqual([]);

    // A late frame neither reopens the run nor reports anything.
    expect(progress(tracker, T0 + 60_000, frame(agent(0, "done"), agent(1, "done")))).toEqual(
      undefined,
    );
    expect(tracker.isEnded(TASK_ID)).toBe(true);

    // The saved output still lands: it is where every agent got to.
    const final = tracker.finalOutput(
      TASK_ID,
      { snapshot: frame(agent(0, "done"), agent(1, "error", { error: "timed out" })) },
      T0 + 61_000,
    );
    expect(final?.agents?.map((entry) => entry.state)).toEqual(["done", "failed"]);
  });

  it("counts the run for the thread list from everything seen so far", () => {
    const tracker = new ClaudeWorkflowRunTracker();
    tracker.started({ taskId: TASK_ID, name: "provider-research", startedAt: STARTED_AT });
    progress(
      tracker,
      T0,
      frame(
        phase(0, "Research"),
        phase(1, "Verify"),
        agent(0, "done"),
        agent(1, "error", { error: "crashed" }),
        agent(2, "error", { skipped: true, phaseIndex: 1 }),
        agent(3, "start", { phaseIndex: 1 }),
      ),
    );
    const expected = {
      name: "provider-research",
      phaseTitle: "Verify",
      doneAgents: 3,
      totalAgents: 4,
    };
    expect(tracker.awaitedProgress(TASK_ID)).toEqual(expected);
    expect(tracker.takeAwaitedChange(TASK_ID)).toBe(true);
    expect(tracker.takeAwaitedChange(TASK_ID)).toBe(false);

    // Tokens move nothing the thread list shows; a frame without a snapshot
    // keeps every agent.
    progress(tracker, T0 + 100, frame(agent(3, "progress", { phaseIndex: 1, tokens: 99 })));
    progress(tracker, T0 + 200, undefined, { totalTokens: 1_000 });
    expect(tracker.awaitedProgress(TASK_ID)).toEqual(expected);
    expect(tracker.takeAwaitedChange(TASK_ID)).toBe(false);

    progress(tracker, T0 + 300, frame(agent(3, "done", { phaseIndex: 1 })));
    expect(tracker.takeAwaitedChange(TASK_ID)).toBe(true);
    expect(tracker.awaitedProgress(TASK_ID)?.doneAgents).toBe(4);
    expect(tracker.awaitedProgress("task-unknown")).toBeUndefined();
  });

  it("marks a run whose script Claude withholds, and corrects a guess that was wrong", () => {
    const hidden = new ClaudeWorkflowRunTracker();
    const withheld = { promptPreview: undefined };
    expect(
      progress(
        hidden,
        T0,
        frame(phase(0, "phase 1"), phase(1, "phase 2"), agent(0, "start", withheld)),
      )?.hiddenScript,
    ).toBe(true);

    const open = new ClaudeWorkflowRunTracker();
    expect(progress(open, T0, frame(phase(0, "Research"), agent(0, "start")))?.hiddenScript).toBe(
      false,
    );

    // A script whose own first phase is named "phase 1" looks hidden until
    // an agent shows its instructions; the correction must reach the run.
    const named = new ClaudeWorkflowRunTracker();
    expect(progress(named, T0, frame(phase(0, "phase 1")))?.hiddenScript).toBe(true);
    expect(progress(named, T0 + 100, frame(agent(0, "start")))?.hiddenScript).toBe(false);
  });
});
