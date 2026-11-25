/**
 * Lightweight session-status and store-derivation helpers needed by the app
 * shell, sidebar, inbox, and root route at startup. Kept separate from
 * `session-logic.ts` so the startup bundle does not pull in chat timeline
 * rendering logic and chat-only `@threadlines/shared` modules.
 */
import {
  ApprovalRequestId,
  McpElicitation,
  type OrchestrationAwaitedBackgroundTask,
  type OrchestrationBackgroundTaskKind,
  type OrchestrationLatestTurn,
  type OrchestrationProposedPlanId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDiffStat,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderRequestKind,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  USER_INPUT_ACTIVITY_KINDS,
  approvalRequestKindFromRequestType,
  collectOpenPendingRequests,
} from "@threadlines/shared/pendingRequests";
import { compareTranscriptPosition } from "@threadlines/shared/transcriptOrder";
import * as Schema from "effect/Schema";

import type { ProposedPlan, ThreadSession, TurnDiffSummary } from "./types";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("fx"),
    label: "fx",
    available: true,
    pickerSidebarBadge: "new",
  },
  { value: ProviderDriverKind.make("cursor"), label: "Cursor", available: true },
  { value: ProviderDriverKind.make("opencode"), label: "OpenCode", available: true },
  { value: ProviderDriverKind.make("antigravity"), label: "Antigravity", available: true },
  {
    value: ProviderDriverKind.make("muse"),
    label: "Muse Code",
    available: true,
    pickerSidebarBadge: "new",
  },
  { value: ProviderDriverKind.make("grok"), label: "Grok", available: true },
  {
    value: ProviderDriverKind.make("pi"),
    label: "Pi",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: ProviderRequestKind;
  createdAt: string;
  /** The answers the provider accepts. Absent: all of them. */
  availableDecisions?: ReadonlyArray<ProviderApprovalDecision>;
  /** A risk the provider attached to an answer, shown with it. */
  decisionWarnings?: Partial<Record<ProviderApprovalDecision, string>>;
  environmentId?: string;
  /** Provider tool being approved (e.g. "Bash", "Agent"). Claude only. */
  toolName?: string;
  /** What is being approved: the command, path, or tool summary. */
  detail?: string;
  /** The agent's own sentence for the request ("Claude wants to read notes.txt"). */
  title?: string;
  /** Why the agent asks rather than going ahead. */
  reason?: string;
  /** What approving allows, in the agent's words. */
  description?: string;
  /** The file or folder that made the agent ask. */
  blockedPath?: string;
  /** The agent asks that this one not be approved by habit. */
  defaultToNo?: boolean;
  /** A workflow asking to run: its plan, from the script's own header. */
  workflow?: PendingWorkflowApproval;
}

export interface PendingWorkflowApproval {
  readonly name?: string;
  readonly description?: string;
  readonly phases: ReadonlyArray<{ readonly title: string; readonly detail?: string }>;
  /** The script, for "View script". Absent: Claude keeps it to itself. */
  readonly script?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
  elicitation?: McpElicitation;
  /** False when the agent keeps working while the question is open. Absent
   *  means the turn is paused on the answer. */
  isBlocking?: boolean;
  /** The card may offer Skip, Close and Reply in chat (UserInputRequestedPayload). */
  canLeaveUnanswered?: boolean;
}

/** Only a blocking question holds the turn; a non-blocking one is a question
 *  asked in passing while the agent keeps working. */
export function isBlockingUserInput(input: Pick<PendingUserInput, "isBlocking">): boolean {
  return input.isBlocking !== false;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  dismissedAt: string | null;
}

export type LatestTurnTiming = Pick<
  OrchestrationLatestTurn,
  "turnId" | "startedAt" | "completedAt"
>;
export type SessionLifecycleState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;
export type SessionBackgroundState = SessionLifecycleState &
  Partial<Pick<ThreadSession, "awaitedBackgroundTaskCount" | "awaitedBackgroundTasks">>;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionLifecycleState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

