/**
 * Folding workflow run updates into the runs a thread keeps, and the counts
 * every surface reads from a run.
 *
 * Updates carry only what changed (see `OrchestrationWorkflowRunPatch`), so
 * the server's in-memory projector, its SQL projection and the web store all
 * fold them here: three copies of the merge would drift.
 */
import type {
  AwaitedWorkflowProgress,
  MessageComposer,
  OrchestrationWorkflowRun,
  OrchestrationWorkflowRunPatch,
  TurnId,
  WorkflowAgent,
  WorkflowPhase,
  WorkflowRunStatus,
} from "@threadlines/contracts";

/** Phase titles Claude substitutes when a workflow hides its script. */
const HIDDEN_PHASE_TITLE = /^phase (\d{1,4})$/u;

/** The step number of a phase whose title the provider withheld ("phase 2"),
 *  or null for a phase with a real title. */
export function hiddenWorkflowPhaseNumber(title: string): string | null {
  return HIDDEN_PHASE_TITLE.exec(title)?.[1] ?? null;
}

/** A phase's title as people read it: a withheld one reads "Step N". */
export function workflowPhaseDisplayTitle(title: string): string {
  const hidden = hiddenWorkflowPhaseNumber(title);
  return hidden !== null ? `Step ${hidden}` : title;
}

/** Claude's word for "run this message as a workflow". Claude acts on it
 *  only in words a person typed (see ProviderTypedInput). */
const WORKFLOW_KEYWORD = /\bultracode\b/iu;

/**
 * How words a user sends from a composer go out (MessageComposer): typed, so
 * Claude may act on "ultracode", unless the user chose plain text or the word
 * is only in what came along with their words (a terminal's output, a quoted
 * transcript) and never in what they wrote.
 */
export function composerForTypedMessage(input: {
  /** What the user wrote. */
  readonly typedText: string;
  /** What goes out: their words plus anything attached to them. */
  readonly sentText: string;
  readonly plain: boolean;
}): MessageComposer {
  if (containsWorkflowKeyword(input.typedText)) return input.plain ? "plain" : "typed";
  return containsWorkflowKeyword(input.sentText) ? "plain" : "typed";
}

export function containsWorkflowKeyword(text: string): boolean {
  return WORKFLOW_KEYWORD.test(text);
}

/** Claude caps a run at 1,000 agents; anything past this is a bad report. */
const MAX_AGENTS_PER_RUN = 2_000;
const MAX_PHASES_PER_RUN = 200;

export function isWorkflowRunTerminal(status: WorkflowRunStatus): boolean {
  return status !== "running";
}

/**
 * The status a run moves to. An ended run stays ended: a progress frame that
 * arrives after the end must not bring it back. `lost` is the exception, since
 * it is our guess that the runtime went away; anything the provider itself
 * reports afterwards is the truth.
 */
function nextStatus(current: WorkflowRunStatus, reported: WorkflowRunStatus): WorkflowRunStatus {
  return current === "running" || current === "lost" ? reported : current;
}

