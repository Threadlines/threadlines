/**
 * How a workflow run reads, for every surface that shows one: the card in the
 * chat, the workflow view in the Agents tab, the live line, the header's
 * activity list and the sidebar. Pure: the components only lay it out.
 *
 * A run arrives as phases (the script's steps, in order) and agents (each
 * tagged with its phase). Claude names phases "phase N" when it hides a
 * built-in workflow's script; those read "Step N" here.
 */
import type {
  OrchestrationWorkflowRun,
  WorkflowAgent,
  WorkflowAgentState,
  WorkflowPhase,
} from "@threadlines/contracts";
import {
  countWorkflowAgents,
  currentWorkflowPhase,
  workflowPhaseDisplayTitle,
} from "@threadlines/shared/workflowRuns";
import { humanizeWorkflowName } from "@threadlines/shared/workflowScript";

import { formatTokenCount } from "../../lib/formatTokenCount";
import { formatDuration } from "../../session-logic";

/** Past this many agents a phase shows them as a strip of dots, and only the
 *  ones running, retrying or failed get a line of their own. */
export const WORKFLOW_DOT_STRIP_THRESHOLD = 12;

/** Claude's own "Large workflow" warning: more agents scheduled than this,
 *  or more tokens projected than the token limit. */
const LARGE_WORKFLOW_AGENTS = 25;
const LARGE_WORKFLOW_TOKENS = 1_500_000;
/** What each workflow size choice aims for (Claude's settings reference). */
const SIZE_GUIDELINE_AGENTS: Readonly<Record<string, number>> = {
  small: 5,
  medium: 10,
  large: 50,
};

export function workflowPhaseTitle(phase: Pick<WorkflowPhase, "title">): string {
  return workflowPhaseDisplayTitle(phase.title);
}

/** The run's name as a person reads it. */
export function workflowRunTitle(
  run: Pick<OrchestrationWorkflowRun, "name" | "description">,
): string {
  if (run.name) return humanizeWorkflowName(run.name);
  if (run.description) return run.description;
  return "Workflow";
}

/** The description line under the title, when it adds something. */
export function workflowRunSubtitle(
  run: Pick<OrchestrationWorkflowRun, "name" | "description">,
): string | null {
  return run.name && run.description ? run.description : null;
}

export type WorkflowPhaseState = "done" | "live" | "waiting" | "failed";

export interface WorkflowPhaseGroup {
  /** Null: the agents of a run without phases. */
  readonly phase: WorkflowPhase | null;
  readonly title: string;
  readonly agents: ReadonlyArray<WorkflowAgent>;
  readonly state: WorkflowPhaseState;
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  readonly retrying: number;
  readonly tokens: number;
  readonly toolCalls: number;
  /** From the first agent's start to the last one's end (or now). */
  readonly durationMs: number | null;
}

function agentEndMs(agent: WorkflowAgent, nowMs: number): number | null {
  if (agent.startedAt === undefined) return null;
  if (agent.state === "running") return nowMs;
  return agent.durationMs !== undefined ? agent.startedAt + agent.durationMs : null;
}

function groupOf(
  phase: WorkflowPhase | null,
  agents: ReadonlyArray<WorkflowAgent>,
  runEnded: boolean,
  nowMs: number,
): WorkflowPhaseGroup {
  const counts = countWorkflowAgents(agents);
  let tokens = 0;
  let toolCalls = 0;
  let firstStart: number | null = null;
  let lastEnd: number | null = null;
  for (const agent of agents) {
    tokens += agent.tokens ?? 0;
    toolCalls += agent.toolCalls ?? 0;
    if (agent.startedAt !== undefined) {
      firstStart = firstStart === null ? agent.startedAt : Math.min(firstStart, agent.startedAt);
    }
    const end = agentEndMs(agent, nowMs);
    if (end !== null) lastEnd = lastEnd === null ? end : Math.max(lastEnd, end);
  }
  const live = counts.running + counts.queued > 0 && !runEnded;
  const state: WorkflowPhaseState = live
    ? "live"
    : counts.total === 0
      ? "waiting"
      : counts.failed > 0 && counts.done === 0
        ? "failed"
        : "done";
  return {
    phase,
    title: phase ? workflowPhaseTitle(phase) : "Agents",
    agents,
    state,
    done: counts.done,
    failed: counts.failed,
    running: counts.running,
    retrying: counts.retrying,
    tokens,
    toolCalls,
    durationMs: firstStart !== null && lastEnd !== null ? Math.max(0, lastEnd - firstStart) : null,
  };
}

