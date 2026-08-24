/**
 * View-models for the agents panel: the current turn's orchestration drawn as
 * a thread. Everything the panel renders — ordering, status, the mono meta
 * line, the turn row's one-line summary — is decided here so the component
 * stays a pure projection of it.
 */
import type { TurnId } from "@threadlines/contracts";
import { formatDiffLineStats } from "@threadlines/shared/diffStats";

import {
  formatSubagentDisplayName,
  type SubagentProgressItem,
  type ThreadSubagentHistoryEntry,
} from "../../session-logic";
import { formatContextWindowTokensCompact } from "../../lib/contextWindow";
import { pluralize } from "../../lib/utils";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { formatSubagentMetaParts, formatSubagentDuration } from "./subagentMeta";
import {
  deriveSubagentDisplayDetails,
  normalizeSubagentInlineText,
  type ThreadBackgroundRunItem,
} from "./threadActivity";

/**
 * What the branch's status dot says. `waiting` is the only one that asks
 * something of the user, while `stopped` records unfinished work without
 * presenting it as a failure.
 */
export type AgentBranchStatus = "running" | "waiting" | "failed" | "stopped" | "completed";

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
  /** The background run this agent is, for agents the provider launched as a
   *  shell command (a `codex exec` in the background). It carries the only
   *  stop handle the row has, so the row lends it the run rows' stop arm.
   *  Null once the agent has settled, and for every provider-native agent. */
  readonly stoppableRun: ThreadBackgroundRunItem | null;
}

/** Background command runs are not agents and never appear in this panel —
 *  the header's activity chip is their surface (rows, terminal toggle, stop).
 *  The alias survives so branch consumers keep reading as "any branch". */
export type AgentBranch = AgentSubagentBranch;

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
  stopped: 3,
  completed: 4,
};

export function subagentBranchStatus(status: SubagentProgressItem["status"]): AgentBranchStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "interrupted") {
    return "stopped";
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

/**
 * `+401 −1`: how much the agent actually wrote, summed over its own edits. Sits
 * last on the line, where the thread's own counts sit in the left sidebar, and
 * is absent until the agent has changed something.
 */
function agentDiffMetaParts(item: SubagentProgressItem): ReadonlyArray<string> {
  const label = formatDiffLineStats({
    additions: item.telemetry?.additions ?? 0,
    deletions: item.telemetry?.deletions ?? 0,
  });
  return label === null ? [] : [label];
}

function subagentBranch(
  item: SubagentProgressItem,
  nowMs: number | undefined,
  runsBySpawnCallId?: ReadonlyMap<string, ThreadBackgroundRunItem>,
): AgentSubagentBranch {
  const status = subagentBranchStatus(item.status);
  const details = deriveSubagentDisplayDetails(item);
  const live = isLiveAgentBranchStatus(status);
  const stoppableRun =
    live && item.spawnCallId ? (runsBySpawnCallId?.get(item.spawnCallId) ?? null) : null;
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
      ...agentDiffMetaParts(item),
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
    stoppableRun: stoppableRun !== null && stoppableRun.canStop ? stoppableRun : null,
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
  /** Background runs that are already listed as subagents, keyed by the tool
   *  call that launched them. Lends each matching row its stop handle. */
  readonly subagentRuns?: ReadonlyMap<string, ThreadBackgroundRunItem> | undefined;
  readonly nowMs?: number | undefined;
}): ReadonlyArray<AgentBranch> {
  const branches = input.subagents.map((item) => ({
    branch: subagentBranch(item, input.nowMs, input.subagentRuns),
    startedAtMs: parseTimestamp(item.createdAt),
  }));

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
      ? [`${formatContextWindowTokensCompact(totalTokens)} tokens`]
      : []),
    ...agentDiffMetaParts(item),
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
    // A filed-away agent is not running, so there is nothing to stop.
    stoppableRun: null,
  };
}