function upsertByIndex<T extends { readonly index: number }>(
  current: ReadonlyArray<T>,
  changed: ReadonlyArray<T> | undefined,
  cap: number,
): ReadonlyArray<T> {
  if (changed === undefined || changed.length === 0) return current;
  const byIndex = new Map<number, T>();
  for (const entry of current) byIndex.set(entry.index, entry);
  for (const entry of changed) byIndex.set(entry.index, entry);
  const merged = [...byIndex.values()].toSorted((left, right) => left.index - right.index);
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

function newRun(
  patch: OrchestrationWorkflowRunPatch,
  updatedAt: string,
  eventSequence: number | undefined,
): OrchestrationWorkflowRun {
  return settleCutOffAgents({
    taskId: patch.taskId,
    runId: patch.runId ?? null,
    turnId: patch.turnId ?? null,
    toolCallId: patch.toolCallId ?? null,
    owner: patch.owner ?? { participantId: null },
    name: patch.name ?? null,
    description: patch.description ?? null,
    status: patch.status ?? "running",
    statusReason: patch.statusReason ?? null,
    hiddenScript: patch.hiddenScript ?? false,
    startedAt: patch.startedAt ?? updatedAt,
    endedAt: patch.endedAt ?? null,
    totalTokens: patch.totalTokens ?? 0,
    totalToolCalls: patch.totalToolCalls ?? 0,
    transcriptDir: patch.transcriptDir ?? null,
    scriptPath: patch.scriptPath ?? null,
    summary: patch.summary ?? null,
    phases: upsertByIndex<WorkflowPhase>([], patch.phases, MAX_PHASES_PER_RUN),
    agents: upsertByIndex<WorkflowAgent>([], patch.agents, MAX_AGENTS_PER_RUN),
    updatedAt,
    ...(eventSequence !== undefined ? { eventSequence } : {}),
  });
}

/**
 * Agents still running or waiting when their run ended ran no further: they
 * read as skipped, ending with the run, so no view keeps them live. A later
 * report of where they really got to replaces them.
 */
function settleCutOffAgents(run: OrchestrationWorkflowRun): OrchestrationWorkflowRun {
  const cutOff = (agent: WorkflowAgent) => agent.state === "running" || agent.state === "queued";
  if (!isWorkflowRunTerminal(run.status) || !run.agents.some(cutOff)) return run;
  const endedMs = run.endedAt === null ? Number.NaN : Date.parse(run.endedAt);
  const note = run.status === "stopped" ? "Stopped with the workflow" : "Ended with the workflow";
  return {
    ...run,
    agents: run.agents.map((agent) => {
      if (!cutOff(agent)) return agent;
      const durationMs =
        agent.durationMs ??
        (agent.startedAt !== undefined && Number.isFinite(endedMs)
          ? Math.max(0, endedMs - agent.startedAt)
          : undefined);
      return {
        ...agent,
        state: "skipped" as const,
        error: agent.error ?? note,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    }),
  };
}

/** One run with an update folded in. */
export function mergeWorkflowRunPatch(
  run: OrchestrationWorkflowRun,
  patch: OrchestrationWorkflowRunPatch,
  updatedAt: string,
  eventSequence?: number,
): OrchestrationWorkflowRun {
  const status = patch.status === undefined ? run.status : nextStatus(run.status, patch.status);
  const statusChanged = status !== run.status;
  return settleCutOffAgents({
    ...run,
    runId: patch.runId ?? run.runId,
    // Where a run came from is settled by the update that first names it.
    turnId: run.turnId ?? patch.turnId ?? null,
    toolCallId: run.toolCallId ?? patch.toolCallId ?? null,
    // A run first heard of without its session (a revert rebuild) takes the
    // owner the next update names; after that the owner never changes.
    owner:
      run.owner.providerInstanceId === undefined && patch.owner !== undefined
        ? patch.owner
        : run.owner,
    name: patch.name ?? run.name,
    description: patch.description ?? run.description,
    status,
    statusReason: statusChanged
      ? (patch.statusReason ?? null)
      : (patch.statusReason ?? run.statusReason),
    hiddenScript: patch.hiddenScript ?? run.hiddenScript,
    startedAt: run.startedAt,
    endedAt: patch.endedAt ?? (statusChanged && status === "running" ? null : run.endedAt),
    totalTokens: patch.totalTokens ?? run.totalTokens,
    totalToolCalls: patch.totalToolCalls ?? run.totalToolCalls,
    transcriptDir: patch.transcriptDir ?? run.transcriptDir,
    scriptPath: patch.scriptPath ?? run.scriptPath,
    summary: patch.summary ?? run.summary,
    phases: upsertByIndex(run.phases, patch.phases, MAX_PHASES_PER_RUN),
    agents: upsertByIndex(run.agents, patch.agents, MAX_AGENTS_PER_RUN),
    updatedAt,
    // First wins, like every transcript item's position.
    ...((run.eventSequence ?? eventSequence) !== undefined
      ? { eventSequence: run.eventSequence ?? eventSequence }
      : {}),
  });
}

/**
 * The thread's runs with an update folded in: the run it names is updated, or
 * added if this is the first word of it. Runs stay in the order they started.
 */
export function applyWorkflowRunPatch(
  runs: ReadonlyArray<OrchestrationWorkflowRun>,
  patch: OrchestrationWorkflowRunPatch,
  updatedAt: string,
  eventSequence?: number,
): ReadonlyArray<OrchestrationWorkflowRun> {
  const index = runs.findIndex((run) => run.taskId === patch.taskId);
  if (index === -1) {
    // Only a report with a start creates a run. Drivers put one on every
    // report while the run lives and none after it ended, so a late report
    // for a run a revert removed (revert waits for runs to end) can not
    // bring it back.
    if (patch.startedAt === undefined) return runs;
    return [...runs, newRun(patch, updatedAt, eventSequence)].toSorted(compareWorkflowRuns);
  }
  const next = [...runs];
  next[index] = mergeWorkflowRunPatch(runs[index]!, patch, updatedAt, eventSequence);
  return next;
}

export function compareWorkflowRuns(
  left: Pick<OrchestrationWorkflowRun, "startedAt" | "taskId">,
  right: Pick<OrchestrationWorkflowRun, "startedAt" | "taskId">,
): number {
  return left.startedAt.localeCompare(right.startedAt) || left.taskId.localeCompare(right.taskId);
}

/**
 * Runs that survive a revert: a run started by a turn the revert removed goes
 * with it. Runs of turns the caller can not name stay, so a revert never
 * loses a run it can not prove was undone.
 */
export function retainWorkflowRunsAfterRevert(
  runs: ReadonlyArray<OrchestrationWorkflowRun>,
  removedTurnIds: ReadonlySet<TurnId>,
): ReadonlyArray<OrchestrationWorkflowRun> {
  if (removedTurnIds.size === 0) return runs;
  const kept = runs.filter((run) => run.turnId === null || !removedTurnIds.has(run.turnId));
  return kept.length === runs.length ? runs : kept;
}

export interface WorkflowRunCounts {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  /** Never ran to its end: cut off by the run's end, or left out by the
   *  script. Not a failure. */
  readonly skipped: number;
  readonly running: number;
  readonly queued: number;
  /** Agents restarted at least once that are still going. */
  readonly retrying: number;
}

export function countWorkflowAgents(agents: ReadonlyArray<WorkflowAgent>): WorkflowRunCounts {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let running = 0;
  let queued = 0;
  let retrying = 0;
  for (const agent of agents) {
    switch (agent.state) {
      case "done":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "queued":
        queued += 1;
        break;
      case "running":
        running += 1;
        if ((agent.attempt ?? 1) > 1) retrying += 1;
        break;
    }
  }
  return { total: agents.length, done, failed, skipped, running, queued, retrying };
}

/**
 * The phase the run is in: the newest phase holding an agent that has not
 * ended, else the newest phase reached. Undefined for a run without phases.
 */
export function currentWorkflowPhase(
  run: Pick<OrchestrationWorkflowRun, "phases" | "agents">,
): WorkflowPhase | undefined {
  if (run.phases.length === 0) return undefined;
  let liveIndex: number | undefined;
  for (const agent of run.agents) {
    if (agent.phaseIndex === undefined) continue;
    if (agent.state === "running" || agent.state === "queued") {
      liveIndex =
        liveIndex === undefined ? agent.phaseIndex : Math.max(liveIndex, agent.phaseIndex);
    }
  }
  if (liveIndex !== undefined) {
    const live = run.phases.find((phase) => phase.index === liveIndex);
    if (live) return live;
  }
  return run.phases.at(-1);
}

/** What the thread list shows about a run. See AwaitedWorkflowProgress. */
export function workflowAwaitedProgress(
  run: Pick<OrchestrationWorkflowRun, "name" | "phases" | "agents">,
): AwaitedWorkflowProgress {
  const counts = countWorkflowAgents(run.agents);
  const phase = currentWorkflowPhase(run);
  return {
    ...(run.name ? { name: run.name } : {}),
    ...(phase ? { phaseTitle: phase.title } : {}),
    // A skipped or failed agent is over too: "6/8" means six of eight ended.
    doneAgents: counts.done + counts.failed + counts.skipped,
    totalAgents: counts.total,
  };
}

/** Same progress, compared by what a reader would see. */
export function sameAwaitedWorkflowProgress(
  left: AwaitedWorkflowProgress | undefined,
  right: AwaitedWorkflowProgress | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.name === right.name &&
    left.phaseTitle === right.phaseTitle &&
    left.doneAgents === right.doneAgents &&
    left.totalAgents === right.totalAgents
  );
}
