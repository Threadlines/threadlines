/**
 * Claude dynamic workflows, from the SDK's task stream to workflow run
 * updates (see `WorkflowRunUpdate` in contracts).
 *
 * A workflow is one background task (`task_type: "local_workflow"`). Its own
 * agents never get task events. What they do arrives on the task's
 * `task_progress` frames as `workflow_progress`: a field the SDK's typings
 * leave out, holding the newest entry for every phase and agent. A frame
 * without it keeps the previous entries. Claude sends it right away when an
 * agent or phase changes state and at most every ten seconds otherwise.
 *
 * The tracker keeps the last entries it sent per run and reports only what
 * changed. A state change goes out at once; a frame that only moved tokens or
 * an agent's latest step waits until five seconds after the last send, and is
 * folded into whatever goes out next.
 */
import type {
  AwaitedWorkflowProgress,
  WorkflowAgent,
  WorkflowAgentState,
  WorkflowPhase,
  WorkflowRunStatus,
  WorkflowRunUpdate,
} from "@threadlines/contracts";
import {
  sameAwaitedWorkflowProgress,
  workflowAwaitedProgress,
} from "@threadlines/shared/workflowRuns";

/** Progress-only changes wait this long after the previous send. */
export const WORKFLOW_PROGRESS_INTERVAL_MS = 5_000;

const MAX_LABEL_CHARS = 200;
const MAX_STEP_CHARS = 300;
const MAX_PREVIEW_CHARS = 400;
const MAX_ERROR_CHARS = 1_000;
const MAX_SUMMARY_CHARS = 2_000;