export interface AgentsPanelView {
  /** The turn's own agents, in attention order. */
  readonly current: ReadonlyArray<AgentBranch>;
  /** Agents from earlier in the thread, newest first. */
  readonly earlier: ReadonlyArray<AgentSubagentBranch>;
  /** False only when the thread has never run an agent at all. Background
   *  command runs do not appear in this panel at all — the header's activity
   *  chip is their surface. */
  readonly hasAny: boolean;
}

/**
 * What the panel's own header says it is showing: the provider whose agents
 * these are, how many are working, how many want something, and how much of the
 * list is already finished. The row otherwise carried a pulsing dot and a
 * duration with nothing between them naming what was pulsing.
 */
export function formatAgentsPanelSummary(
  view: AgentsPanelView,
  providerLabel?: string | null | undefined,
): string | null {
  if (!view.hasAny) {
    return null;
  }

  const subagents = view.current.filter(
    (branch): branch is AgentSubagentBranch => branch.kind === "subagent",
  );
  const runningCount = subagents.filter((branch) => branch.status === "running").length;
  const waitingCount = subagents.filter((branch) => branch.status === "waiting").length;

  const parts = [
    providerDisplayLabel(providerLabel),
    runningCount > 0 ? `${runningCount} running` : null,
    waitingCount > 0 ? `${waitingCount} needs you` : null,
    view.earlier.length > 0 ? `${view.earlier.length} earlier` : null,
  ].filter((part): part is string => part !== null);

  // A finished turn whose agents have not aged into "earlier" yet would leave
  // only the provider's name, which says nothing the rows do not.
  return parts.length > 1 ? parts.join(" · ") : (parts[0] ?? null);
}

