/**
 * View-models for the agents panel: the current turn's orchestration drawn as
 * a thread. Everything the panel renders — ordering, status, the mono meta
 * line, the turn row's one-line summary — is decided here so the component
 * stays a pure projection of it.
 */
import type { TurnId } from "@threadlines/contracts";

import {
  formatSubagentDisplayName,
  type SubagentProgressItem,
  type ThreadSubagentHistoryEntry,
} from "../../session-logic";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { pluralize } from "../../lib/utils";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
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
  /** When the branch last moved, for a row that puts time on its own right edge
   *  rather than at the end of the meta run. Set for settled history rows; a
   *  live branch keeps its elapsed inside `meta`, where it ticks. */
  readonly time: string | null;
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

/**
 * `gpt-5.6-sol · high`: who is doing the work, as the provider recorded it. The
 * model is the raw slug rather than a catalog display name, because that is what
 * was recorded. Either half can be missing — Claude's spawns state a model but
 * no per-agent effort — so the line carries whatever is actually known.
 */
function agentIdentityMetaParts(item: SubagentProgressItem): ReadonlyArray<string> {
  return [item.model?.trim() || null, item.reasoningEffort?.trim() || null].filter(
    (part): part is string => part !== null,
  );
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
    // Identity first, then the running totals: a live row's meta line had the
    // width for both and was spending it on the elapsed clock alone. Leading
    // with the model also keeps the line still while the clock ticks.
    meta: [
      ...agentIdentityMetaParts(item),
      ...formatSubagentMetaParts(item, {
        context: details.context,
        elapsed: live ? formatElapsedDurationLabel(item.createdAt, nowMs) : null,
        includeCurrentTool: false,
      }),
    ],
    time: null,
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
    time: null,
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

/**
 * The mono meta for a finished agent in the history section: `model · effort ·
 * tokens`. The model is shown exactly as the provider stored it
 * (`claude-opus-5`) rather than resolved to a catalog display name -- history is
 * a record of what ran, and the raw slug is the thing that was recorded. Tokens
 * and effort only appear when known. When it ran is not in here: a history row
 * puts that on its own right edge, where a left-sidebar row does.
 */
function formatAgentHistoryMeta(item: SubagentProgressItem): ReadonlyArray<string> {
  const totalTokens = item.telemetry?.totalTokens ?? null;
  return [
    ...agentIdentityMetaParts(item),
    ...(totalTokens !== null && totalTokens > 0
      ? [`${formatContextWindowTokens(totalTokens)} tokens`]
      : []),
  ];
}

/**
 * A finished agent from an earlier turn. It renders through the same row as a
 * live branch — the dot dims itself once the status is `completed` — but its
 * meta is a record rather than a running total, and its signal line is what it
 * reported back rather than what it is doing now.
 */
function historyBranch(
  entry: ThreadSubagentHistoryEntry,
  nowMs: number | undefined,
): AgentSubagentBranch {
  const { item, resultBody } = entry;
  const details = deriveSubagentDisplayDetails(item);
  return {
    kind: "subagent",
    key: `history:${item.id}`,
    status: subagentBranchStatus(item.status),
    name: formatSubagentDisplayName(item),
    statusLabel: item.statusLabel,
    meta: formatAgentHistoryMeta(item),
    time: formatRelativeTimeLabel(item.updatedAt, nowMs ?? Date.now()),
    // What it was asked to do stays on the record for the row's tooltip; the row
    // itself spends its one prose line on what came back, which is the more
    // useful half and the same slot a live agent puts its progress in.
    task: details.goal,
    output: resultBody === null ? null : formatSubagentReceiptSummary(resultBody),
    tag: null,
    depth: Math.min(Math.max(item.treeDepth ?? 0, 0), MAX_BRANCH_DEPTH),
    item,
    transcriptAvailable: item.agentThreadId !== null,
  };
}

export interface AgentsPanelView {
  /** The turn's own branches, in attention order. */
  readonly current: ReadonlyArray<AgentBranch>;
  /** Agents from earlier in the thread, newest first. */
  readonly earlier: ReadonlyArray<AgentSubagentBranch>;
  /** False only when the thread has never run an agent at all. */
  readonly hasAny: boolean;
}

/**
 * The panel's whole list: the live turn on top, then everything this thread has
 * run before it. The two sources overlap — a live agent is also in the thread's
 * history — so the live record wins, since only it carries streaming output.
 */
export function buildAgentsPanelView(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  readonly history?: ReadonlyArray<ThreadSubagentHistoryEntry> | undefined;
  readonly providerLabel?: string | null | undefined;
  readonly nowMs?: number | undefined;
}): AgentsPanelView {
  const current = buildAgentBranches(input);
  const currentAgentKeys = new Set(input.subagents.map(subagentIdentity));
  const earlier = (input.history ?? [])
    .filter((entry) => !currentAgentKeys.has(subagentIdentity(entry.item)))
    .map((entry) => historyBranch(entry, input.nowMs))
    .toSorted(
      (left, right) =>
        (parseTimestamp(right.item.updatedAt) ?? 0) - (parseTimestamp(left.item.updatedAt) ?? 0),
    );

  return { current, earlier, hasAny: current.length > 0 || earlier.length > 0 };
}

/** `agentThreadId` is the id every other surface addresses an agent by; the
 *  record id is the fallback for an agent whose thread id never arrived. */