/**
 * The turn has settled but provider tasks the agent is waiting on (background
 * subagents, a test run) are still running and will start the thread back up
 * on their own. The thread is waiting, not finished, so it counts as live work
 * everywhere the app counts it: sidebar pill, taskbar badge, quit and update
 * warnings. A command left running on purpose, like a dev server, does not.
 */
export function isWaitingOnBackgroundTasks(
  latestTurn: LatestTurnTiming | null,
  session: SessionBackgroundState | null,
): boolean {
  return (session?.awaitedBackgroundTaskCount ?? 0) > 0 && isLatestTurnSettled(latestTurn, session);
}

/** The order a wait is told in: agents first, they are what users watch. */
const BACKGROUND_TASK_KIND_ORDER: ReadonlyArray<OrchestrationBackgroundTaskKind> = [
  "agent",
  "workflow",
  "command",
  "other",
];

const BACKGROUND_TASK_NOUNS: Readonly<
  Record<OrchestrationBackgroundTaskKind, readonly [singular: string, plural: string]>
> = {
  agent: ["agent", "agents"],
  workflow: ["workflow", "workflows"],
  command: ["command", "commands"],
  other: ["task", "tasks"],
};

/**
 * The tasks a session's agent is waiting on, agents first, when the server
 * described every one of them. Null when it did not: an older server, or a
 * provider that reports only how many there are. Says nothing about whether
 * the thread is waiting; pair it with {@link isWaitingOnBackgroundTasks}.
 */
export function describedAwaitedTasks(
  session: Pick<
    SessionBackgroundState,
    "awaitedBackgroundTaskCount" | "awaitedBackgroundTasks"
  > | null,
): ReadonlyArray<OrchestrationAwaitedBackgroundTask> | null {
  const tasks = session?.awaitedBackgroundTasks ?? [];
  const count = session?.awaitedBackgroundTaskCount ?? 0;
  if (count === 0 || tasks.length !== count) return null;
  return BACKGROUND_TASK_KIND_ORDER.flatMap((kind) => tasks.filter((task) => task.kind === kind));
}

function countAwaitedTasks(
  tasks: ReadonlyArray<OrchestrationAwaitedBackgroundTask>,
  kind: OrchestrationBackgroundTaskKind,
): number {
  return tasks.filter((task) => task.kind === kind).length;
}