/** Phase titles Claude substitutes when a workflow hides its script. */
const HIDDEN_PHASE_TITLE = /^phase \d{1,4}$/u;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function positive(value: unknown): number | undefined {
  const n = count(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

function agentState(entry: UnknownRecord): WorkflowAgentState | undefined {
  switch (entry.state) {
    case "start":
      // Claude marks a scheduled agent `start` before it really starts; only
      // `startedAt` tells the two apart.
      return entry.queuedAt !== undefined && entry.startedAt === undefined ? "queued" : "running";
    case "progress":
      return "running";
    case "done":
      return "done";
    case "error":
      return entry.skipped === true ? "skipped" : "failed";
    default:
      return undefined;
  }
}

/** One `workflow_agent` entry, or undefined when it is not one we can read. */
export function claudeWorkflowAgent(value: unknown): WorkflowAgent | undefined {
  const entry = record(value);
  if (!entry || entry.type !== "workflow_agent") return undefined;
  const index = count(entry.index);
  const label = clip(entry.label, MAX_LABEL_CHARS);
  const state = agentState(entry);
  if (index === undefined || label === undefined || state === undefined) return undefined;
  const phaseIndex = count(entry.phaseIndex);
  const agentId = clip(entry.agentId, 200);
  const model = clip(entry.model, 120);
  const attempt = positive(entry.attempt);
  const retryReason = clip(entry.lastAttemptReason, 80);
  const queuedAt = count(entry.queuedAt);
  const startedAt = count(entry.startedAt);
  const durationMs = count(entry.durationMs);
  const tokens = count(entry.tokens);
  const toolCalls = count(entry.toolCalls);
  const lastToolName = clip(entry.lastToolName, 120);
  const lastStep = clip(entry.lastToolSummary, MAX_STEP_CHARS);
  const instructionsPreview = clip(entry.promptPreview, MAX_PREVIEW_CHARS);
  const resultPreview = clip(entry.resultPreview, MAX_PREVIEW_CHARS);
  const error = clip(entry.error, MAX_ERROR_CHARS);
  const isolation = clip(entry.isolation, 40);
  return {
    index,
    label,
    state,
    ...(phaseIndex !== undefined ? { phaseIndex } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(retryReason !== undefined ? { retryReason } : {}),
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(lastToolName !== undefined ? { lastToolName } : {}),
    ...(lastStep !== undefined ? { lastStep } : {}),
    ...(instructionsPreview !== undefined ? { instructionsPreview } : {}),
    ...(resultPreview !== undefined ? { resultPreview } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
  };
}

/** One `workflow_phase` entry, or undefined when it is not one we can read. */
export function claudeWorkflowPhase(value: unknown): WorkflowPhase | undefined {
  const entry = record(value);
  if (!entry || entry.type !== "workflow_phase") return undefined;
  const index = count(entry.index);
  const title = clip(entry.title, MAX_LABEL_CHARS);
  return index === undefined || title === undefined ? undefined : { index, title };
}

export interface ClaudeWorkflowSnapshot {
  readonly phases: ReadonlyArray<WorkflowPhase>;
  readonly agents: ReadonlyArray<WorkflowAgent>;
}

/** A `workflow_progress` array (live frame or saved output), or undefined
 *  when the frame carried none. Entries we cannot read are skipped. */
export function claudeWorkflowSnapshot(value: unknown): ClaudeWorkflowSnapshot | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: Array<WorkflowPhase> = [];
  const agents: Array<WorkflowAgent> = [];
  for (const entry of value) {
    const phase = claudeWorkflowPhase(entry);
    if (phase) {
      phases.push(phase);
      continue;
    }
    const agent = claudeWorkflowAgent(entry);
    if (agent) agents.push(agent);
  }
  return { phases, agents };
}

/** What `Workflow`'s tool result says about the run it launched. */
export interface ClaudeWorkflowLaunch {
  readonly taskId: string;
  readonly runId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly transcriptDir?: string;
  readonly scriptPath?: string;
}

/** The structured `tool_use_result` of a `Workflow` call that launched. */
export function claudeWorkflowLaunch(value: unknown): ClaudeWorkflowLaunch | undefined {
  const result = record(value);
  if (!result) return undefined;
  if (result.status !== "async_launched" || result.taskType !== "local_workflow") return undefined;
  const taskId = clip(result.taskId, 200);
  if (taskId === undefined) return undefined;
  const runId = clip(result.runId, 200);
  const name = clip(result.workflowName, MAX_LABEL_CHARS);
  const description = clip(result.summary, MAX_SUMMARY_CHARS);
  const transcriptDir = clip(result.transcriptDir, 4_096);
  const scriptPath = clip(result.scriptPath, 4_096);
  return {
    taskId,
    ...(runId !== undefined ? { runId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(transcriptDir !== undefined ? { transcriptDir } : {}),
    ...(scriptPath !== undefined ? { scriptPath } : {}),
  };
}

/** The JSON Claude writes to a finished workflow task's output file. */
export interface ClaudeWorkflowFinalOutput {
  readonly snapshot?: ClaudeWorkflowSnapshot;
  readonly totalTokens?: number;
  readonly totalToolCalls?: number;
}

export function claudeWorkflowFinalOutput(text: string): ClaudeWorkflowFinalOutput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const output = record(parsed);
  if (!output) return undefined;
  const snapshot = claudeWorkflowSnapshot(output.workflowProgress);
  const totalTokens = count(output.totalTokens);
  const totalToolCalls = count(output.totalToolCalls);
  return {
    ...(snapshot ? { snapshot } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(totalToolCalls !== undefined ? { totalToolCalls } : {}),
  };
}

/** Fields whose change is worth sending at once. Everything else an agent
 *  reports (tokens, tool calls, run time, latest step) is progress. */
function agentStateKey(agent: WorkflowAgent): string {
  return [
    agent.state,
    agent.attempt ?? 1,
    agent.agentId ?? "",
    agent.phaseIndex ?? "",
    agent.resultPreview ?? "",
    agent.error ?? "",
  ].join("\u0000");
}

function agentKey(agent: WorkflowAgent): string {
  return JSON.stringify(agent);
}

interface RunState {
  readonly taskId: string;
  name: string | undefined;
  /** `started` already reported; a resumed task restates its start. */
  startReported: boolean;
  ended: boolean;
  hiddenScript: boolean;
  /** Entries as last sent. */
  readonly sentPhases: Map<number, string>;
  readonly sentAgents: Map<number, string>;
  readonly sentAgentStates: Map<number, string>;
  /** Newest entries seen, sent or not. */
  readonly phases: Map<number, WorkflowPhase>;
  readonly agents: Map<number, WorkflowAgent>;
  sentTotalTokens: number | undefined;
  sentTotalToolCalls: number | undefined;
  totalTokens: number | undefined;
  totalToolCalls: number | undefined;
  lastSentAtMs: number;
  lastAwaited: AwaitedWorkflowProgress | undefined;
}

/**
 * Per-session bookkeeping for the session's workflow runs. Pure: the adapter
 * feeds it SDK facts and emits whatever update it returns.
 */
export class ClaudeWorkflowRunTracker {
  private readonly runs = new Map<string, RunState>();

  has(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  /** The run already reported its end. */
  isEnded(taskId: string): boolean {
    return this.runs.get(taskId)?.ended === true;
  }

  private run(taskId: string): RunState {
    let state = this.runs.get(taskId);
    if (!state) {
      state = {
        taskId,
        name: undefined,
        startReported: false,
        ended: false,
        hiddenScript: false,
        sentPhases: new Map(),
        sentAgents: new Map(),
        sentAgentStates: new Map(),
        phases: new Map(),
        agents: new Map(),
        sentTotalTokens: undefined,
        sentTotalToolCalls: undefined,
        totalTokens: undefined,
        totalToolCalls: undefined,
        lastSentAtMs: 0,
        lastAwaited: undefined,
      };
      this.runs.set(taskId, state);
    }
    return state;
  }

  /** The task started (`task_started` with `task_type: local_workflow`).
   *  Undefined when its start was already reported. */
  started(input: {
    readonly taskId: string;
    readonly toolCallId?: string;
    readonly name?: string;
    readonly description?: string;
    readonly startedAt: string;
  }): WorkflowRunUpdate | undefined {
    const state = this.run(input.taskId);
    if (state.startReported) return undefined;
    state.startReported = true;
    const name = clip(input.name, MAX_LABEL_CHARS);
    const description = clip(input.description, MAX_SUMMARY_CHARS);
    if (name !== undefined) state.name = name;
    return {
      taskId: input.taskId,
      status: "running",
      startedAt: input.startedAt,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }

  /** The `Workflow` call's result named the run's files. */
  launched(launch: ClaudeWorkflowLaunch, toolCallId: string): WorkflowRunUpdate {
    const state = this.run(launch.taskId);
    if (launch.name !== undefined) state.name = launch.name;
    return {
      taskId: launch.taskId,
      toolCallId,
      ...(launch.runId !== undefined ? { runId: launch.runId } : {}),
      ...(launch.name !== undefined ? { name: launch.name } : {}),
      ...(launch.description !== undefined ? { description: launch.description } : {}),
      ...(launch.transcriptDir !== undefined ? { transcriptDir: launch.transcriptDir } : {}),
      ...(launch.scriptPath !== undefined ? { scriptPath: launch.scriptPath } : {}),
    };
  }

  /**
   * A `task_progress` frame. Returns the update to send now, or undefined
   * when nothing changed or the change can wait.
   */
  progress(input: {
    readonly taskId: string;
    readonly snapshot: ClaudeWorkflowSnapshot | undefined;
    readonly totalTokens: number | undefined;
    readonly totalToolCalls: number | undefined;
    readonly nowMs: number;
  }): WorkflowRunUpdate | undefined {
    const state = this.run(input.taskId);
    if (state.ended) return undefined;
    this.absorb(state, input.snapshot, input.totalTokens, input.totalToolCalls);
    return this.flush(state, input.nowMs, false);
  }

  /**
   * The run ended. Sends whatever was held back with the end, so the last
   * progress is never lost. Later frames for the run are ignored.
   */
  ended(input: {
    readonly taskId: string;
    readonly status: Exclude<WorkflowRunStatus, "running">;
    readonly endedAt: string;
    readonly summary?: string;
    readonly statusReason?: string;
    readonly totalTokens?: number;
    readonly totalToolCalls?: number;
    readonly nowMs: number;
  }): WorkflowRunUpdate {
    const state = this.run(input.taskId);
    this.absorb(state, undefined, input.totalTokens, input.totalToolCalls);
    const held = this.flush(state, input.nowMs, true);
    state.ended = true;
    const summary = clip(input.summary, MAX_SUMMARY_CHARS);
    const statusReason = clip(input.statusReason, 80);
    return {
      ...held,
      taskId: input.taskId,
      status: input.status,
      endedAt: input.endedAt,
      ...(summary !== undefined ? { summary } : {}),
      ...(statusReason !== undefined ? { statusReason } : {}),
    };
  }

  /**
   * The finished run's saved output: the agents' final entries. Sent even
   * after the end, which only says how the run ended, not where each agent
   * got to.
   */
  finalOutput(
    taskId: string,
    output: ClaudeWorkflowFinalOutput,
    nowMs: number,
  ): WorkflowRunUpdate | undefined {
    const state = this.runs.get(taskId);
    if (!state) return undefined;
    this.absorb(state, output.snapshot, output.totalTokens, output.totalToolCalls);
    return this.flush(state, nowMs, true);
  }

  /** What the thread list shows about the run, from everything seen so far. */
  awaitedProgress(taskId: string): AwaitedWorkflowProgress | undefined {
    const state = this.runs.get(taskId);
    if (!state) return undefined;
    return workflowAwaitedProgress({
      name: state.name ?? null,
      phases: [...state.phases.values()].toSorted((a, b) => a.index - b.index),
      agents: [...state.agents.values()],
    });
  }

  /** Whether the thread-list progress changed since the last call for it. */
  takeAwaitedChange(taskId: string): boolean {
    const state = this.runs.get(taskId);
    if (!state) return false;
    const next = this.awaitedProgress(taskId);
    const changed = !sameAwaitedWorkflowProgress(state.lastAwaited, next);
    state.lastAwaited = next;
    return changed;
  }

  /** Runs still going, for settling them when the session goes away. */
  liveTaskIds(): ReadonlyArray<string> {
    return [...this.runs.values()].filter((state) => !state.ended).map((state) => state.taskId);
  }

  private absorb(
    state: RunState,
    snapshot: ClaudeWorkflowSnapshot | undefined,
    totalTokens: number | undefined,
    totalToolCalls: number | undefined,
  ): void {
    if (snapshot) {
      for (const phase of snapshot.phases) state.phases.set(phase.index, phase);
      for (const agent of snapshot.agents) state.agents.set(agent.index, agent);
      if (state.phases.size > 0) {
        const phases = [...state.phases.values()];
        const agents = [...state.agents.values()];
        state.hiddenScript =
          phases.every((phase) => HIDDEN_PHASE_TITLE.test(phase.title)) &&
          agents.every((agent) => agent.instructionsPreview === undefined);
      }
    }
    if (totalTokens !== undefined) state.totalTokens = totalTokens;
    if (totalToolCalls !== undefined) state.totalToolCalls = totalToolCalls;
  }

  private flush(state: RunState, nowMs: number, force: boolean): WorkflowRunUpdate | undefined {
    const phases: Array<WorkflowPhase> = [];
    for (const phase of state.phases.values()) {
      const key = JSON.stringify(phase);
      if (state.sentPhases.get(phase.index) !== key) phases.push(phase);
    }
    const agents: Array<WorkflowAgent> = [];
    let stateChanged = phases.length > 0;
    for (const agent of state.agents.values()) {
      if (state.sentAgents.get(agent.index) === agentKey(agent)) continue;
      agents.push(agent);
      if (state.sentAgentStates.get(agent.index) !== agentStateKey(agent)) stateChanged = true;
    }
    const tokensChanged = state.totalTokens !== state.sentTotalTokens;
    const toolCallsChanged = state.totalToolCalls !== state.sentTotalToolCalls;
    if (phases.length === 0 && agents.length === 0 && !tokensChanged && !toolCallsChanged) {
      return undefined;
    }
    if (!force && !stateChanged && nowMs - state.lastSentAtMs < WORKFLOW_PROGRESS_INTERVAL_MS) {
      return undefined;
    }
    for (const phase of phases) state.sentPhases.set(phase.index, JSON.stringify(phase));
    for (const agent of agents) {
      state.sentAgents.set(agent.index, agentKey(agent));
      state.sentAgentStates.set(agent.index, agentStateKey(agent));
    }
    state.sentTotalTokens = state.totalTokens;
    state.sentTotalToolCalls = state.totalToolCalls;
    state.lastSentAtMs = nowMs;
    return {
      taskId: state.taskId,
      ...(phases.length > 0 ? { phases: phases.toSorted((a, b) => a.index - b.index) } : {}),
      ...(agents.length > 0 ? { agents: agents.toSorted((a, b) => a.index - b.index) } : {}),
      ...(tokensChanged && state.totalTokens !== undefined
        ? { totalTokens: state.totalTokens }
        : {}),
      ...(toolCallsChanged && state.totalToolCalls !== undefined
        ? { totalToolCalls: state.totalToolCalls }
        : {}),
      ...(phases.length > 0 ? { hiddenScript: state.hiddenScript } : {}),
    };
  }
}