/**
 * The run's agents by phase, in phase order. Agents tagged with a phase the
 * run never reported, and agents of a run without phases, gather in one
 * group with no phase.
 */
export function workflowPhaseGroups(
  run: Pick<OrchestrationWorkflowRun, "phases" | "agents" | "status">,
  nowMs: number,
): ReadonlyArray<WorkflowPhaseGroup> {
  const runEnded = run.status !== "running";
  const known = new Set(run.phases.map((phase) => phase.index));
  const loose = run.agents.filter(
    (agent) => agent.phaseIndex === undefined || !known.has(agent.phaseIndex),
  );
  const groups = run.phases.map((phase) =>
    groupOf(
      phase,
      run.agents.filter((agent) => agent.phaseIndex === phase.index),
      runEnded,
      nowMs,
    ),
  );
  return loose.length > 0 ? [...groups, groupOf(null, loose, runEnded, nowMs)] : groups;
}

/** How long the run has gone, or went. */
export function workflowRunElapsedMs(
  run: Pick<OrchestrationWorkflowRun, "startedAt" | "endedAt">,
  nowMs: number,
): number {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

/** A clock: 34:31, or 1:02:15 past an hour. */
export function formatWorkflowClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Whole minutes for a finished run's receipt: "41m", "2h 3m", "48s". */
export function formatWorkflowSpan(ms: number): string {
  if (ms < 60_000) return formatDuration(ms);
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function formatWorkflowTokens(tokens: number): string {
  return `${formatTokenCount(tokens)} tokens`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** The phase row's meta text: progress while live, totals once done. */
export function workflowPhaseMeta(group: WorkflowPhaseGroup): string {
  if (group.state === "live") {
    const parts = [`${group.done} of ${group.agents.length} done`];
    if (group.failed > 0) parts.push(`${group.failed} failed`);
    if (group.retrying > 0) parts.push(`${group.retrying} retrying`);
    return parts.join(" · ");
  }
  if (group.state === "waiting") return "Not started";
  const parts = [pluralize(group.agents.length, "agent")];
  if (group.failed > 0) parts.push(`${group.failed} failed`);
  if (group.durationMs !== null) parts.push(formatWorkflowSpan(group.durationMs));
  if (group.tokens > 0) parts.push(formatWorkflowTokens(group.tokens));
  return parts.join(" · ");
}

export type WorkflowAgentDisplayState = WorkflowAgentState | "retrying";

export function workflowAgentDisplayState(agent: WorkflowAgent): WorkflowAgentDisplayState {
  return agent.state === "running" && (agent.attempt ?? 1) > 1 ? "retrying" : agent.state;
}

/** Agents worth a line when the phase shows a dot strip: the ones still
 *  going and the ones that went wrong. */
export function workflowAgentsNeedingRows(
  agents: ReadonlyArray<WorkflowAgent>,
): ReadonlyArray<WorkflowAgent> {
  return agents.filter(
    (agent) => agent.state === "running" || agent.state === "failed" || agent.state === "skipped",
  );
}

/** One line of what the agent did or found, newest first. */
export function workflowAgentNowText(agent: WorkflowAgent): string | null {
  switch (agent.state) {
    case "failed":
    case "skipped":
      return agent.error ?? (agent.state === "skipped" ? "Skipped" : "Failed");
    case "done":
      return agent.resultPreview ? firstLine(agent.resultPreview) : "Done";
    case "queued":
      return "Waiting to start";
    case "running":
      if ((agent.attempt ?? 1) > 1 && !agent.lastStep) {
        return agent.retryReason === "throttled"
          ? "Rate limited, trying again"
          : "Stalled, started over";
      }
      return agent.lastStep ?? (agent.lastToolName ? agent.lastToolName : "Starting");
  }
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  // A structured answer reads better by its first value than as raw JSON.
  if (trimmed.startsWith("{")) {
    const match = /"(?:summary|result|answer|verdict)"\s*:\s*"([^"]{1,200})/u.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? trimmed : trimmed.slice(0, newline);
}

/** The tool an agent's newest step used, when its step text does not start
 *  with it already. */
export function workflowAgentStepTool(agent: WorkflowAgent): string | null {
  if (agent.state !== "running" || !agent.lastToolName || !agent.lastStep) return null;
  return agent.lastStep.startsWith(agent.lastToolName) ? null : agent.lastToolName;
}

export function workflowAgentMeta(agent: WorkflowAgent, nowMs: number): string {
  const parts: Array<string> = [];
  const end = agentEndMs(agent, nowMs);
  if (agent.startedAt !== undefined && end !== null) {
    parts.push(formatDuration(Math.max(0, end - agent.startedAt)));
  }
  if (agent.toolCalls !== undefined && agent.toolCalls > 0) {
    parts.push(pluralize(agent.toolCalls, "step"));
  }
  return parts.join(" · ");
}

export interface WorkflowRunSummary {
  readonly title: string;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  readonly phaseTitle: string | null;
  readonly phasePosition: { readonly index: number; readonly of: number } | null;
}

export function summarizeWorkflowRun(run: OrchestrationWorkflowRun): WorkflowRunSummary {
  const counts = countWorkflowAgents(run.agents);
  const phase = currentWorkflowPhase(run);
  const position = phase ? run.phases.findIndex((entry) => entry.index === phase.index) : -1;
  return {
    title: workflowRunTitle(run),
    total: counts.total,
    done: counts.done + counts.failed,
    failed: counts.failed,
    running: counts.running,
    phaseTitle: phase ? workflowPhaseTitle(phase) : null,
    phasePosition: position >= 0 ? { index: position + 1, of: run.phases.length } : null,
  };
}

/** The bottom line while a run goes on: "Verify · 2 of 4 agents". */
export function workflowLiveLineText(run: OrchestrationWorkflowRun): string {
  const summary = summarizeWorkflowRun(run);
  const groups = workflowPhaseGroups(run, Date.now());
  const live = groups.find((group) => group.state === "live");
  const agents = live
    ? `${live.done} of ${live.agents.length} agents`
    : `${summary.done} of ${summary.total} agents`;
  return summary.phaseTitle ? `${summary.phaseTitle} · ${agents}` : agents;
}

/** How a run ended, in words; null while it runs. */
export function workflowRunEndWord(run: Pick<OrchestrationWorkflowRun, "status">): string | null {
  switch (run.status) {
    case "running":
      return null;
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "lost":
      return "ended unexpectedly";
  }
}

/**
 * Claude's "Large workflow" warning: more agents than the size the user chose
 * (25 when they chose none), or a token total on course to pass 1.5M.
 * Ultracode opts the user in to large runs, so it never shows then.
 */
export function workflowLargeNote(input: {
  readonly run: OrchestrationWorkflowRun;
  readonly ultracode: boolean;
  readonly sizeGuideline: string | null;
}): string | null {
  const { run } = input;
  if (input.ultracode || run.status !== "running") return null;
  const counts = countWorkflowAgents(run.agents);
  const agentLimit =
    (input.sizeGuideline ? SIZE_GUIDELINE_AGENTS[input.sizeGuideline] : undefined) ??
    LARGE_WORKFLOW_AGENTS;
  const finished = counts.done + counts.failed;
  const projected =
    finished > 0 && counts.total > finished
      ? Math.round((run.totalTokens / finished) * counts.total)
      : run.totalTokens;
  if (counts.total <= agentLimit && projected <= LARGE_WORKFLOW_TOKENS) return null;
  const tokens =
    projected > LARGE_WORKFLOW_TOKENS
      ? `, about ${formatTokenCount(projected)} tokens at this pace`
      : "";
  return `Large workflow: ${pluralize(counts.total, "agent")}${tokens}`;
}

/** Rough row height for the chat's virtual list before the card measures. */
export function estimateWorkflowRunCardHeight(run: OrchestrationWorkflowRun): number {
  if (run.status !== "running") return 76;
  const groups = workflowPhaseGroups(run, Date.now());
  const live = groups.find((group) => group.state === "live");
  const agentLines = live
    ? live.agents.length > WORKFLOW_DOT_STRIP_THRESHOLD
      ? 1 + workflowAgentsNeedingRows(live.agents).length
      : live.agents.length
    : 0;
  return 60 + groups.length * 26 + agentLines * 24;
}

export interface WorkflowTimelineBar {
  readonly agent: WorkflowAgent;
  /** Where its run starts and how long it is, in percent of the axis. */
  readonly left: number;
  readonly width: number;
  /** The wait before it started (queued), when it waited. */
  readonly waitLeft: number | null;
  readonly waitWidth: number | null;
  readonly durationMs: number | null;
}

export interface WorkflowTimelineLayout {
  readonly startMs: number;
  readonly spanMs: number;
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly bars: ReadonlyArray<WorkflowTimelineBar>;
  }>;
  readonly ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
}

const TICK_STEPS_MS = [
  10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
] as const;

/** "0", "30s", "1m 30s", "15m", "1h": ticks fall on round steps, so a label
 *  needs at most two units. */
function tickLabel(ms: number): string {
  if (ms === 0) return "0";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds > 0) return `${minutes}m ${seconds}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/**
 * Who ran when: one bar per agent from its start to its end (or now), on an
 * axis from the run's first moment to its last, grouped by phase. Agents that
 * never started have no bar. Four to six ticks, on round steps.
 */
export function workflowTimelineLayout(
  run: OrchestrationWorkflowRun,
  nowMs: number,
): WorkflowTimelineLayout {
  const runStart = Date.parse(run.startedAt);
  let startMs = Number.isFinite(runStart) ? runStart : nowMs;
  let endMs = run.endedAt ? Date.parse(run.endedAt) : nowMs;
  for (const agent of run.agents) {
    const first = agent.queuedAt ?? agent.startedAt;
    if (first !== undefined) startMs = Math.min(startMs, first);
    const end = agentEndMs(agent, nowMs);
    if (end !== null) endMs = Math.max(endMs, end);
  }
  const spanMs = Math.max(1_000, endMs - startMs);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - startMs) / spanMs) * 100));
  const groups = workflowPhaseGroups(run, nowMs).map((group) => ({
    key: group.phase ? String(group.phase.index) : "loose",
    title: group.title,
    bars: group.agents.flatMap((agent): ReadonlyArray<WorkflowTimelineBar> => {
      if (agent.startedAt === undefined) return [];
      const end = agentEndMs(agent, nowMs) ?? agent.startedAt;
      const left = pct(agent.startedAt);
      const waited = agent.queuedAt !== undefined && agent.queuedAt < agent.startedAt - 1_000;
      return [
        {
          agent,
          left,
          width: Math.max(0.6, pct(end) - left),
          waitLeft: waited ? pct(agent.queuedAt!) : null,
          waitWidth: waited ? pct(agent.startedAt) - pct(agent.queuedAt!) : null,
          durationMs: Math.max(0, end - agent.startedAt),
        },
      ];
    }),
  }));
  const step = TICK_STEPS_MS.find((candidate) => spanMs / candidate <= 5) ?? TICK_STEPS_MS.at(-1)!;
  const ticks: Array<{ at: number; label: string }> = [];
  for (let at = 0; at <= spanMs; at += step) {
    ticks.push({ at: (at / spanMs) * 100, label: tickLabel(at) });
  }
  return { startMs, spanMs, groups, ticks };
}