function formatTaskCount(kind: OrchestrationBackgroundTaskKind, count: number): string {
  const [singular, plural] = BACKGROUND_TASK_NOUNS[kind];
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * What the tasks are, in words: "2 agents and 1 command". Only the given
 * kinds are told, so a surface that already shows the agents can name the
 * rest. Null when none of those kinds are there.
 */
export function formatAwaitedTasks(
  tasks: ReadonlyArray<OrchestrationAwaitedBackgroundTask>,
  kinds: ReadonlyArray<OrchestrationBackgroundTaskKind> = BACKGROUND_TASK_KIND_ORDER,
): string | null {
  const parts = BACKGROUND_TASK_KIND_ORDER.flatMap((kind) => {
    const count = kinds.includes(kind) ? countAwaitedTasks(tasks, kind) : 0;
    return count > 0 ? [formatTaskCount(kind, count)] : [];
  });
  if (parts.length === 0) return null;
  const last = parts.at(-1);
  return parts.length === 1 ? (last ?? null) : `${parts.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The one word a waiting thread's row spends on its wait. Agents name
 * themselves ("2 agents"), because a thread whose agents are still at work is
 * not idle; a workflow is a script of agents, so it is next, and a lone one
 * says how far it got ("Workflow 6/8"). A command, or a wait nobody
 * described, stays "waiting".
 */
export function formatBackgroundWaitWord(
  tasks: ReadonlyArray<OrchestrationAwaitedBackgroundTask> | null,
): string {
  if (tasks === null) return "waiting";
  const agents = countAwaitedTasks(tasks, "agent");
  if (agents > 0) return formatTaskCount("agent", agents);
  const workflows = tasks.filter((task) => task.kind === "workflow");
  const progress = workflows.length === 1 ? workflows[0]?.workflow : undefined;
  if (progress && progress.totalAgents > 0) {
    return `Workflow ${progress.doneAgents}/${progress.totalAgents}`;
  }
  if (workflows.length > 0) return formatTaskCount("workflow", workflows.length);
  return "waiting";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readWorkflowApprovalPreview(value: unknown): PendingWorkflowApproval | undefined {
  const preview = asRecord(value);
  if (!preview) return undefined;
  const phases = Array.isArray(preview.phases)
    ? preview.phases.flatMap((phase) => {
        const entry = asRecord(phase);
        const title = asTrimmedString(entry?.title);
        if (!title) return [];
        const detail = asTrimmedString(entry?.detail);
        return [{ title, ...(detail ? { detail } : {}) }];
      })
    : [];
  const name = asTrimmedString(preview.name);
  const description = asTrimmedString(preview.description);
  const script = typeof preview.script === "string" ? preview.script : undefined;
  return {
    phases,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(script ? { script } : {}),
  };
}

const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalDecision = Schema.is(ProviderApprovalDecision);
const isMcpElicitation = Schema.is(McpElicitation);

function readDecisionWarnings(
  value: unknown,
): Partial<Record<ProviderApprovalDecision, string>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const warnings: Partial<Record<ProviderApprovalDecision, string>> = {};
  for (const [decision, warning] of Object.entries(value)) {
    if (isProviderApprovalDecision(decision) && typeof warning === "string" && warning.trim()) {
      warnings[decision] = warning.trim();
    }
  }
  return Object.keys(warnings).length > 0 ? warnings : undefined;
}

/** The approval kind an activity carries, or derives from its request type. */
export function readApprovalRequestKind(payload: Record<string, unknown> | null) {
  return isProviderRequestKind(payload?.requestKind)
    ? payload.requestKind
    : approvalRequestKindFromRequestType(payload?.requestType);
}

export function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.eventSequence !== undefined || right.eventSequence !== undefined) {
    const position = compareTranscriptPosition(left, right);
    if (position !== 0) return position;
  }
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  return collectOpenPendingRequests(ordered, APPROVAL_ACTIVITY_KINDS)
    .toSorted((left, right) => compareActivitiesByOrder(left.activity, right.activity))
    .flatMap<PendingApproval>(({ requestId, activity }) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const requestKind = readApprovalRequestKind(payload);
      if (!requestKind) {
        return [];
      }
      const availableDecisions = Array.isArray(payload?.availableDecisions)
        ? payload.availableDecisions.filter(isProviderApprovalDecision)
        : undefined;
      const decisionWarnings = readDecisionWarnings(payload?.decisionWarnings);
      const text = (key: string) => {
        const value = payload?.[key];
        return typeof value === "string" && value.trim().length > 0 ? value : undefined;
      };
      const detail = text("detail");
      const title = text("title");
      const reason = text("reason");
      const description = text("description");
      const blockedPath = text("blockedPath");
      const toolName =
        payload && typeof payload.toolName === "string" ? payload.toolName : undefined;
      const environmentId =
        payload && typeof payload.environmentId === "string" ? payload.environmentId : undefined;
      const workflow = readWorkflowApprovalPreview(payload?.workflowPreview);
      return [
        {
          requestId: ApprovalRequestId.make(requestId),
          requestKind,
          createdAt: activity.createdAt,
          ...(environmentId ? { environmentId } : {}),
          ...(toolName ? { toolName } : {}),
          ...(detail ? { detail } : {}),
          ...(title ? { title } : {}),
          ...(reason ? { reason } : {}),
          ...(description ? { description } : {}),
          ...(blockedPath ? { blockedPath } : {}),
          ...(payload?.defaultToNo === true ? { defaultToNo: true } : {}),
          ...(workflow ? { workflow } : {}),
          ...(availableDecisions && availableDecisions.length > 0 ? { availableDecisions } : {}),
          ...(decisionWarnings ? { decisionWarnings } : {}),
        },
      ];
    });
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  return (
    collectOpenPendingRequests(ordered, USER_INPUT_ACTIVITY_KINDS)
      .toSorted((left, right) => compareActivitiesByOrder(left.activity, right.activity))
      .flatMap<PendingUserInput>(({ requestId, activity }) => {
        const payload =
          activity.payload && typeof activity.payload === "object"
            ? (activity.payload as Record<string, unknown>)
            : null;
        const elicitation = isMcpElicitation(payload?.elicitation)
          ? payload.elicitation
          : undefined;
        const questions = parseUserInputQuestions(payload);
        if (!questions && !elicitation) {
          return [];
        }
        return [
          {
            requestId: ApprovalRequestId.make(requestId),
            createdAt: activity.createdAt,
            questions: questions ?? [],
            ...(elicitation ? { elicitation } : {}),
            ...(typeof payload?.isBlocking === "boolean" ? { isBlocking: payload.isBlocking } : {}),
            ...(payload?.canLeaveUnanswered === true && !elicitation
              ? { canLeaveUnanswered: true }
              : {}),
          },
        ];
      })
      // Blocking questions first; the stable sort keeps transcript order within each group.
      .toSorted(
        (left, right) => Number(isBlockingUserInput(right)) - Number(isBlockingUserInput(left)),
      )
  );
}

export function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    dismissedAt: proposedPlan.dismissedAt,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          (left.eventSequence ?? -1) - (right.eventSequence ?? -1) ||
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        (left.eventSequence ?? -1) - (right.eventSequence ?? -1) ||
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function hasActionableProposedPlan(
  proposedPlan:
    | LatestProposedPlanState
    | Pick<ProposedPlan, "implementedAt" | "dismissedAt">
    | null,
): boolean {
  // `?? null` tolerates snapshots from older desktop servers whose plans
  // predate the dismissedAt field.
  return (
    proposedPlan !== null &&
    proposedPlan.implementedAt === null &&
    (proposedPlan.dismissedAt ?? null) === null
  );
}

/**
 * Total line delta for a thread's un-reverted turns, for a client that has turn
 * summaries but not the rollup. Starts from the newest counted turn that
 * carries a measurement (the thread's share of what was uncommitted when that
 * turn finished) and adds the file summaries of every counted turn after it,
 * so a running turn's live edits still move the number. Without any
 * measurement it sums every counted turn. Returns null when there is neither a
 * measurement nor a counted file, the same "nothing to say" the shell means by
 * null; a thread whose turns cancel out to zero still returns zeroes.
 *
 * `baselineTurnCount` mirrors the server rollup's baseline join: turns at or
 * below it were committed (or discarded) out of the checkout and no longer
 * count, measurements included. Zero counts every turn, since turn counts
 * start at 1. A summary without a turn count predates the field and is always
 * counted, which is the behavior it had before the baseline existed.
 */
export function sumTurnDiffStats(
  summaries: ReadonlyArray<TurnDiffSummary>,
  baselineTurnCount = 0,
): OrchestrationThreadDiffStat | null {
  const counted = summaries.filter(
    (summary) =>
      summary.checkpointTurnCount === undefined || summary.checkpointTurnCount > baselineTurnCount,
  );
  let measurement: { turnCount: number; stat: OrchestrationThreadDiffStat } | null = null;
  for (const summary of counted) {
    if (
      summary.threadDiffStat !== undefined &&
      summary.checkpointTurnCount !== undefined &&
      (measurement === null || summary.checkpointTurnCount > measurement.turnCount)
    ) {
      measurement = { turnCount: summary.checkpointTurnCount, stat: summary.threadDiffStat };
    }
  }

  let additions = measurement?.stat.additions ?? 0;
  let deletions = measurement?.stat.deletions ?? 0;
  let sawFile = false;
  for (const summary of counted) {
    if (
      measurement !== null &&
      (summary.checkpointTurnCount === undefined ||
        summary.checkpointTurnCount <= measurement.turnCount)
    ) {
      continue;
    }
    for (const file of summary.files) {
      sawFile = true;
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
  }
  return measurement !== null || sawFile ? { additions, deletions } : null;
}
