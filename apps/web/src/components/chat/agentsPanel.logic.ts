/**
 * View-models for the agents panel: the current turn's orchestration drawn as
 * a thread. Everything the panel renders — ordering, status, the mono meta
 * line, the turn row's one-line summary — is decided here so the component
 * stays a pure projection of it.
 */
import type { TurnId } from "@threadlines/contracts";

import { formatSubagentDisplayName, type SubagentProgressItem } from "../../session-logic";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { formatSubagentMetaParts, formatSubagentDuration } from "./subagentMeta";
import {
  backgroundRunCommandText,
  backgroundRunMetaItems,
  backgroundRunSourceLabel,
  deriveSubagentDisplayDetails,
  normalizeSubagentInlineText,
  type ThreadBackgroundRunItem,
} from "./threadActivity";

/**
 * What the branch's status dot says. `waiting` is the only one that asks
 * something of the user, which is why it reads amber rather than accent.
 */
export type AgentBranchStatus = "running" | "waiting" | "failed" | "completed";

interface AgentBranchBase {
  /** Stable across re-derivations so React keeps row state. */
  readonly key: string;
  readonly status: AgentBranchStatus;
  readonly name: string;
  readonly statusLabel: string;
  /** Mono meta parts, already ordered; joined with `·` by the row. */
  readonly meta: ReadonlyArray<string>;
  /** One line describing what the branch was asked to do. */
  readonly task: string | null;
  /** One line of the freshest output; live-tinted while running. */
  readonly output: string | null;
  /** Provenance chip for runs, e.g. `codex · detected`. Null for subagents,
   *  which are transcript-backed and drill in instead. */
  readonly tag: string | null;
  /** Visual nesting under the trunk, capped so deep trees stay readable. */
  readonly depth: number;
}

export interface AgentSubagentBranch extends AgentBranchBase {
  readonly kind: "subagent";
  readonly tag: null;
  readonly item: SubagentProgressItem;
  /** Only a subagent the provider can serve a transcript for can drill in. */
  readonly transcriptAvailable: boolean;
}

export interface AgentRunBranch extends AgentBranchBase {
  readonly kind: "run";
  readonly depth: 0;
  readonly run: ThreadBackgroundRunItem;
  /** Clicking the branch toggles this terminal; null runs are not clickable. */
  readonly terminalId: string | null;
  readonly terminalVisible: boolean;
}

export type AgentBranch = AgentSubagentBranch | AgentRunBranch;

export interface TurnAgentSummarySegment {
  readonly id: string;
  readonly status: AgentBranchStatus;
}

export interface TurnAgentSummary {
  /** One segment per subagent, in the same order the panel lists them. */
  readonly segments: ReadonlyArray<TurnAgentSummarySegment>;
  /** `4 subagents · 1 done · 1 needs you` */
  readonly text: string;
  readonly total: number;
}

const MAX_BRANCH_DEPTH = 3;

const STATUS_ORDER: Readonly<Record<AgentBranchStatus, number>> = {
  running: 0,
  waiting: 1,
  failed: 2,
  completed: 3,
};

export function subagentBranchStatus(status: SubagentProgressItem["status"]): AgentBranchStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "interrupted") {
    return "failed";
  }
  if (status === "waiting") {
    return "waiting";
  }
  return "running";
}

export function isLiveAgentBranchStatus(status: AgentBranchStatus): boolean {
  return status === "running" || status === "waiting";
}

/**
 * A background run only appears while it is live, so every run branch reads as
 * running. Provider-managed runs that the provider has parked read as waiting.
 */
function backgroundRunBranchStatus(run: ThreadBackgroundRunItem): AgentBranchStatus {
  return /\b(waiting|blocked|paused)\b/iu.test(run.statusLabel) ? "waiting" : "running";
}

/** `codex · detected`. The provider is dropped when it is not known. */
function backgroundRunTag(
  run: ThreadBackgroundRunItem,
  providerLabel: string | null | undefined,
): string {
  if (run.source === "terminal") {
    return "terminal";
  }
  const provider = providerLabel?.trim().toLowerCase();
  return provider ? `${provider} · ${run.source}` : run.source;
}

function subagentBranch(
  item: SubagentProgressItem,
  nowMs: number | undefined,
): AgentSubagentBranch {
  const status = subagentBranchStatus(item.status);
  const details = deriveSubagentDisplayDetails(item);
  const live = isLiveAgentBranchStatus(status);
  return {
    kind: "subagent",
    key: `subagent:${item.id}`,
    status,
    name: formatSubagentDisplayName(item),
    statusLabel: item.statusLabel,
    meta: formatSubagentMetaParts(item, {
      context: details.context,
      elapsed: live ? formatElapsedDurationLabel(item.createdAt, nowMs) : null,
      includeCurrentTool: false,
    }),
    task: details.goal,
    // The step the provider reports is the freshest signal; the agent's own
    // streamed prose is the fallback when there is no task stream.
    output: live
      ? (item.telemetry?.step ??
        (item.liveBody ? normalizeSubagentInlineText(item.liveBody) : null))
      : null,
    tag: null,
    depth: Math.min(Math.max(item.treeDepth ?? 0, 0), MAX_BRANCH_DEPTH),
    item,
    transcriptAvailable: item.agentThreadId !== null,
  };
}

