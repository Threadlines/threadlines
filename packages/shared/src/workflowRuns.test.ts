import type { OrchestrationWorkflowRunPatch, TurnId, WorkflowAgent } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerForTypedMessage,
  applyWorkflowRunPatch,
  formatWorkflowProgress,
  retainWorkflowRunsAfterRevert,
  workflowAwaitedProgress,
} from "./workflowRuns.ts";

const agent = (index: number, state: WorkflowAgent["state"], phaseIndex = 1): WorkflowAgent => ({
  index,
  label: `agent-${index}`,
  phaseIndex,
  state,
});

const launch: OrchestrationWorkflowRunPatch = {
  taskId: "task-1",
  turnId: "turn-1" as TurnId,
  toolCallId: "toolu_1",
  owner: { participantId: null, providerInstanceId: "claudeAgent" as never },
  name: "grok-research",
  status: "running",
  startedAt: "2026-10-15T15:04:24.000Z",
};

describe("composerForTypedMessage", () => {
  it("lets Claude act on the keyword only when the user wrote it and did not say plain", () => {
    const send = (typedText: string, sentText: string, plain = false) =>
      composerForTypedMessage({ typedText, sentText, plain });
    expect(send("ultracode the refactor", "ultracode the refactor")).toBe("typed");
    expect(send("ultracode the refactor", "ultracode the refactor", true)).toBe("plain");
    // Only in a terminal's output that came along: not the user's word.
    expect(send("fix this", "fix this\n<terminal>ULTRACODE=1</terminal>")).toBe("plain");
    expect(send("fix this", "fix this")).toBe("typed");
  });
});

describe("formatWorkflowProgress", () => {
  // Every phase is known from the start; agents arrive phase by phase.
  const phases = [
    { index: 1, title: "Look" },
    { index: 2, title: "Linger" },
    { index: 3, title: "phase 3" },
  ];
  const line = (agents: ReadonlyArray<WorkflowAgent>) =>
    formatWorkflowProgress(
      workflowAwaitedProgress({ name: "look-and-linger", phases, agents: [...agents] }),
    );

  it("counts the phase it names, and names the phase the run is moving on to", () => {
    expect(line([])).toBe("Look · starting");
    expect(line([agent(1, "done"), agent(2, "running")])).toBe("Look · 1 of 2 agents");
    // Look ended and Linger has no agent yet: the whole run's 2 of 2 would
    // read as Linger's.
    expect(line([agent(1, "done"), agent(2, "done")])).toBe("Linger · starting");
    expect(line([agent(1, "done"), agent(2, "done"), agent(3, "running", 2)])).toBe(
      "Linger · 0 of 1 agent",
    );
    // A withheld title reads as a step, and a skipped agent has ended.
    expect(line([agent(1, "done"), agent(3, "skipped", 2), agent(4, "queued", 3)])).toBe(
      "Step 3 · 0 of 1 agent",
    );
  });

  it("counts the whole run when it has no phases", () => {
    const progress = workflowAwaitedProgress({
      name: null,
      phases: [],
      agents: [agent(1, "done"), agent(2, "failed"), agent(3, "running")],
    });
    expect(formatWorkflowProgress(progress)).toBe("2 of 3 agents");
  });

  it("shows only the phase when the progress carries no phase counts", () => {
    // Sent by a server from before phase counts.
    expect(formatWorkflowProgress({ phaseTitle: "Linger", doneAgents: 2, totalAgents: 3 })).toBe(
      "Linger",
    );
  });
});