function subagentIdentity(item: SubagentProgressItem): string {
  return item.agentThreadId ?? item.id;
}

/** Resolves a drill-in against both sources, so a receipt for an agent that
 *  finished three turns ago opens its inspector just like a live one. */
export function findAgentsPanelSubagent(
  view: AgentsPanelView,
  agentThreadId: string | null,
): SubagentProgressItem | null {
  if (agentThreadId === null) {
    return null;
  }
  for (const branch of [...view.current, ...view.earlier]) {
    if (branch.kind === "subagent" && branch.item.agentThreadId === agentThreadId) {
      return branch.item;
    }
  }
  return null;
}

export interface LiveAgentStatusLine {
  readonly agentThreadId: string | null;
  readonly name: string;
  /** The freshest thing the agent has said it is doing. */
  readonly step: string;
}

/**
 * One line for the whole turn, no matter how many agents are running: the
 * freshest signal any live agent has emitted, named so it is clear whose it is.
 * A count of live agents already sits on the tracker row above; repeating a line
 * per agent would turn the conversation into the panel.
 */
export function formatLiveAgentStatusLine(
  subagents: ReadonlyArray<SubagentProgressItem>,
): LiveAgentStatusLine | null {
  let freshest: {
    readonly item: SubagentProgressItem;
    readonly step: string;
    readonly at: number;
  } | null = null;
  for (const item of subagents) {
    if (!isLiveAgentBranchStatus(subagentBranchStatus(item.status))) {
      continue;
    }
    const step = liveAgentStep(item);
    if (step === null) {
      continue;
    }
    const at = parseTimestamp(item.updatedAt) ?? 0;
    if (freshest === null || at >= freshest.at) {
      freshest = { item, step, at };
    }
  }
  if (freshest === null) {
    return null;
  }
  return {
    agentThreadId: freshest.item.agentThreadId,
    name: formatSubagentDisplayName(freshest.item),
    step: freshest.step,
  };
}

/** The provider's reported step, else the agent's own newest prose. */
function liveAgentStep(item: SubagentProgressItem): string | null {
  const step = item.telemetry?.step?.trim();
  if (step) {
    return step;
  }
  const line = item.liveBody
    ?.split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ? normalizeSubagentInlineText(line) : null;
}

export interface LiveAgentIndicator {
  /** How many agents are live right now; at least 1. */
  readonly count: number;
  /** How many of them are blocked on the user. Any at all turns the node amber,
   *  since that is the only state on the button that asks for something. */
  readonly waitingCount: number;
}

/**
 * What the closed sidebar's panel button says about agents. Null when nothing is
 * live, because the button then has nothing to add over its diffstat.
 */
export function summarizeLiveAgents(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
}): LiveAgentIndicator | null {
  const statuses = [
    ...input.subagents.map((item) => subagentBranchStatus(item.status)),
    ...input.backgroundRuns.map(backgroundRunBranchStatus),
  ].filter(isLiveAgentBranchStatus);
  if (statuses.length === 0) {
    return null;
  }
  return {
    count: statuses.length,
    waitingCount: statuses.filter((status) => status === "waiting").length,
  };
}

/**
 * The one line a finished agent's receipt shows in the conversation: the first
 * line of its result with the markdown that opens it stripped, so a report
 * that starts with `## Findings` or `- Fixed the thing` reads as prose in a
 * row that has no room for formatting.
 */
export function formatSubagentReceiptSummary(body: string): string | null {
  for (const rawLine of body.split("\n")) {
    const plain = rawLine
      .trim()
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/u, "")
      .replace(/[*_`]/gu, "")
      .trim();
    if (plain.length > 0) {
      return plain;
    }
  }
  return null;
}

/**
 * Whether the rail has anything live to show right now. The panel's header
 * node and the rail tab's node read from this so they never disagree.
 */
export function hasRunningAgentActivity(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
}): boolean {
  return (
    input.subagents.some((item) => subagentBranchStatus(item.status) === "running") ||
    input.backgroundRuns.some((run) => backgroundRunBranchStatus(run) === "running")
  );
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
 * The agents a turn's activity row summarizes.
 *
 * Live turn-agent state only describes the turn in flight: it is scoped to the
 * latest turn and drops settled agents once that turn ends, so after a reload it
 * knows nothing at all. A settled turn's tracker therefore reads the thread's
 * durable agent history — the same records the panel's history section lists,
 * each already tagged with the turn that spawned it.
 *
 * Both sources are consulted for every turn and the live record wins per agent,
 * because only it carries streaming status and telemetry. History then fills in
 * every agent the live state no longer knows about, which is all of them on a
 * cold load and none of them mid-turn.
 */
export function selectTurnAgents(input: {
  readonly live: ReadonlyArray<SubagentProgressItem>;
  readonly history: ReadonlyArray<ThreadSubagentHistoryEntry> | undefined;
  readonly turnIds: ReadonlySet<TurnId>;
}): ReadonlyArray<SubagentProgressItem> {
  const live = selectSubagentsForTurns(input.live, input.turnIds);
  if (input.history === undefined || input.history.length === 0) {
    return live;
  }
  const liveIdentities = new Set(live.map(subagentIdentity));
  return [
    ...live,
    ...selectSubagentsForTurns(
      input.history.map((entry) => entry.item),
      input.turnIds,
    ).filter((item) => !liveIdentities.has(subagentIdentity(item))),
  ];
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