/** `codex` as the panel says it: the provider's own name, capitalised. */
function providerDisplayLabel(providerLabel: string | null | undefined): string | null {
  const provider = providerLabel?.trim();
  if (!provider) {
    return null;
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The panel's whole list: the live turn on top, then everything this thread has
 * run before it. The two sources overlap — a live agent is also in the thread's
 * history — so the live record wins, since only it carries streaming output.
 */
export function buildAgentsPanelView(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  readonly subagentRuns?: ReadonlyMap<string, ThreadBackgroundRunItem> | undefined;
  readonly history?: ReadonlyArray<ThreadSubagentHistoryEntry> | undefined;
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

  return {
    current,
    earlier,
    hasAny: current.length > 0 || earlier.length > 0,
  };
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

export type LiveAgentBranchStatus = Extract<AgentBranchStatus, "running" | "waiting">;

export interface LiveAgentStatusRow {
  readonly id: string;
  readonly agentThreadId: string | null;
  readonly name: string;
  /** The freshest thing the agent has said it is doing. */
  readonly step: string;
  readonly status: LiveAgentBranchStatus;
}

export interface LiveAgentStatusRoster {
  readonly rows: ReadonlyArray<LiveAgentStatusRow>;
  readonly hiddenCount: number;
}

const DEFAULT_LIVE_AGENT_STATUS_LIMIT = 3;

/**
 * A stable, compact roster for the turn's live agents. It follows the panel's
 * status/start-time order rather than update time, so one agent reporting a new
 * step cannot displace another agent's row.
 */
export function formatLiveAgentStatusRows(
  subagents: ReadonlyArray<SubagentProgressItem>,
  limit: number = DEFAULT_LIVE_AGENT_STATUS_LIMIT,
): LiveAgentStatusRoster {
  const liveBranches = buildAgentBranches({ subagents }).filter((branch) =>
    isLiveAgentBranchStatus(branch.status),
  );
  const visibleLimit = Math.max(0, Math.trunc(limit));

  return {
    rows: liveBranches.slice(0, visibleLimit).map((branch) => ({
      id: branch.item.id,
      agentThreadId: branch.item.agentThreadId,
      name: branch.name,
      step:
        liveAgentStep(branch.item) ??
        (branch.status === "waiting" ? "Needs input" : branch.statusLabel.trim() || "Working"),
      status: branch.status === "waiting" ? "waiting" : "running",
    })),
    hiddenCount: Math.max(0, liveBranches.length - visibleLimit),
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
}): LiveAgentIndicator | null {
  // Background command runs deliberately do not count: a CI watcher is not an
  // agent, and every live-agent affordance keyed off this (tab dot, closed
  // panel node, launcher counts) would otherwise claim one is working.
  const statuses = input.subagents
    .map((item) => subagentBranchStatus(item.status))
    .filter(isLiveAgentBranchStatus);
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
/** Whether an actual agent is running. Background command runs do not count —
 *  see summarizeLiveAgents — so the Agents tab's live dot and its auto-open
 *  never fire for a plain background command. */
export function hasRunningAgentActivity(input: {
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
}): boolean {
  return input.subagents.some((item) => subagentBranchStatus(item.status) === "running");
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

/** The subagents a turnless activity group references by spawn call. A
 *  background agent's stream lands between turns, so the group at the tail of
 *  the conversation can only name its agents through the spawn ids its rows
 *  carry. Matches every identity a roster item answers to: Claude reuses the
 *  spawn tool_use id as the agent id, Codex children have their own ids. */
function selectSubagentsForSpawnIds(
  subagents: ReadonlyArray<SubagentProgressItem>,
  spawnCallIds: ReadonlySet<string>,
): ReadonlyArray<SubagentProgressItem> {
  if (spawnCallIds.size === 0) {
    return [];
  }
  return subagents.filter(
    (item) =>
      (item.spawnCallId != null && spawnCallIds.has(item.spawnCallId)) ||
      spawnCallIds.has(item.id) ||
      (item.agentThreadId !== null && spawnCallIds.has(item.agentThreadId)),
  );
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
  /** Spawn-call fallback for turnless groups; see selectSubagentsForSpawnIds. */
  readonly spawnCallIds?: ReadonlySet<string>;
}): ReadonlyArray<SubagentProgressItem> {
  const spawnCallIds = input.spawnCallIds ?? new Set<string>();
  const select = (subagents: ReadonlyArray<SubagentProgressItem>) => {
    const byTurn = selectSubagentsForTurns(subagents, input.turnIds);
    const turnIdentities = new Set(byTurn.map(subagentIdentity));
    return [
      ...byTurn,
      // The spawn fallback only names agents no turn claims. An agent with a
      // turn attribution is already summarized by the group that owns that
      // turn's tracker; re-selecting it here would render a second "Agent
      // working" tracker under the turnless tail group its background stream
      // creates below the settled response.
      ...selectSubagentsForSpawnIds(subagents, spawnCallIds).filter(
        (item) => item.turnId === null && !turnIdentities.has(subagentIdentity(item)),
      ),
    ];
  };
  const live = select(input.live);
  if (input.history === undefined || input.history.length === 0) {
    return live;
  }
  const liveIdentities = new Set(live.map(subagentIdentity));
  return [
    ...live,
    ...select(input.history.map((entry) => entry.item)).filter(
      (item) => !liveIdentities.has(subagentIdentity(item)),
    ),
  ];
}

/**
 * The turn row's compact read: how many agents ran, how they settled, and how
 * many are asking for something. Counts that are zero stay out of the line.
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
  const runningCount = countOf("running");
  const stoppedCount = countOf("stopped");
  const waitingCount = countOf("waiting");
  const hasMixedStates = doneCount + failedCount + stoppedCount + waitingCount > 0;

  const parts = [
    pluralize(statuses.length, "subagent"),
    runningCount > 0 && hasMixedStates ? `${runningCount} running` : null,
    doneCount > 0 ? `${doneCount} done` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
    stoppedCount > 0 ? `${stoppedCount} stopped` : null,
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
    totalTokens > 0 ? `${formatContextWindowTokensCompact(totalTokens)} tokens` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : null;
}