function runBranch(
  run: ThreadBackgroundRunItem,
  providerLabel: string | null | undefined,
): AgentRunBranch {
  const task = backgroundRunCommandText(run);
  const detail = run.detail?.trim() || null;
  // A served URL is the most useful thing a run has said; its detail line is
  // the fallback when it is not just the command restated.
  const primaryUrl = run.urls[0] ?? null;
  const output = primaryUrl ?? (detail !== null && detail !== task ? detail : null);
  return {
    kind: "run",
    key: `run:${run.id}`,
    status: backgroundRunBranchStatus(run),
    name: run.label,
    statusLabel: run.statusLabel,
    meta: [backgroundRunSourceLabel(run), ...backgroundRunMetaItems(run)],
    task,
    output,
    tag: backgroundRunTag(run, providerLabel),
    depth: 0,
    run,
    terminalId: run.terminalId,
    terminalVisible: run.terminalVisible === true,
  };
}

/**
 * Running first, then waiting, then failed, then completed — the order in
 * which a branch is likely to need attention. Within a group, oldest first;
 * branches with no start time (background runs) keep their incoming order
 * after the timed ones.
 */
export function buildAgentBranches(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  readonly providerLabel?: string | null | undefined;
  readonly nowMs?: number | undefined;
}): ReadonlyArray<AgentBranch> {
  const branches: Array<{ branch: AgentBranch; startedAtMs: number | null }> = [
    ...input.subagents.map((item) => ({
      branch: subagentBranch(item, input.nowMs) as AgentBranch,
      startedAtMs: parseTimestamp(item.createdAt),
    })),
    ...input.backgroundRuns.map((run) => ({
      branch: runBranch(run, input.providerLabel) as AgentBranch,
      startedAtMs: null,
    })),
  ];

  return branches
    .toSorted((left, right) => {
      const statusComparison = STATUS_ORDER[left.branch.status] - STATUS_ORDER[right.branch.status];
      if (statusComparison !== 0) {
        return statusComparison;
      }
      if (left.startedAtMs === null || right.startedAtMs === null) {
        return left.startedAtMs === right.startedAtMs ? 0 : left.startedAtMs === null ? 1 : -1;
      }
      return left.startedAtMs - right.startedAtMs;
    })
    .map((entry) => entry.branch);
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The subagents a turn spawned, for the timeline's per-turn activity row. */
export function selectSubagentsForTurns(
  subagents: ReadonlyArray<SubagentProgressItem>,
  turnIds: ReadonlySet<TurnId>,
): ReadonlyArray<SubagentProgressItem> {
  if (turnIds.size === 0) {
    return [];
  }
  return subagents.filter((item) => item.turnId !== null && turnIds.has(item.turnId));
}

/**
 * The turn row's compact read: how many agents ran, how many finished, and
 * how many are asking for something. Counts that are zero stay out of the line
 * so it never pads itself with nothing.
 */
export function summarizeTurnAgents(
  subagents: ReadonlyArray<SubagentProgressItem>,
): TurnAgentSummary | null {
  if (subagents.length === 0) {
    return null;
  }

  const statuses = subagents
    .map((item) => ({ id: item.id, status: subagentBranchStatus(item.status) }))
    .toSorted((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]);
  const countOf = (status: AgentBranchStatus) =>
    statuses.filter((candidate) => candidate.status === status).length;
  const doneCount = countOf("completed");
  const failedCount = countOf("failed");
  const waitingCount = countOf("waiting");

  const parts = [
    pluralize(statuses.length, "subagent"),
    doneCount > 0 ? `${doneCount} done` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
    waitingCount > 0 ? `${waitingCount} needs you` : null,
  ].filter((part): part is string => part !== null);

  return {
    segments: statuses,
    text: parts.join(" · "),
    total: statuses.length,
  };
}

function pluralize(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * The panel header's right-hand mono meta: how long the longest-running agent
 * has been going, and what the turn's agents have spent between them.
 */
export function formatAgentsHeaderMeta(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly nowMs?: number | undefined;
}): string | null {
  const elapsedMs = input.subagents.reduce<number | null>((longest, item) => {
    if (!isLiveAgentBranchStatus(subagentBranchStatus(item.status))) {
      return longest;
    }
    const startedAtMs = parseTimestamp(item.createdAt);
    if (startedAtMs === null) {
      return longest;
    }
    const elapsed = (input.nowMs ?? Date.now()) - startedAtMs;
    return longest === null || elapsed > longest ? elapsed : longest;
  }, null);

  const totalTokens = input.subagents.reduce(
    (total, item) => total + (item.telemetry?.totalTokens ?? 0),
    0,
  );

  const parts = [
    elapsedMs !== null && elapsedMs > 0 ? formatSubagentDuration(elapsedMs) : null,
    totalTokens > 0 ? `${formatContextWindowTokens(totalTokens)} tokens` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : null;
}