describe("applyWorkflowRunPatch", () => {
  it("adds a run on its first update and folds later deltas by index", () => {
    let runs = applyWorkflowRunPatch([], launch, "2026-10-15T15:04:24.000Z");
    runs = applyWorkflowRunPatch(
      runs,
      {
        taskId: "task-1",
        phases: [
          { index: 1, title: "Research" },
          { index: 2, title: "Verify" },
        ],
        agents: [agent(1, "running"), agent(2, "running"), agent(3, "queued", 2)],
        totalTokens: 100,
      },
      "2026-10-15T15:05:00.000Z",
    );
    runs = applyWorkflowRunPatch(
      runs,
      { taskId: "task-1", agents: [agent(1, "done")], totalTokens: 250 },
      "2026-10-15T15:06:00.000Z",
    );

    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.name).toBe("grok-research");
    expect(run.turnId).toBe("turn-1");
    expect(run.totalTokens).toBe(250);
    expect(run.agents.map((entry) => [entry.index, entry.state])).toEqual([
      [1, "done"],
      [2, "running"],
      [3, "queued"],
    ]);
    expect(workflowAwaitedProgress(run)).toEqual({
      name: "grok-research",
      phaseTitle: "Verify",
      phaseDoneAgents: 0,
      phaseTotalAgents: 1,
      doneAgents: 1,
      totalAgents: 3,
    });
  });

  it("keeps an ended run ended when a late progress frame arrives", () => {
    let runs = applyWorkflowRunPatch([], launch, "t0");
    runs = applyWorkflowRunPatch(
      runs,
      { taskId: "task-1", status: "completed", endedAt: "t2", summary: "done" },
      "t2",
    );
    runs = applyWorkflowRunPatch(runs, { taskId: "task-1", status: "running" }, "t3");
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.endedAt).toBe("t2");
  });

  it("keeps a lost run's agents as reported, so a run that comes back is whole", () => {
    let runs = applyWorkflowRunPatch(
      [],
      { ...launch, agents: [agent(0, "running"), agent(1, "queued")] },
      "t0",
    );
    runs = applyWorkflowRunPatch(
      runs,
      { taskId: "task-1", status: "lost", statusReason: "runtime-gone", endedAt: "t1" },
      "t1",
    );
    expect(runs[0]?.agents.map((entry) => entry.state)).toEqual(["running", "queued"]);
    // Its runtime was there after all: a live report sends only what changed.
    runs = applyWorkflowRunPatch(
      runs,
      { taskId: "task-1", status: "running", startedAt: launch.startedAt!, totalTokens: 10 },
      "t2",
    );
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.agents.map((entry) => entry.state)).toEqual(["running", "queued"]);
    // A final end does settle them: nothing can run again.
    runs = applyWorkflowRunPatch(runs, { taskId: "task-1", status: "stopped" }, "t3");
    expect(runs[0]?.agents.map((entry) => entry.state)).toEqual(["skipped", "skipped"]);
  });

  it("lets the provider's own report replace a run we marked lost", () => {
    let runs = applyWorkflowRunPatch([], launch, "t0");
    runs = applyWorkflowRunPatch(
      runs,
      { taskId: "task-1", status: "lost", statusReason: "runtime-exited", endedAt: "t1" },
      "t1",
    );
    runs = applyWorkflowRunPatch(runs, { taskId: "task-1", status: "completed" }, "t2");
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.statusReason).toBeNull();
  });

  it("never moves a run to another owner, turn or place in the transcript once known", () => {
    let runs = applyWorkflowRunPatch([], launch, "t0", 10);
    runs = applyWorkflowRunPatch(
      runs,
      {
        taskId: "task-1",
        turnId: "turn-9" as TurnId,
        owner: { participantId: "p-2" as never, providerInstanceId: "claudeOther" as never },
      },
      "t1",
      42,
    );
    expect(runs[0]?.turnId).toBe("turn-1");
    expect(runs[0]?.owner.providerInstanceId).toBe("claudeAgent");
    expect(runs[0]?.eventSequence).toBe(10);
  });
});

describe("applyWorkflowRunPatch after a revert", () => {
  it("never brings back a run from a late report: only a first report, with a start, creates one", () => {
    expect(applyWorkflowRunPatch([], { taskId: "task-1", status: "completed" }, "t1")).toEqual([]);
    expect(applyWorkflowRunPatch([], launch, "t1").map((run) => run.taskId)).toEqual(["task-1"]);
  });
});

describe("retainWorkflowRunsAfterRevert", () => {
  it("drops only runs started by a removed turn", () => {
    const runs = [
      ...applyWorkflowRunPatch([], launch, "t0"),
      ...applyWorkflowRunPatch(
        [],
        { ...launch, taskId: "task-2", turnId: "turn-2" as TurnId },
        "t1",
      ),
      ...applyWorkflowRunPatch([], { ...launch, taskId: "task-3", turnId: null }, "t2"),
    ];
    const kept = retainWorkflowRunsAfterRevert(runs, new Set(["turn-2" as TurnId]));
    expect(kept.map((run) => run.taskId)).toEqual(["task-1", "task-3"]);
  });
});
