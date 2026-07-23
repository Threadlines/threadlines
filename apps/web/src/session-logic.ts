import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadForkContextPayload,
  ThreadForkSeedOutcomeActivityKind,
  type ThreadForkSeedOutcomePayload,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import { countUnifiedDiffStats, type FileChangeStat } from "@threadlines/shared/diffStats";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import {
  isProviderAuthErrorMessage,
  providerAuthReconnectCommand,
} from "@threadlines/shared/providerAuth";
import {
  extensionMcpOAuthActionIntent,
  extensionMcpOAuthActionLabel,
  providerMcpLoginCommand,
  type ExtensionMcpLoginProvider,
  type ExtensionMcpOAuthActionIntent,
} from "./mcpAuthStatus";
import { filterSupersededManualContextCompactionActivities } from "./lib/contextCompactionActivities";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

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
];

export interface WorkLogImagePreview {
  id: string;
  name: string;
  previewUrl: string;
}

export interface ProviderAuthReconnectAction {
  provider: ProviderDriverKind;
  command: string;
  message: string;
}

export interface McpAuthReconnectAction {
  provider: ProviderDriverKind;
  providerInstanceId?: ProviderInstanceId | undefined;
  serverName: string;
  serverLabel: string;
  intent: ExtensionMcpOAuthActionIntent;
  actionLabel: string;
  message: string;
  terminalCommand: string;
}

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  /** Provider-stamped lifecycle completion time. Combined with `createdAt`
   *  after started/completed rows collapse to produce an accurate duration. */
  completedAt?: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  /** Tail of the streamed command output, retained for inline failure
   *  context and the expandable output view on command rows. */
  outputPreview?: string;
  exitCode?: number;
  changedFiles?: ReadonlyArray<string>;
  /** Exact per-file +/- counts reported by the provider for this tool call.
   *  Preferred over checkpoint-derived turn diffs when present. */
  changedFileStats?: ReadonlyArray<FileChangeStat>;
  images?: ReadonlyArray<WorkLogImagePreview>;
  tone: "thinking" | "tool" | "info" | "warning" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  /** Whether a subagent tool row creates an agent or only coordinates one.
   *  Coordination calls stay in the transcript without inflating delegation
   *  counts in the compact activity summary. */
  subagentOperation?: "delegation" | "coordination";
  /** Set when this row narrates a spawned subagent's own activity rather than
   *  the main model's. Drives the indented child-row rendering in the
   *  timeline. */
  subagentTask?: { subagentType: string | null; toolUseId: string | null };
  /** Provider tool call id backing this row, when the activity carried one.
   *  Lets the timeline correlate a subagent lane with its spawn row. */
  toolCallId?: string;
  /** Provider agent ids spawned by this collab tool call, correlated from
   *  task activities. Drives the on-demand nested transcript fetch. */
  spawnedAgentIds?: ReadonlyArray<string>;
  requestKind?: PendingApproval["requestKind"];
  executionState?: "running" | "completed" | "failed";
  authReconnect?: ProviderAuthReconnectAction;
  mcpAuthReconnect?: McpAuthReconnectAction;
  providerLifecyclePhase?: "preparing" | "waiting-for-model";
  turnId?: TurnId | null;
  modelFallback?: ModelFallbackState;
}

export interface ModelFallbackState {
  requestedModel: string;
  activeModel: string;
  reason: string | null;
  detail: string | null;
  createdAt: string;
  turnId: TurnId | null;
}

export type ActiveModelFallbackState = ModelFallbackState;

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  redactedThinking?: boolean;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change" | "permissions";
  createdAt: string;
  environmentId?: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
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

export type SubagentProgressStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export interface SubagentProgressItem {
  id: string;
  agentThreadId: string | null;
  /** Stable V2 hierarchy path (for example `/root/research/database`). */
  agentPath?: string | null;
  parentAgentPath?: string | null;
  /** Visual nesting below the first child of `/root`. */
  treeDepth?: number;
  turnId: TurnId | null;
  label: string;
  nickname?: string | null;
  role: string | null;
  objective: string | null;
  status: SubagentProgressStatus;
  statusLabel: string;
  model: string | null;
  reasoningEffort: string | null;
  /** Latest streamed message from the still-running agent
   *  (`forwardSubagentText`); null once the terminal result lands. */
  liveBody: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentProgressBadgeState {
  label: string;
  ariaLabel: string;
  tone: "active" | "complete" | "warning" | "idle";
  pulse: boolean;
}

export interface SubagentProgressState {
  items: SubagentProgressItem[];
  activeCount: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  summary: string;
  badge: SubagentProgressBadgeState;
}

export interface SubagentResultEntry {
  id: string;
  createdAt: string;
  turnId: TurnId | null;
  agentThreadId: string;
  label: string;
  nickname?: string | null;
  role: string | null;
  objective: string | null;
  body: string;
  model: string | null;
  reasoningEffort: string | null;
}

export interface SubagentLiveEntry {
  id: string;
  createdAt: string;
  turnId: TurnId | null;
  agentThreadId: string;
  label: string;
  nickname?: string | null;
  role: string | null;
  objective: string | null;
  body: string;
  model: string | null;
  reasoningEffort: string | null;
}

export function formatSubagentDisplayName(input: {
  label: string;
  nickname?: string | null;
  role?: string | null;
}): string {
  const nickname = asTrimmedString(input.nickname);
  if (nickname) {
    return nickname;
  }

  const role = asTrimmedString(input.role);
  if (role) {
    return formatSubagentNameToken(role) ?? "Subagent";
  }

  const label = asTrimmedString(input.label);
  const labelWithoutSuffix = label?.replace(/\s+subagent$/iu, "").trim();
  if (labelWithoutSuffix && labelWithoutSuffix.toLowerCase() !== "subagent") {
    return labelWithoutSuffix;
  }

  return "Subagent";
}

export function shouldShowSubagentDisplayChip(input: {
  label: string;
  nickname?: string | null;
  role?: string | null;
}): boolean {
  return formatSubagentDisplayName(input) !== "Subagent";
}

export interface ForkContextEntry {
  id: string;
  createdAt: string;
  payload: ThreadForkContextPayload;
  /** How the forked session was actually seeded, from the reactor's
   *  `thread.fork.seed-outcome` activity. Absent until that turn settles
   *  (and on threads forked before the outcome activity existed). */
  seedMode?: ThreadForkSeedOutcomePayload["seedMode"];
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      id: string;
      kind: "subagent-result";
      createdAt: string;
      result: SubagentResultEntry;
    }
  | {
      id: string;
      kind: "subagent-live";
      createdAt: string;
      live: SubagentLiveEntry;
    }
  | {
      id: string;
      kind: "fork-context";
      createdAt: string;
      forkContext: ForkContextEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionLifecycleState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;
type SessionActivityState = SessionLifecycleState & Partial<Pick<ThreadSession, "updatedAt">>;

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

export function deriveActiveModelFallbackState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): ActiveModelFallbackState | null {
  if (latestTurn?.state !== "running") {
    return null;
  }

  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const activity = ordered[index];
    if (!activity || activity.kind !== "provider.model.rerouted") {
      continue;
    }
    if (activity.turnId !== null && activity.turnId !== latestTurn.turnId) {
      continue;
    }

    const payload = asRecord(activity.payload);
    const modelFallback = deriveModelFallbackFromActivity(activity, payload);
    if (!modelFallback) {
      continue;
    }
    return modelFallback;
  }

  return null;
}

function deriveModelFallbackFromActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): ModelFallbackState | null {
  if (activity.kind !== "provider.model.rerouted") {
    return null;
  }
  const requestedModel = asTrimmedString(payload?.fromModel);
  const activeModel = asTrimmedString(payload?.toModel);
  if (!requestedModel || !activeModel) {
    return null;
  }
  return {
    requestedModel,
    activeModel,
    reason: asTrimmedString(payload?.reason),
    detail: asTrimmedString(payload?.detail),
    createdAt: activity.createdAt,
    turnId: activity.turnId,
  };
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (session?.orchestrationStatus === "starting") {
    return sendStartedAt ?? session.updatedAt ?? null;
  }
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt;
    }
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

export function deriveActiveStatusLabel(input: {
  phase: SessionPhase;
  workLogEntries: ReadonlyArray<WorkLogEntry>;
  latestTurnId?: TurnId | null;
  isConnecting?: boolean;
  isSendBusy?: boolean;
  isPreparingWorktree?: boolean;
  isRevertingCheckpoint?: boolean;
  pendingApprovalCount?: number;
  pendingUserInputCount?: number;
  isSessionStarting?: boolean;
}): string {
  if (input.isRevertingCheckpoint) return "Reverting checkpoint";
  if (input.isPreparingWorktree) return "Preparing worktree";
  if ((input.pendingUserInputCount ?? 0) > 0) return "Waiting for input";
  if ((input.pendingApprovalCount ?? 0) > 0) return "Waiting for approval";
  if (input.isSessionStarting) return "Preparing turn";
  if (input.phase === "connecting" || input.isConnecting) return "Connecting";
  if (input.isSendBusy) return input.phase === "disconnected" ? "Connecting" : "Sending";
  if (input.phase === "running") return "Working";

  return "Working";
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "permissions_approval":
      return "permissions";
    default:
      return null;
  }
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  return collectOpenPendingRequests(ordered, APPROVAL_ACTIVITY_KINDS)
    .flatMap<PendingApproval>(({ requestId, activity }) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const requestKind =
        payload &&
        (payload.requestKind === "command" ||
          payload.requestKind === "file-read" ||
          payload.requestKind === "file-change" ||
          payload.requestKind === "permissions")
          ? payload.requestKind
          : payload
            ? requestKindFromRequestType(payload.requestType)
            : null;
      if (!requestKind) {
        return [];
      }
      const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
      const environmentId =
        payload && typeof payload.environmentId === "string" ? payload.environmentId : undefined;
      return [
        {
          requestId: ApprovalRequestId.make(requestId),
          requestKind,
          createdAt: activity.createdAt,
          ...(environmentId ? { environmentId } : {}),
          ...(detail ? { detail } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
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
      if (options.length === 0) {
        return null;
      }
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

  return collectOpenPendingRequests(ordered, USER_INPUT_ACTIVITY_KINDS)
    .flatMap<PendingUserInput>(({ requestId, activity }) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          requestId: ApprovalRequestId.make(requestId),
          createdAt: activity.createdAt,
          questions,
        },
      ];
    })
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
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
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
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

interface InternalSubagentRecord extends SubagentProgressItem {
  liveBodyUpdatedAt: string | null;
  resultActivityId: string | null;
  resultBody: string | null;
  resultCreatedAt: string | null;
}

interface CollabAgentStateSnapshot {
  status: string | null;
  message: string | null;
}

export function deriveSubagentProgressState(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  latestTurnId?: TurnId | null | undefined;
  latestTurnSettled?: boolean | undefined;
}): SubagentProgressState | null {
  const records = collectSubagentActivityRecords(input.activities, {
    latestTurnId: input.latestTurnId ?? null,
  });
  // Finished agents remain useful while their parent turn is still running:
  // they explain a shrinking active count and make the completed badge/state
  // reachable. Once the turn settles, successful agents clear with the rest
  // of the transient activity UI while failures remain actionable.
  const visibleRecords = records.filter(
    (record) => record.status !== "completed" || input.latestTurnSettled === false,
  );
  const items = visibleRecords.map(
    ({
      liveBodyUpdatedAt: _liveBodyUpdatedAt,
      resultActivityId: _resultActivityId,
      resultBody: _resultBody,
      resultCreatedAt: _resultCreatedAt,
      ...item
    }) => item,
  );
  if (items.length === 0) {
    return null;
  }

  const activeCount = items.filter((item) => isActiveSubagentStatus(item.status)).length;
  const failedCount = items.filter((item) => isFailedSubagentStatus(item.status)).length;
  if (input.latestTurnSettled === true && activeCount === 0 && failedCount === 0) {
    return null;
  }

  const completedCount = items.filter((item) => item.status === "completed").length;
  const totalCount = items.length;
  const summary = summarizeSubagentProgress({
    activeCount,
    completedCount,
    failedCount,
    totalCount,
  });
  const badge = deriveSubagentProgressBadge({
    activeCount,
    completedCount,
    failedCount,
    totalCount,
  });

  return {
    items,
    activeCount,
    completedCount,
    failedCount,
    totalCount,
    summary,
    badge,
  };
}

export function deriveSubagentResultEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SubagentResultEntry[] {
  return collectSubagentActivityRecords(activities, {})
    .filter(
      (
        record,
      ): record is InternalSubagentRecord & {
        agentThreadId: string;
        resultActivityId: string;
        resultBody: string;
        resultCreatedAt: string;
      } =>
        record.agentThreadId !== null &&
        record.resultActivityId !== null &&
        record.resultBody !== null &&
        record.resultCreatedAt !== null,
    )
    .map((record) => ({
      id: `subagent-result:${record.turnId ?? "no-turn"}:${record.agentThreadId}`,
      createdAt: record.resultCreatedAt,
      turnId: record.turnId,
      agentThreadId: record.agentThreadId,
      label: record.label,
      ...(record.nickname ? { nickname: record.nickname } : {}),
      role: record.role,
      objective: record.objective,
      body: record.resultBody,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
    }))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Latest streamed commentary for each still-running child agent. These rows
 *  are transient: the terminal result clears `liveBody` and replaces them
 *  with the durable subagent-result row. */
export function deriveSubagentLiveEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SubagentLiveEntry[] {
  return collectSubagentActivityRecords(activities, {})
    .filter(
      (
        record,
      ): record is InternalSubagentRecord & {
        agentThreadId: string;
        liveBody: string;
        liveBodyUpdatedAt: string;
      } =>
        record.agentThreadId !== null &&
        record.liveBody !== null &&
        record.liveBodyUpdatedAt !== null &&
        isActiveSubagentStatus(record.status),
    )
    .map((record) => ({
      id: `subagent-live:${record.turnId ?? "no-turn"}:${record.agentThreadId}`,
      createdAt: record.liveBodyUpdatedAt,
      turnId: record.turnId,
      agentThreadId: record.agentThreadId,
      label: record.label,
      ...(record.nickname ? { nickname: record.nickname } : {}),
      role: record.role,
      objective: record.objective,
      body: record.liveBody,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
    }))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function asForkContextPayload(payload: unknown): ThreadForkContextPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  if (
    typeof record.sourceThreadId !== "string" ||
    typeof record.sourceThreadTitle !== "string" ||
    typeof record.sourceMessageId !== "string" ||
    typeof record.sourceMessageRole !== "string" ||
    typeof record.sourceMessageText !== "string" ||
    typeof record.sourceMessageCreatedAt !== "string" ||
    record.workspaceMode !== "current" ||
    typeof record.includedMessageCount !== "number" ||
    typeof record.includedToolSummaryCount !== "number" ||
    typeof record.includedAttachmentCount !== "number" ||
    typeof record.omittedAttachmentCount !== "number" ||
    typeof record.contextText !== "string" ||
    !Array.isArray(record.attachments) ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  return record as unknown as ThreadForkContextPayload;
}

function asForkSeedMode(payload: unknown): ThreadForkSeedOutcomePayload["seedMode"] | null {
  const seedMode = asRecord(payload)?.seedMode;
  return seedMode === "provider-native" || seedMode === "context-seed" ? seedMode : null;
}

export function deriveForkContextEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ForkContextEntry[] {
  // A forked thread carries a single fork-context activity; the seed outcome
  // arrives as a separate activity once the initial turn dispatch settles.
  const seedMode = activities
    .filter((activity) => activity.kind === ThreadForkSeedOutcomeActivityKind)
    .map((activity) => asForkSeedMode(activity.payload))
    .findLast((mode) => mode !== null);
  return activities
    .filter((activity) => activity.kind === "thread.fork.context")
    .flatMap((activity) => {
      const payload = asForkContextPayload(activity.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          id: activity.id,
          createdAt: activity.createdAt,
          payload,
          ...(seedMode != null ? { seedMode } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function collectSubagentActivityRecords(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { latestTurnId?: TurnId | null | undefined },
): InternalSubagentRecord[] {
  const byAgentId = new Map<string, InternalSubagentRecord>();
  const pendingSpawnKeysByCallId = new Map<string, string>();
  const latestTurnId = options.latestTurnId ?? null;
  const sortedActivities = [...activities].toSorted(compareActivitiesByOrder);

  // Background agents keep reporting through task.* activities after their
  // spawn turn settles. Spawns linked to a still-live task bypass turn scoping
  // below so the popover keeps showing them until the task completes.
  const liveBackgroundTaskToolUseIds = new Set<string>();
  for (const activity of sortedActivities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const toolUseId = asTrimmedString(asRecord(activity.payload)?.toolUseId);
    if (!toolUseId) {
      continue;
    }
    if (activity.kind === "task.completed") {
      liveBackgroundTaskToolUseIds.delete(toolUseId);
    } else {
      liveBackgroundTaskToolUseIds.add(toolUseId);
    }
  }

  for (const activity of sortedActivities) {
    const inLatestTurn = latestTurnId === null || activity.turnId === latestTurnId;

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    if (payload === null) {
      continue;
    }

    // Background agents settle between prompts, so their task.completed lands
    // in a different (or no) turn. It links back via toolUseId and only
    // updates already-known records, so it bypasses turn scoping.
    if (activity.kind === "task.completed") {
      applySubagentTaskCompletion(byAgentId, activity, payload);
      continue;
    }

    if (extractWorkLogItemType(payload) !== "collab_agent_tool_call") {
      continue;
    }

    const data = asRecord(payload?.data);
    const item = asRecord(data?.item) ?? asClaudeSubagentActivityItem({ activity, payload, data });
    if (!item) {
      continue;
    }

    const toolCallId =
      asTrimmedString(item.id) ??
      asTrimmedString(data?.itemId) ??
      asTrimmedString(payload?.toolCallId) ??
      activity.id;
    const tool = asTrimmedString(item.tool)?.trim() ?? null;
    const prompt = asTrimmedString(item.prompt) ?? asTrimmedString(payload?.detail);
    const model = asTrimmedString(item.model);
    const reasoningEffort = asTrimmedString(item.reasoningEffort);
    const receiverThreadIds = stringArray(item.receiverThreadIds);
    const agentStates = extractCollabAgentStates(item.agentsStates);
    const agentIds = uniqueStrings([...receiverThreadIds, ...agentStates.keys()]);
    const resolvedAgentIds =
      agentIds.length > 0 ? agentIds : isSpawnAgentTool(tool) ? [`pending:${toolCallId}`] : [];
    const pendingKey = pendingSpawnKeysByCallId.get(toolCallId);
    const firstConcreteAgentId = resolvedAgentIds.find(
      (agentId) => !agentId.startsWith("pending:"),
    );
    if (pendingKey && firstConcreteAgentId) {
      const pendingRecord = byAgentId.get(pendingKey);
      if (pendingRecord) {
        byAgentId.set(firstConcreteAgentId, {
          ...pendingRecord,
          id: firstConcreteAgentId,
          agentThreadId: firstConcreteAgentId,
          updatedAt: activity.createdAt,
        });
        byAgentId.delete(pendingKey);
      }
      pendingSpawnKeysByCallId.delete(toolCallId);
    }

    for (const agentId of resolvedAgentIds) {
      const previous = byAgentId.get(agentId);
      // Turn scoping applies to where an agent is spawned. Later lifecycle
      // activities for a known agent (e.g. a background agent's completion
      // replayed after its turn ended) still update the record, and spawns
      // with a live background task stay visible across turns.
      if (!inLatestTurn && previous === undefined && !liveBackgroundTaskToolUseIds.has(agentId)) {
        continue;
      }
      const pendingAgent = agentId.startsWith("pending:");
      if (pendingAgent) {
        pendingSpawnKeysByCallId.set(toolCallId, agentId);
      }
      const state = agentStates.get(agentId) ?? null;
      const stateStatus = state?.status ?? null;
      const stateMessage = state?.message ?? null;
      const itemStatus = asTrimmedString(item.status) ?? asTrimmedString(payload?.status);
      const status = normalizeSubagentProgressStatus({
        tool,
        itemStatus,
        stateStatus,
      });
      const parsedObjective = parseSubagentObjective(prompt);
      const pathMetadata = deriveSubagentPathMetadata(
        asTrimmedString(item.agentPath) ?? previous?.agentPath ?? null,
      );
      const role =
        asTrimmedString(item.agentRole) ??
        asTrimmedString(item.role) ??
        parsedObjective.role ??
        subagentRoleFromAgentPath(pathMetadata?.agentPath ?? null) ??
        previous?.role ??
        null;
      const nickname =
        asTrimmedString(item.agentNickname) ??
        asTrimmedString(item.agent_nickname) ??
        asTrimmedString(item.nickname) ??
        previous?.nickname ??
        null;
      const label = subagentDisplayLabel({
        role,
        nickname: null,
      });
      const objective = parsedObjective.objective ?? prompt ?? previous?.objective ?? null;
      const terminalResult = isTerminalSubagentResult({
        itemStatus,
        stateStatus,
        stateMessage,
      });
      const resultBody = terminalResult ? stateMessage : (previous?.resultBody ?? null);
      const resultCreatedAt = terminalResult
        ? activity.createdAt
        : (previous?.resultCreatedAt ?? null);
      const resultActivityId = terminalResult ? activity.id : (previous?.resultActivityId ?? null);
      // Streamed progress text from a still-running agent; the terminal
      // result supersedes it.
      const liveBody =
        resultBody !== null
          ? null
          : (asTrimmedString(data?.subagentLiveText) ?? previous?.liveBody ?? null);
      const liveBodyUpdatedAt =
        resultBody !== null
          ? null
          : asTrimmedString(data?.subagentLiveText)
            ? (asTrimmedString(data?.subagentLiveTextAt) ?? activity.createdAt)
            : (previous?.liveBodyUpdatedAt ?? null);

      byAgentId.set(agentId, {
        id: agentId,
        agentThreadId: pendingAgent ? null : agentId,
        agentPath: pathMetadata?.agentPath ?? null,
        parentAgentPath: pathMetadata?.parentAgentPath ?? null,
        treeDepth: pathMetadata?.treeDepth ?? 0,
        turnId: activity.turnId ?? previous?.turnId ?? null,
        label,
        ...(nickname ? { nickname } : {}),
        role,
        objective,
        status,
        statusLabel: subagentProgressStatusLabel(status),
        model: model ?? previous?.model ?? null,
        reasoningEffort: reasoningEffort ?? previous?.reasoningEffort ?? null,
        liveBody,
        liveBodyUpdatedAt,
        createdAt: previous?.createdAt ?? activity.createdAt,
        updatedAt: activity.createdAt,
        resultActivityId,
        resultBody,
        resultCreatedAt,
      });
    }
  }

  return [...byAgentId.values()].toSorted((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
    return createdAtComparison === 0 ? left.id.localeCompare(right.id) : createdAtComparison;
  });
}

/** Settles a spawned agent's status from a task.completed activity that links
 *  back via toolUseId. Status only — the agent's message arrives through the
 *  tool item completion replay, and the task summary is not agent output. */
function applySubagentTaskCompletion(
  byAgentId: Map<string, InternalSubagentRecord>,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): void {
  const toolUseId = asTrimmedString(payload.toolUseId);
  const record = toolUseId ? byAgentId.get(toolUseId) : undefined;
  if (!record) {
    return;
  }
  const rawStatus = asTrimmedString(payload.status);
  const status: SubagentProgressStatus =
    rawStatus === "failed" ? "failed" : rawStatus === "stopped" ? "interrupted" : "completed";
  byAgentId.set(record.id, {
    ...record,
    status,
    statusLabel: subagentProgressStatusLabel(status),
    // The task settled; live progress text no longer describes the agent.
    liveBody: null,
    liveBodyUpdatedAt: null,
    updatedAt: activity.createdAt,
  });
}

function asClaudeSubagentActivityItem(input: {
  activity: OrchestrationThreadActivity;
  payload: Record<string, unknown>;
  data: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const toolName = asTrimmedString(input.data?.toolName);
  if (!isClaudeSubagentToolName(toolName)) {
    return null;
  }

  const toolInput = asRecord(input.data?.input);
  const toolCallId =
    asTrimmedString(input.payload.toolCallId) ??
    asTrimmedString(input.data?.itemId) ??
    input.activity.id;
  const itemStatus =
    asTrimmedString(input.payload.status) ?? claudeSubagentStatusFromActivityKind(input.activity);
  const resultText = extractClaudeSubagentResultText(input.data?.result);
  const notificationStatus = asTrimmedString(asRecord(input.data?.taskNotification)?.status);
  const structuredResultStatus = asTrimmedString(asRecord(input.data?.structuredResult)?.status);
  // A background launch acknowledgment is harness plumbing, not agent output:
  // the agent keeps running and its real message arrives later through the
  // task-notification completion replay (which carries data.taskNotification).
  const stateStatus =
    notificationStatus !== null
      ? claudeSubagentStateStatus(
          notificationStatus === "stopped" ? "interrupted" : notificationStatus,
        )
      : structuredResultStatus === "async_launched" || structuredResultStatus === "remote_launched"
        ? "running"
        : isClaudeAsyncAgentLaunchAcknowledgment(resultText)
          ? "running"
          : claudeSubagentStateStatus(itemStatus);
  const agentMessage = isTerminalClaudeSubagentState(stateStatus) ? resultText : null;
  const role =
    asTrimmedString(toolInput?.subagent_type) ??
    asTrimmedString(toolInput?.subagentType) ??
    asTrimmedString(toolInput?.agent_type) ??
    asTrimmedString(toolInput?.agentType);
  const nickname =
    asTrimmedString(toolInput?.agentNickname) ??
    asTrimmedString(toolInput?.agent_nickname) ??
    asTrimmedString(toolInput?.nickname) ??
    asTrimmedString(toolInput?.name) ??
    asTrimmedString(toolInput?.displayName);
  const prompt =
    asTrimmedString(toolInput?.description) ??
    asTrimmedString(toolInput?.prompt) ??
    asTrimmedString(input.payload.detail);

  return {
    id: toolCallId,
    type: "collabAgentToolCall",
    tool: toolName,
    status: itemStatus,
    ...(prompt ? { prompt } : {}),
    ...(role ? { agentRole: role } : {}),
    ...(nickname ? { agentNickname: nickname } : {}),
    receiverThreadIds: [toolCallId],
    agentsStates: {
      [toolCallId]: {
        status: stateStatus,
        ...(agentMessage ? { message: agentMessage } : { message: null }),
      },
    },
  };
}

function isClaudeSubagentToolName(toolName: string | null): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return (
    normalized === "agent" ||
    normalized === "task" ||
    normalized === "subagent" ||
    normalized === "sub-agent" ||
    normalized?.includes("subagent") === true ||
    normalized?.includes("sub-agent") === true
  );
}

function claudeSubagentStateStatus(itemStatus: string): string {
  const normalized = normalizeStatusToken(itemStatus);
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "errored" || normalized === "error") {
    return "errored";
  }
  if (normalized === "interrupted" || normalized === "aborted" || normalized === "cancelled") {
    return "interrupted";
  }
  return "running";
}

function claudeSubagentStatusFromActivityKind(activity: OrchestrationThreadActivity): string {
  if (activity.kind === "tool.completed") {
    return "completed";
  }
  return "inProgress";
}

function isTerminalClaudeSubagentState(stateStatus: string): boolean {
  return stateStatus === "completed" || stateStatus === "errored" || stateStatus === "interrupted";
}

function extractClaudeSubagentResultText(result: unknown): string | null {
  const direct = asTrimmedString(result);
  if (direct) {
    return sanitizeClaudeSubagentResultText(direct);
  }

  const resultRecord = asRecord(result);
  if (!resultRecord) {
    return null;
  }

  const text =
    extractClaudeTextContent(resultRecord.content) ??
    extractClaudeTextContent(resultRecord.text) ??
    extractClaudeTextContent(resultRecord.message);
  return sanitizeClaudeSubagentResultText(text);
}

function sanitizeClaudeSubagentResultText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const withoutUsage = value.replace(/\s*<usage>[\s\S]*?<\/usage>\s*$/iu, "").trimEnd();
  // The parenthetical wording varies by harness version ("use SendMessage
  // with ..." vs "internal ID - do not mention to user. Use SendMessage ...").
  const withoutContinuationFooter = withoutUsage
    .replace(
      /\s*agentId:\s*[A-Za-z0-9_-]+\s*\([^()]*?use\s+SendMessage\s+with\s+to:\s*['"`][^'"`]+['"`],\s*summary:\s*['"`][\s\S]*?['"`]\s+to\s+continue\s+this\s+agent\.?\)\s*$/iu,
      "",
    )
    .trim();

  return withoutContinuationFooter.length > 0 ? withoutContinuationFooter : null;
}

/** The Task tool_result for a `run_in_background` launch is an acknowledgment
 *  ("Async agent launched successfully. agentId: ..."), not the agent's
 *  output — the agent is still running at that point. */
function isClaudeAsyncAgentLaunchAcknowledgment(value: string | null): boolean {
  return value !== null && /^async agent launched successfully\b/iu.test(value);
}

function extractClaudeTextContent(content: unknown): string | null {
  const direct = asTrimmedString(content);
  if (direct) {
    return direct;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((entry) => {
      const text = asTrimmedString(entry);
      if (text) {
        return [text];
      }
      const entryRecord = asRecord(entry);
      const entryText = asTrimmedString(entryRecord?.text);
      return entryText ? [entryText] : [];
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractCollabAgentStates(value: unknown): Map<string, CollabAgentStateSnapshot> {
  const record = asRecord(value);
  const result = new Map<string, CollabAgentStateSnapshot>();
  if (!record) {
    return result;
  }

  for (const [agentThreadId, rawState] of Object.entries(record)) {
    const state = asRecord(rawState);
    if (!agentThreadId || !state) {
      continue;
    }
    result.set(agentThreadId, {
      status: asTrimmedString(state.status),
      message: asTrimmedString(state.message),
    });
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
}

function isSpawnAgentTool(tool: string | null): boolean {
  return tool?.trim().toLowerCase() === "spawnagent";
}

function subagentRoleFromAgentPath(agentPath: string | null): string | null {
  const lastSegment = agentPath
    ?.split(/[\\/]+/u)
    .findLast((segment) => segment.trim().length > 0)
    ?.trim();
  return lastSegment && lastSegment.toLowerCase() !== "root" ? lastSegment : null;
}

interface SubagentPathMetadata {
  agentPath: string;
  parentAgentPath: string | null;
  treeDepth: number;
}

function deriveSubagentPathMetadata(agentPath: string | null): SubagentPathMetadata | null {
  if (!agentPath) {
    return null;
  }

  const segments = agentPath
    .split(/[\\/]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  const normalizedPath = `/${segments.join("/")}`;
  const rootOffset = segments[0]?.toLowerCase() === "root" ? 1 : 0;
  const agentSegments = segments.slice(rootOffset);
  const treeDepth = Math.max(0, agentSegments.length - 1);
  const parentSegments = segments.slice(0, -1);

  return {
    agentPath: normalizedPath,
    parentAgentPath:
      agentSegments.length > 1 && parentSegments.length > 0 ? `/${parentSegments.join("/")}` : null,
    treeDepth,
  };
}

function isTerminalSubagentResult(input: {
  itemStatus: string | null;
  stateStatus: string | null;
  stateMessage: string | null;
}): input is typeof input & { stateMessage: string } {
  if (input.stateMessage === null) {
    return false;
  }

  const normalizedState = normalizeStatusToken(input.stateStatus);
  if (
    normalizedState !== "completed" &&
    normalizedState !== "shutdown" &&
    normalizedState !== "errored" &&
    normalizedState !== "error" &&
    normalizedState !== "interrupted"
  ) {
    return false;
  }

  const normalizedItem = normalizeStatusToken(input.itemStatus);
  if (normalizedItem !== "" && normalizedItem !== "completed") {
    return false;
  }
  return true;
}

function normalizeSubagentProgressStatus(input: {
  tool: string | null;
  itemStatus: string | null;
  stateStatus: string | null;
}): SubagentProgressStatus {
  const normalizedState = normalizeStatusToken(input.stateStatus);
  if (normalizedState === "pendinginit" || normalizedState === "pending") return "starting";
  if (normalizedState === "running") return "running";
  if (normalizedState === "interrupted") return "interrupted";
  if (
    normalizedState === "errored" ||
    normalizedState === "notfound" ||
    normalizedState === "error"
  ) {
    return "failed";
  }
  if (normalizedState === "completed" || normalizedState === "shutdown") return "completed";

  const normalizedTool = input.tool?.trim().toLowerCase();
  const normalizedItem = normalizeStatusToken(input.itemStatus);
  if (normalizedTool === "spawnagent" && normalizedItem !== "completed") {
    return "starting";
  }
  if (
    (normalizedTool === "wait" || normalizedTool === "closeagent") &&
    normalizedItem !== "completed"
  ) {
    return "waiting";
  }
  if (normalizedItem === "failed" || normalizedItem === "errored" || normalizedItem === "error") {
    return "failed";
  }
  if (normalizedItem === "interrupted") {
    return "interrupted";
  }
  if (normalizedItem === "completed" && normalizedTool === "closeagent") {
    return "completed";
  }
  if (
    normalizedItem === "inprogress" ||
    normalizedItem === "running" ||
    normalizedItem === "pending"
  ) {
    return normalizedTool === "spawnagent" ? "starting" : "running";
  }
  return "running";
}

function normalizeStatusToken(value: string | null): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[_\s-]+/gu, "") ?? ""
  );
}

export function isActiveSubagentStatus(status: SubagentProgressStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

function isFailedSubagentStatus(status: SubagentProgressStatus): boolean {
  return status === "failed" || status === "interrupted";
}

function subagentProgressStatusLabel(status: SubagentProgressStatus): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
      return "Error";
    case "interrupted":
      return "Interrupted";
  }
}

function parseSubagentObjective(prompt: string | null): {
  role: string | null;
  objective: string | null;
} {
  if (!prompt) {
    return { role: null, objective: null };
  }

  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const source = firstLine ?? prompt.trim();
  const roleMatch = /^([A-Za-z][A-Za-z0-9_-]{1,32})\s*:\s*(.+)$/u.exec(source);
  const objective = source.replace(/^(?:read-only\s+task|task)\.\s*/iu, "").trim();
  if (roleMatch) {
    return {
      role: roleMatch[1]?.replace(/[_-]+/gu, " ").toLowerCase() ?? null,
      objective: roleMatch[2]?.trim() ?? objective,
    };
  }
  return {
    role: null,
    objective: objective || null,
  };
}

function subagentDisplayLabel(input: { role: string | null; nickname: string | null }): string {
  const raw = input.nickname ?? input.role;
  if (!raw) {
    return "Subagent";
  }
  const normalized = formatSubagentNameToken(raw);
  if (!normalized) {
    return "Subagent";
  }
  return `${normalized} subagent`;
}

function formatSubagentNameToken(value: string): string | null {
  const normalized = value.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function summarizeSubagentProgress(input: {
  activeCount: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
}): string {
  if (input.activeCount > 0) {
    return formatSubagentCount(input.activeCount, "subagent active", "subagents active");
  }
  if (input.failedCount > 0) {
    return formatSubagentCount(
      input.failedCount,
      "subagent needs attention",
      "subagents need attention",
    );
  }
  if (input.completedCount > 0) {
    return formatSubagentCount(input.completedCount, "subagent finished", "subagents finished");
  }
  return formatSubagentCount(input.totalCount, "subagent", "subagents");
}

function deriveSubagentProgressBadge(input: {
  activeCount: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
}): SubagentProgressBadgeState {
  if (input.activeCount > 0) {
    return {
      label: String(input.activeCount),
      ariaLabel: formatSubagentCount(input.activeCount, "subagent active", "subagents active"),
      tone: "active",
      pulse: true,
    };
  }
  if (input.failedCount > 0) {
    return {
      label: String(input.failedCount),
      ariaLabel: formatSubagentCount(
        input.failedCount,
        "subagent needs attention",
        "subagents need attention",
      ),
      tone: "warning",
      pulse: false,
    };
  }
  if (input.completedCount > 0) {
    return {
      label: String(input.completedCount),
      ariaLabel: formatSubagentCount(
        input.completedCount,
        "subagent finished",
        "subagents finished",
      ),
      tone: "complete",
      pulse: false,
    };
  }
  return {
    label: String(input.totalCount),
    ariaLabel: formatSubagentCount(input.totalCount, "subagent", "subagents"),
    tone: "idle",
    pulse: false,
  };
}

function formatSubagentCount(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeTurnId?: TurnId | null,
): WorkLogEntry[] {
  const ordered =
    filterSupersededManualContextCompactionActivities(activities).toSorted(
      compareActivitiesByOrder,
    );
  const agentTaskIndex = collectAgentTaskIndex(ordered);
  const entries = ordered
    .filter((activity) => activity.kind !== "task.started")
    .filter((activity) => activity.kind !== "subagent.result")
    .filter((activity) => activity.kind !== "thread.fork.context")
    .filter((activity) => activity.kind !== "context-window.updated")
    // Account telemetry; belongs in a usage meter, not the work narrative.
    .filter((activity) => activity.kind !== "account.rate-limits.updated")
    // MCP startup and OAuth status is ambient extension health. It belongs in
    // plugin settings unless an actual tool call or provider turn is blocked.
    .filter((activity) => activity.kind !== "mcp.status.updated")
    .filter((activity) => activity.kind !== "mcp.oauth.completed")
    .filter((activity) => activity.kind !== "prompt-suggestion.updated")
    .filter(
      (activity) =>
        activity.kind !== "provider.model.safety-buffering" ||
        (activity.turnId === activeTurnId && asRecord(activity.payload)?.showBufferingUi === true),
    )
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .filter((activity) => !isSubagentNotificationReplayActivity(activity))
    .map((activity) => toDerivedWorkLogEntry(activity, agentTaskIndex));
  return enrichGenericThinkingEntries(
    collapseDerivedWorkLogEntries(entries).filter(shouldKeepDerivedWorkLogEntry),
  ).map(
    ({
      activityKind: _activityKind,
      collapseKey: _collapseKey,
      redactedThinking: _redactedThinking,
      ...entry
    }) => entry,
  );
}

/** The task-notification completion replay re-emits the original Task tool
 *  call with the agent's final message. The work log already narrates the
 *  completion via its task.completed entry, and the message itself renders as
 *  the subagent result row — a second tool row would duplicate both. */
function isSubagentNotificationReplayActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }
  const payload = asRecord(activity.payload);
  return asRecord(asRecord(payload?.data)?.taskNotification) !== null;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:")) {
    return true;
  }
  // Todo/task-tracker updates already render through the plan progress UI;
  // the raw tool calls would duplicate them in the work log.
  const toolName = asRecord(payload?.data)?.toolName;
  if (typeof toolName !== "string") {
    return false;
  }
  const normalized = toolName.toLowerCase();
  return (
    normalized.includes("todowrite") ||
    normalized === "taskcreate" ||
    normalized === "taskupdate" ||
    normalized === "taskget" ||
    normalized === "tasklist"
  );
}

interface AgentTaskIndex {
  /** Task ids spawned through the Agent/Task tool. `task.completed` payloads
   *  omit `subagentType`, so membership is collected from any lifecycle row
   *  that carries it and applied across the task's whole lifecycle. Background
   *  command tasks never carry it and stay unmarked. */
  readonly agentTaskIds: ReadonlySet<string>;
  /** Spawning collab tool call id → agent (task) ids it launched. */
  readonly agentIdsByToolUseId: ReadonlyMap<string, ReadonlyArray<string>>;
}

function collectAgentTaskIndex(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AgentTaskIndex {
  const agentTaskIds = new Set<string>();
  const agentIdsByToolUseId = new Map<string, string[]>();
  for (const activity of activities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = asTrimmedString(payload?.taskId);
    if (!taskId || !asTrimmedString(payload?.subagentType)) {
      continue;
    }
    agentTaskIds.add(taskId);
    const toolUseId = asTrimmedString(payload?.toolUseId);
    if (toolUseId) {
      const ids = agentIdsByToolUseId.get(toolUseId) ?? [];
      if (!ids.includes(taskId)) {
        ids.push(taskId);
        agentIdsByToolUseId.set(toolUseId, ids);
      }
    }
  }
  return { agentTaskIds, agentIdsByToolUseId };
}

function toDerivedWorkLogEntry(
  activity: OrchestrationThreadActivity,
  agentTaskIndex: AgentTaskIndex,
): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const modelFallback = deriveModelFallbackFromActivity(activity, payload);
  const commandPreview = extractToolCommand(payload, {
    detailMayBeCommand: activity.kind !== "tool.output.updated",
  });
  const itemType = extractWorkLogItemType(payload);
  // Read-only tools (Grep/Read/Glob...) carry `path` arguments in their
  // inputs; only file-change-shaped entries may treat paths as edits.
  const canCarryChangedFiles =
    itemType === undefined || itemType === "file_change" || itemType === "collab_agent_tool_call";
  const changedFiles = canCarryChangedFiles ? extractChangedFiles(payload) : [];
  const changedFileStats = canCarryChangedFiles ? extractChangedFileStats(payload) : [];
  const images = extractWorkLogImages(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity =
    activity.kind === "task.progress" ||
    activity.kind === "task.completed" ||
    activity.kind === "thinking.progress";
  const isRedactedThinkingActivity =
    activity.kind === "thinking.progress" && payload?.redacted === true;
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !isRedactedThinkingActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const runtimeWarningDisplay = deriveRuntimeWarningDisplay(activity, payload);
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : (runtimeWarningDisplay?.detail ??
      extractRuntimeActivityDetail(activity, payload) ??
      extractToolDetail(payload, title ?? activity.summary));
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    label: runtimeWarningDisplay?.label ?? (taskLabel || activity.summary),
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.kind === "thinking.progress"
          ? "thinking"
          : activity.kind === "runtime.warning"
            ? "warning"
            : activity.tone === "approval"
              ? "info"
              : activity.tone,
    activityKind: activity.kind,
    turnId: activity.turnId,
  };
  if (activity.kind === "tool.completed") {
    entry.completedAt = activity.createdAt;
  }
  if (modelFallback) {
    entry.modelFallback = modelFallback;
  }
  const authReconnect = deriveAuthReconnectAction(activity, payload);
  if (authReconnect) {
    entry.authReconnect = authReconnect;
  }
  const mcpAuthReconnect = deriveMcpAuthReconnectAction(activity, payload);
  if (mcpAuthReconnect) {
    entry.mcpAuthReconnect = mcpAuthReconnect;
  }
  const requestKind = extractWorkLogRequestKind(payload);
  if (detail) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (
    activity.kind === "tool.output.updated" &&
    asTrimmedString(payload?.streamKind) === "command_output"
  ) {
    const rawOutput = asTrimmedString(payload?.detail);
    if (rawOutput) {
      const { output, exitCode } = stripTrailingExitCode(rawOutput);
      const lifted = output ? liftLeadingExitCode(output) : { output: null };
      if (lifted.output) {
        entry.outputPreview = lifted.output;
      }
      const resolvedExitCode = exitCode ?? lifted.exitCode;
      if (resolvedExitCode !== undefined) {
        entry.exitCode = resolvedExitCode;
      }
    }
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (changedFileStats.length > 0) {
    entry.changedFileStats = changedFileStats;
  }
  if (images.length > 0) {
    entry.images = images;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  const subagentOperation = extractSubagentWorkOperation(payload, itemType);
  if (subagentOperation) {
    entry.subagentOperation = subagentOperation;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  const providerLifecyclePhase = providerLifecyclePhaseFromActivityKind(activity.kind);
  if (providerLifecyclePhase) {
    entry.providerLifecyclePhase = providerLifecyclePhase;
  }
  const executionState = deriveWorkLogExecutionState(activity, entry, payload);
  if (executionState) {
    entry.executionState = executionState;
  }
  if (activity.kind === "thinking.progress") {
    entry.redactedThinking = isRedactedThinkingActivity;
  }
  if (activity.kind === "task.progress" || activity.kind === "task.completed") {
    const subagentType = asTrimmedString(payload?.subagentType);
    const taskId = asTrimmedString(payload?.taskId);
    if (subagentType !== null || (taskId !== null && agentTaskIndex.agentTaskIds.has(taskId))) {
      entry.subagentTask = {
        subagentType,
        toolUseId: asTrimmedString(payload?.toolUseId),
      };
    }
  }
  const payloadData = asRecord(payload?.data);
  const sourceAgentThreadId =
    asTrimmedString(payload?.sourceAgentThreadId) ??
    asTrimmedString(payloadData?.sourceAgentThreadId);
  if (sourceAgentThreadId) {
    entry.subagentTask = {
      subagentType:
        asTrimmedString(payload?.sourceAgentLabel) ??
        asTrimmedString(payloadData?.sourceAgentLabel),
      toolUseId: sourceAgentThreadId,
    };
  }
  if (itemType === "collab_agent_tool_call") {
    const spawnToolUseId = extractToolCallId(payload);
    const spawnedAgentIds =
      spawnToolUseId !== null ? agentTaskIndex.agentIdsByToolUseId.get(spawnToolUseId) : undefined;
    if (spawnedAgentIds !== undefined && spawnedAgentIds.length > 0) {
      entry.spawnedAgentIds = spawnedAgentIds;
    }
  }
  const collapseKey =
    deriveThinkingCollapseKey(activity, payload) ??
    deriveTransientWarningCollapseKey(activity, payload) ??
    deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

/** Collapses recurring transient warnings (e.g. API retries) into a single
 *  per-turn row that updates in place instead of stacking. */
function deriveTransientWarningCollapseKey(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string | undefined {
  if (activity.kind !== "runtime.warning") {
    return undefined;
  }
  const warningKind = asTrimmedString(payload?.warningKind);
  if (warningKind !== "api-retry") {
    return undefined;
  }
  return ["warning", warningKind, activity.turnId ?? "thread"].join("\u001f");
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const activeIndexByKey = new Map<string, number>();
  const activeKeysByIndex = new Map<number, string[]>();

  for (const entry of entries) {
    const keys = deriveCollapsibleWorkLogKeys(entry);
    if (keys.length === 0) {
      collapsed.push(entry);
      continue;
    }

    const activeIndex = findActiveToolLifecycleIndex(
      activeIndexByKey,
      collapsibleWorkLogLookupKeys(entry, keys),
    );

    if (activeIndex !== undefined) {
      const previous = collapsed[activeIndex];
      if (!previous) {
        collapsed.push(entry);
        continue;
      }

      const previousKeys = activeKeysByIndex.get(activeIndex) ?? [];
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[activeIndex] = merged;
      deleteActiveToolLifecycleKeys(activeIndexByKey, previousKeys);

      if (!shouldKeepCollapseKeysActive(merged)) {
        activeKeysByIndex.delete(activeIndex);
      } else {
        const mergedKeys = uniqueStrings([
          ...previousKeys,
          ...keys,
          ...deriveToolLifecycleCollapseKeys(merged),
        ]);
        activeKeysByIndex.set(activeIndex, mergedKeys);
        setActiveToolLifecycleKeys(activeIndexByKey, mergedKeys, activeIndex);
      }
      continue;
    }

    collapsed.push(entry);
    if (shouldKeepCollapseKeysActive(entry)) {
      const entryIndex = collapsed.length - 1;
      activeKeysByIndex.set(entryIndex, keys);
      setActiveToolLifecycleKeys(activeIndexByKey, keys, entryIndex);
    }
  }

  return collapsed;
}

function shouldKeepDerivedWorkLogEntry(entry: DerivedWorkLogEntry): boolean {
  if (!entry.redactedThinking) {
    return true;
  }
  return entry.executionState === "running" || entry.executionState === "failed";
}

function deriveCollapsibleWorkLogKeys(entry: DerivedWorkLogEntry): string[] {
  if (isToolLifecycleActivityKind(entry.activityKind)) {
    return deriveToolLifecycleCollapseKeys(entry);
  }
  if (
    (entry.activityKind === "thinking.progress" || entry.activityKind === "runtime.warning") &&
    entry.collapseKey
  ) {
    return [entry.collapseKey];
  }
  return [];
}

function collapsibleWorkLogLookupKeys(
  entry: DerivedWorkLogEntry,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (entry.activityKind !== "tool.started") {
    return keys;
  }
  return keys.filter((key) => !key.startsWith("tool-loose\u001f"));
}

function shouldKeepCollapseKeysActive(entry: DerivedWorkLogEntry): boolean {
  if (entry.executionState === "completed" || entry.executionState === "failed") {
    return false;
  }
  return entry.activityKind !== "tool.completed";
}

function providerLifecyclePhaseFromActivityKind(
  kind: OrchestrationThreadActivity["kind"],
): WorkLogEntry["providerLifecyclePhase"] | undefined {
  switch (kind) {
    case "provider.turn.preparing":
      return "preparing";
    case "provider.turn.started":
      return "waiting-for-model";
    default:
      return undefined;
  }
}

function deriveThinkingCollapseKey(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string | undefined {
  if (activity.kind !== "thinking.progress") {
    return undefined;
  }
  const reasoningItemId = asTrimmedString(payload?.reasoningItemId);
  if (reasoningItemId) {
    return `thinking\u001f${reasoningItemId}`;
  }
  if (asTrimmedString(payload?.sourceItemType) === "reasoning") {
    return `thinking-turn\u001f${activity.turnId ?? "thread"}`;
  }
  return undefined;
}

function isToolLifecycleActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return (
    kind === "tool.started" ||
    kind === "tool.updated" ||
    kind === "tool.output.updated" ||
    kind === "tool.progress" ||
    kind === "tool.completed"
  );
}

function findActiveToolLifecycleIndex(
  activeIndexByKey: ReadonlyMap<string, number>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const activeIndex = activeIndexByKey.get(key);
    if (activeIndex !== undefined) {
      return activeIndex;
    }
  }
  return undefined;
}

function setActiveToolLifecycleKeys(
  activeIndexByKey: Map<string, number>,
  keys: ReadonlyArray<string>,
  index: number,
) {
  for (const key of keys) {
    activeIndexByKey.set(key, index);
  }
}

function deleteActiveToolLifecycleKeys(
  activeIndexByKey: Map<string, number>,
  keys: ReadonlyArray<string>,
) {
  for (const key of keys) {
    activeIndexByKey.delete(key);
  }
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function enrichGenericThinkingEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const enriched: DerivedWorkLogEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (!isGenericThinkingEntry(entry)) {
      enriched.push(entry);
      continue;
    }

    const previous = findPreviousReviewableWorkEntry(entries, index, entry);
    const detail = previous ? reviewDetailForPreviousWorkEntry(previous) : null;
    if (!detail) {
      enriched.push(entry);
      continue;
    }

    enriched.push({
      ...entry,
      detail,
    });
  }
  return enriched;
}

function isGenericThinkingEntry(entry: DerivedWorkLogEntry): boolean {
  return (
    entry.tone === "thinking" &&
    entry.activityKind === "thinking.progress" &&
    entry.redactedThinking === true &&
    (!entry.detail || entry.detail === "Working through the next step")
  );
}

function findPreviousReviewableWorkEntry(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  beforeIndex: number,
  currentEntry: DerivedWorkLogEntry,
): DerivedWorkLogEntry | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (!candidate || candidate.tone === "thinking") {
      continue;
    }
    if (!isSameTurnWorkEntry(currentEntry, candidate)) {
      continue;
    }
    if (reviewDetailForPreviousWorkEntry(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isSameTurnWorkEntry(left: DerivedWorkLogEntry, right: DerivedWorkLogEntry): boolean {
  if (left.turnId === null || left.turnId === undefined) {
    return right.turnId === null || right.turnId === undefined;
  }
  return right.turnId === left.turnId;
}

function reviewDetailForPreviousWorkEntry(entry: DerivedWorkLogEntry): string | null {
  if (entry.itemType === "web_search") {
    return "Reviewing search results";
  }
  if (entry.itemType === "image_view") {
    return "Reviewing image";
  }
  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) {
    return "Reviewing file changes";
  }
  if (entry.requestKind === "file-read") {
    return "Reviewing file contents";
  }
  if (entry.itemType === "mcp_tool_call" || entry.itemType === "dynamic_tool_call") {
    return "Reviewing tool result";
  }
  if (isCommandWorkLogEntry(entry)) {
    return "Reviewing command output";
  }
  if (entry.tone === "tool") {
    return "Reviewing tool result";
  }
  return null;
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const changedFileStats = mergeChangedFileStats(previous.changedFileStats, next.changedFileStats);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const outputPreview = next.outputPreview ?? previous.outputPreview;
  const exitCode = next.exitCode ?? previous.exitCode;
  const images = mergeWorkLogImages(previous.images, next.images);
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const executionState = next.executionState ?? previous.executionState;
  const authReconnect = next.authReconnect ?? previous.authReconnect;
  const mcpAuthReconnect = next.mcpAuthReconnect ?? previous.mcpAuthReconnect;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const turnId = next.turnId ?? previous.turnId;
  const subagentTask = next.subagentTask ?? previous.subagentTask;
  const spawnedAgentIds = next.spawnedAgentIds ?? previous.spawnedAgentIds;
  const completedAt = next.completedAt ?? previous.completedAt;
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    ...(completedAt ? { completedAt } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(outputPreview ? { outputPreview } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(changedFileStats.length > 0 ? { changedFileStats } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(executionState ? { executionState } : {}),
    ...(authReconnect ? { authReconnect } : {}),
    ...(mcpAuthReconnect ? { mcpAuthReconnect } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(subagentTask ? { subagentTask } : {}),
    ...(spawnedAgentIds ? { spawnedAgentIds } : {}),
  };
}

function deriveAuthReconnectAction(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): ProviderAuthReconnectAction | undefined {
  if (activity.kind !== "runtime.error") {
    return undefined;
  }

  const message = asTrimmedString(payload?.message) ?? activity.summary;
  const errorClass = asTrimmedString(payload?.class);
  if (errorClass !== "authentication_error" && !isProviderAuthErrorMessage(message)) {
    return undefined;
  }

  const providerValue = asTrimmedString(payload?.provider);
  if (!providerValue) {
    return undefined;
  }

  const provider = ProviderDriverKind.make(providerValue);
  const command = providerAuthReconnectCommand(provider);
  if (!command) {
    return undefined;
  }

  return {
    provider,
    command,
    message,
  };
}

function deriveMcpAuthReconnectAction(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): McpAuthReconnectAction | undefined {
  if (activity.kind !== "mcp.status.updated") {
    return undefined;
  }

  const status = asRecord(payload?.status);
  const serverName = asTrimmedString(status?.name);
  if (!serverName) {
    return undefined;
  }

  const statusValue = asTrimmedString(status?.status);
  const error = asTrimmedString(status?.error) ?? asTrimmedString(payload?.detail);
  const intent = extensionMcpOAuthActionIntent({
    status: statusValue,
    detail: error,
  });
  if (!intent) {
    return undefined;
  }

  const provider = ProviderDriverKind.make(asTrimmedString(payload?.provider) ?? "codex");
  const providerInstanceIdValue = asTrimmedString(payload?.providerInstanceId);
  const providerInstanceId = providerInstanceIdValue
    ? ProviderInstanceId.make(providerInstanceIdValue)
    : undefined;
  const loginProvider: ExtensionMcpLoginProvider =
    provider === ProviderDriverKind.make("claudeAgent") ? "claudeAgent" : "codex";

  return {
    provider,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    serverName,
    serverLabel: mcpServerDisplayName(serverName),
    intent,
    actionLabel: extensionMcpOAuthActionLabel(intent),
    message: error ?? "This MCP server needs authorization.",
    terminalCommand: providerMcpLoginCommand(loginProvider, serverName),
  };
}

function isCommandWorkLogEntry(entry: Pick<WorkLogEntry, "command" | "itemType" | "requestKind">) {
  return (
    entry.requestKind === "command" || entry.itemType === "command_execution" || !!entry.command
  );
}

function isLifecycleWorkLogEntry(
  entry: Pick<WorkLogEntry, "command" | "itemType" | "requestKind">,
) {
  return (
    isCommandWorkLogEntry(entry) ||
    entry.itemType === "file_change" ||
    entry.itemType === "mcp_tool_call" ||
    entry.itemType === "dynamic_tool_call" ||
    entry.itemType === "collab_agent_tool_call" ||
    entry.itemType === "web_search" ||
    entry.itemType === "image_view"
  );
}

function deriveWorkLogExecutionState(
  activity: OrchestrationThreadActivity,
  entry: Pick<DerivedWorkLogEntry, "command" | "itemType" | "requestKind" | "tone" | "toolCallId">,
  payload: Record<string, unknown> | null,
): WorkLogEntry["executionState"] | undefined {
  if (entry.tone === "thinking") {
    return normalizeWorkLogExecutionStatus(asTrimmedString(payload?.status));
  }
  if (activity.kind === "context-compaction") {
    return normalizeWorkLogExecutionStatus(asTrimmedString(payload?.status));
  }
  if (!isLifecycleWorkLogEntry(entry)) {
    return undefined;
  }
  if (
    activity.kind === "tool.output.updated" &&
    entry.itemType === "command_execution" &&
    !entry.toolCallId &&
    !entry.command
  ) {
    return undefined;
  }
  const payloadStatus = normalizeWorkLogExecutionStatus(
    asTrimmedString(payload?.status) ?? asTrimmedString(asRecord(payload?.data)?.status),
  );
  if (payloadStatus) {
    return payloadStatus;
  }
  if (activity.kind === "tool.updated") {
    return "running";
  }
  if (activity.kind === "tool.started") {
    return "running";
  }
  if (activity.kind === "tool.completed") {
    return entry.tone === "error" ? "failed" : "completed";
  }
  return undefined;
}

function normalizeWorkLogExecutionStatus(
  value: string | null,
): WorkLogEntry["executionState"] | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (!normalized) {
    return undefined;
  }
  if (normalized === "running" || normalized === "inprogress" || normalized === "pending") {
    return "running";
  }
  if (normalized === "completed" || normalized === "complete" || normalized === "success") {
    return "completed";
  }
  if (
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "error" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "declined"
  ) {
    return "failed";
  }
  return undefined;
}

function deriveRuntimeWarningDisplay(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): { label: string; detail?: string } | null {
  if (activity.kind !== "runtime.warning") {
    return null;
  }

  const message = asTrimmedString(payload?.message);
  const warningKind = asTrimmedString(payload?.warningKind);
  const provider = asTrimmedString(payload?.provider);
  const detail = asRecord(payload?.detail);
  const detailError = asRecord(detail?.error);
  const additionalDetails = asTrimmedString(detailError?.additionalDetails);
  const codexStreamWarning = isCodexStreamWarning({
    provider,
    message,
    additionalDetails,
  });

  if (warningKind === "api-retry") {
    if (!codexStreamWarning) {
      const label = message ?? "Provider API retry";
      const rawDetail = extractRuntimeActivityDetail(activity, payload);
      return rawDetail ? { label, detail: rawDetail } : { label };
    }

    const attempt = extractReconnectAttempt(message);
    const label = attempt ? `Codex stream reconnecting ${attempt}` : "Codex stream reconnecting";
    const retryDetail = summarizeCodexStreamDisconnect(additionalDetails);
    return retryDetail ? { label, detail: retryDetail } : { label };
  }

  if (isCodexTransportFallbackWarning({ provider, message })) {
    const fallbackDetails = stripCodexTransportFallbackPrefix(message);
    const summarizedFallback = summarizeCodexStreamDisconnect(fallbackDetails);
    const detailText = summarizedFallback
      ? `After repeated stream disconnects, Codex continued the turn over HTTPS. Last error: ${summarizedFallback}`
      : "After repeated stream disconnects, Codex continued the turn over HTTPS.";
    return {
      label: "Codex switched to HTTPS transport",
      detail: detailText,
    };
  }

  return null;
}

function isCodexStreamWarning(input: {
  provider: string | null;
  message: string | null;
  additionalDetails: string | null;
}): boolean {
  if (input.provider === "codex") {
    return true;
  }
  const haystack = [input.message, input.additionalDetails].filter(Boolean).join(" ").toLowerCase();
  return (
    haystack.includes("chatgpt.com/backend-api/codex") ||
    haystack.includes("response.completed") ||
    haystack.includes("badrecordmac")
  );
}

function isCodexTransportFallbackWarning(input: {
  provider: string | null;
  message: string | null;
}): boolean {
  const message = input.message?.toLowerCase() ?? "";
  return (
    (input.provider === "codex" || input.provider === null) &&
    message.startsWith("falling back from websockets to https transport")
  );
}

function extractReconnectAttempt(message: string | null): string | null {
  const match = message?.match(/reconnecting\.\.\.\s*(\d+\/\d+)/i);
  return match?.[1] ?? null;
}

function stripCodexTransportFallbackPrefix(message: string | null): string | null {
  const value = message
    ?.replace(/^Falling back from WebSockets to HTTPS transport\.\s*/i, "")
    .trim();
  return value && value.length > 0 ? value : null;
}

function summarizeCodexStreamDisconnect(detail: string | null): string | null {
  if (!detail) {
    return null;
  }
  const normalized = detail.replace(/^stream disconnected before completion:\s*/i, "").trim();
  const lower = normalized.toLowerCase();
  if (lower.includes("badrecordmac")) {
    return "TLS stream error (BadRecordMac) interrupted the provider connection.";
  }
  if (lower.includes("websocket closed by server before response.completed")) {
    return "The upstream provider WebSocket closed before the model response completed.";
  }
  if (lower.includes("error sending request for url")) {
    return "Network error while connecting to the Codex responses endpoint.";
  }
  return normalized;
}

function extractRuntimeActivityDetail(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string | null {
  const message = asTrimmedString(payload?.message);
  const directDetail = asTrimmedString(payload?.detail);
  const detail = asRecord(payload?.detail);
  const detailError = asRecord(detail?.error);
  const detailMessage = asTrimmedString(detail?.message) ?? asTrimmedString(detailError?.message);
  const additionalDetails = asTrimmedString(detailError?.additionalDetails);
  const primaryMessage = directDetail ?? message ?? detailMessage;

  if (
    activity.kind === "runtime.warning" &&
    asTrimmedString(payload?.warningKind) === "api-retry"
  ) {
    return additionalDetails ?? (primaryMessage !== message ? primaryMessage : null);
  }

  if (primaryMessage && additionalDetails && !primaryMessage.includes(additionalDetails)) {
    return `${primaryMessage} - ${additionalDetails}`;
  }

  if (activity.kind === "runtime.warning" || activity.kind === "runtime.error") {
    return primaryMessage ?? additionalDetails;
  }

  if (isToolLifecycleActivityKind(activity.kind)) {
    return null;
  }

  return directDetail;
}

function mergeWorkLogImages(
  previous: ReadonlyArray<WorkLogImagePreview> | undefined,
  next: ReadonlyArray<WorkLogImagePreview> | undefined,
): WorkLogImagePreview[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  const byId = new Map<string, WorkLogImagePreview>();
  for (const image of merged) {
    byId.set(image.id, image);
  }
  return [...byId.values()];
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  return deriveToolLifecycleCollapseKeys(entry)[0];
}

function deriveToolLifecycleCollapseKeys(entry: DerivedWorkLogEntry): string[] {
  if (!isToolLifecycleActivityKind(entry.activityKind)) {
    return [];
  }
  const keys: string[] = [];
  if (entry.toolCallId) {
    keys.push(`tool:${entry.toolCallId}`);
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label).toLowerCase();
  const itemType = entry.itemType ?? "";
  const turnId = entry.turnId ?? "";
  const subject = normalizeToolLifecycleSubject(entry);
  if (subject) {
    keys.push(["tool-subject", turnId, itemType, normalizedLabel, subject].join("\u001f"));
  }
  if (normalizedLabel.length > 0 || itemType.length > 0) {
    keys.push(["tool-loose", turnId, itemType, normalizedLabel].join("\u001f"));
  }
  return uniqueStrings(keys);
}

function normalizeToolLifecycleSubject(entry: DerivedWorkLogEntry): string {
  const changedFiles = entry.changedFiles ?? [];
  const fileSubject = changedFiles.length > 0 ? changedFiles.join("\u001e") : undefined;
  const rawSubject = entry.command ?? entry.detail ?? fileSubject;
  return rawSubject ? normalizeInlinePreview(rawSubject).toLowerCase() : "";
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
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

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBase64ImageDataUrl(value: string): { previewUrl: string; mimeType: string } | null {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 32 || !/^[A-Za-z0-9+/=_-]+$/u.test(normalized)) {
    return null;
  }

  const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const mimeType = inferImageMimeTypeFromBase64(base64);
  return {
    previewUrl: `data:${mimeType};base64,${padBase64(base64)}`,
    mimeType,
  };
}

function imageSourceFromValue(
  value: string,
  options?: { readonly allowBase64?: boolean },
): { previewUrl: string; mimeType?: string | undefined } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(trimmed);
  if (dataUrlMatch) {
    return {
      previewUrl: trimmed,
      mimeType: dataUrlMatch[1],
    };
  }

  if (/^(?:https?:|blob:)/iu.test(trimmed)) {
    return { previewUrl: trimmed };
  }

  if (options?.allowBase64) {
    return asBase64ImageDataUrl(trimmed);
  }

  return null;
}

function inferImageMimeTypeFromBase64(value: string): string {
  if (value.startsWith("iVBORw0KGgo")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("R0lGOD")) return "image/gif";
  if (value.startsWith("UklGR")) return "image/webp";
  if (value.startsWith("PHN2Zy") || value.startsWith("PD94bWw")) return "image/svg+xml";
  if (value.includes("ZnR5cGF2aWY", 4)) return "image/avif";
  return "image/png";
}

function padBase64(value: string): string {
  const remainder = value.length % 4;
  return remainder === 0 ? value : `${value}${"=".repeat(4 - remainder)}`;
}

function extensionForImageMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return ".png";
  }
}

function fileNameFromPath(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) {
    return null;
  }

  const pathWithoutQuery = raw.split(/[?#]/u)[0] ?? raw;
  const normalized = pathWithoutQuery.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = segments[index]?.trim();
    if (candidate && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function generatedImageName(input: {
  readonly id: string;
  readonly mimeType: string | undefined;
  readonly path: unknown;
}): string {
  return fileNameFromPath(input.path) ?? `${input.id}${extensionForImageMimeType(input.mimeType)}`;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(
  payload: Record<string, unknown> | null,
  options?: {
    readonly detailMayBeCommand?: boolean;
  },
): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const detailMayBeCommand = options?.detailMayBeCommand ?? true;
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    detailMayBeCommand && itemType === "command_execution" && detail
      ? stripTrailingExitCode(detail).output
      : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return semanticToolPresentation(payload)?.title ?? asTrimmedString(payload?.title);
}

function extractWorkLogImages(payload: Record<string, unknown> | null): WorkLogImagePreview[] {
  if (!isImagePreviewPayload(payload)) {
    return [];
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const imageId =
    asTrimmedString(item?.id) ??
    asTrimmedString(data?.itemId) ??
    asTrimmedString(data?.id) ??
    "generated-image";
  const result = asTrimmedString(item?.result ?? data?.result ?? payload?.result);
  const path = item?.savedPath ?? item?.saved_path ?? item?.path ?? data?.savedPath ?? data?.path;
  const source = result
    ? imageSourceFromValue(result, { allowBase64: true })
    : imageSourceFromValue(asTrimmedString(path) ?? "", { allowBase64: false });

  if (!source) {
    return [];
  }

  return [
    {
      id: imageId,
      name: generatedImageName({
        id: imageId,
        mimeType: source.mimeType,
        path,
      }),
      previewUrl: source.previewUrl,
    },
  ];
}

function isImagePreviewPayload(payload: Record<string, unknown> | null): boolean {
  if (extractWorkLogItemType(payload) === "image_view") {
    return true;
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const title = asTrimmedString(payload?.title)?.toLowerCase();
  const namespace = asTrimmedString(item?.namespace ?? data?.namespace)?.toLowerCase();
  const tool = asTrimmedString(item?.tool ?? data?.tool)?.toLowerCase();
  const itemType = asTrimmedString(item?.type ?? data?.type)?.toLowerCase();
  const path = asTrimmedString(
    item?.savedPath ?? item?.saved_path ?? item?.path ?? data?.savedPath ?? data?.path,
  )?.toLowerCase();

  return [title, namespace, tool, itemType, path].some(
    (value) =>
      value?.includes("image") === true || /\.(?:png|jpe?g|gif|webp|avif|svg)$/iu.test(value ?? ""),
  );
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(payload?.toolCallId) ?? asTrimmedString(data?.toolCallId);
}

function extractSubagentWorkOperation(
  payload: Record<string, unknown> | null,
  itemType: ToolLifecycleItemType | undefined,
): WorkLogEntry["subagentOperation"] | undefined {
  if (itemType !== "collab_agent_tool_call") {
    return undefined;
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const nativeKind = normalizeStatusToken(asTrimmedString(item?.kind));
  if (nativeKind === "started") {
    return "delegation";
  }
  if (nativeKind === "interacted" || nativeKind === "interrupted") {
    return "coordination";
  }

  const tool =
    asTrimmedString(item?.tool) ?? asTrimmedString(data?.tool) ?? asTrimmedString(data?.toolName);
  return isSpawnAgentTool(tool) || isClaudeSubagentToolName(tool) ? "delegation" : "coordination";
}

interface ToolCallIdentity {
  readonly itemType: ToolLifecycleItemType | undefined;
  readonly serverOrNamespace: string | null;
  readonly tool: string | null;
  readonly input: unknown;
}

interface SemanticToolPresentation {
  readonly title: string;
  readonly detail?: string;
}

function extractToolCallIdentity(payload: Record<string, unknown> | null): ToolCallIdentity | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemType = extractWorkLogItemType(payload);
  if (
    itemType !== "mcp_tool_call" &&
    itemType !== "dynamic_tool_call" &&
    itemType !== "collab_agent_tool_call" &&
    itemType !== "web_search"
  ) {
    return null;
  }

  const serverOrNamespace = asTrimmedString(
    item?.server ?? data?.server ?? item?.namespace ?? data?.namespace,
  );
  const tool = asTrimmedString(item?.tool ?? data?.tool);
  const input =
    item && Object.prototype.hasOwnProperty.call(item, "arguments")
      ? item.arguments
      : data && Object.prototype.hasOwnProperty.call(data, "arguments")
        ? data.arguments
        : undefined;

  if (!serverOrNamespace && !tool) {
    return null;
  }

  return {
    itemType,
    serverOrNamespace,
    tool,
    input,
  };
}

function semanticToolPresentation(
  payload: Record<string, unknown> | null,
): SemanticToolPresentation | null {
  const identity = extractToolCallIdentity(payload);
  if (!identity) {
    return null;
  }

  if (isBrowserAutomationTool(identity)) {
    return {
      title: "Browser control",
      detail: browserAutomationDetail(identity),
    };
  }

  if (isNodeReplJsTool(identity)) {
    return {
      title: "JavaScript REPL",
      detail: "Running JavaScript",
    };
  }

  if (toolNamespaceMatches(identity.serverOrNamespace, "tool_search")) {
    return {
      title: "Tool discovery",
      detail: toolSearchDetail(identity.input),
    };
  }

  if (toolNamespaceMatches(identity.serverOrNamespace, "multi_tool_use")) {
    return {
      title: "Parallel tools",
      detail: "Running tools in parallel",
    };
  }

  if (toolNamespaceMatches(identity.serverOrNamespace, "image_gen", "imagegen")) {
    return {
      title: "Image generation",
      detail: summarizeNamedToolDetail(identity),
    };
  }

  if (toolNamespaceMatches(identity.serverOrNamespace, "computer_use", "computer-use")) {
    return {
      title: "Computer use",
      detail: summarizeNamedToolDetail(identity),
    };
  }

  const providerTitle = knownProviderToolTitle(identity.serverOrNamespace);
  if (providerTitle) {
    return {
      title: providerTitle,
      detail: summarizeNamedToolDetail(identity),
    };
  }

  return null;
}

function toolNamespaceMatches(value: string | null, ...candidates: ReadonlyArray<string>): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return false;
  }

  const tokenSet = new Set(raw.split(/[^a-z0-9]+/u).filter((token) => token.length > 0));
  const compact = raw.replace(/[^a-z0-9]+/gu, "");
  return candidates.some((candidate) => {
    const normalizedCandidate = candidate.trim().toLowerCase();
    const candidateTokens = normalizedCandidate
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 0);
    const candidateCompact = normalizedCandidate.replace(/[^a-z0-9]+/gu, "");
    return (
      raw === normalizedCandidate ||
      compact === candidateCompact ||
      tokenSet.has(normalizedCandidate) ||
      candidateTokens.every((token) => tokenSet.has(token))
    );
  });
}

function toolNameMatches(value: string | null, ...candidates: ReadonlyArray<string>): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return candidates.some((candidate) => normalized === candidate.trim().toLowerCase());
}

function isNodeReplJsTool(identity: ToolCallIdentity): boolean {
  return (
    toolNamespaceMatches(identity.serverOrNamespace, "node_repl", "node-repl") &&
    toolNameMatches(identity.tool, "js")
  );
}

function isBrowserAutomationTool(identity: ToolCallIdentity): boolean {
  if (toolNamespaceMatches(identity.serverOrNamespace, "browser", "browser_use", "browser-use")) {
    return true;
  }

  if (!isNodeReplJsTool(identity)) {
    return false;
  }

  const code = extractToolInputText(identity.input);
  return (
    code !== null &&
    /\b(?:agent\.browsers|setupBrowserRuntime|browser\.(?:tabs|capabilities|nameSession)|globalThis\.browser|tab\.(?:playwright|goto|reload|screenshot|cua|dom_cua|dev|clipboard)|nodeRepl\.emitImage)\b/u.test(
      code,
    )
  );
}

function extractToolInputText(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of ["code", "script", "javascript", "js", "input", "command", "text", "prompt"]) {
    const candidate = asTrimmedString(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function browserAutomationDetail(identity: ToolCallIdentity): string {
  const directUrl = argumentValue(identity.input, "url", "href", "target");
  const code = extractToolInputText(identity.input);
  const codeUrl = code ? extractBrowserUrlFromCode(code) : null;
  const url = directUrl ?? codeUrl;
  const tool = identity.tool?.trim().toLowerCase();

  if (tool && /^(?:open|goto|navigate|new_tab)$/u.test(tool)) {
    return url ? `Opening ${truncateInlinePreview(url, 72)}` : "Opening browser page";
  }

  if (code && /\.goto\(/u.test(code) && url) {
    return `Opening ${truncateInlinePreview(url, 72)}`;
  }
  if (code && /\b(?:domSnapshot|get_visible_dom|evaluate|dev\.logs)\b/u.test(code)) {
    return "Inspecting page";
  }
  if (code && /\b(?:screenshot|emitImage)\b/u.test(code)) {
    return "Capturing browser screenshot";
  }
  if (
    code &&
    /\b(?:click|dblclick|fill|type|press|selectOption|setChecked|check|uncheck)\b/u.test(code)
  ) {
    return "Interacting with page";
  }
  if (code && /\breload\(/u.test(code)) {
    return "Reloading page";
  }
  if (code && /\bsetupBrowserRuntime\b/u.test(code)) {
    return "Connecting to browser";
  }

  return "Running browser automation";
}

function extractBrowserUrlFromCode(value: string): string | null {
  const match = /\.(?:goto|open)\(\s*["'`]([^"'`]+)["'`]/u.exec(value);
  return match?.[1]?.trim() || null;
}

function argumentValue(value: unknown, ...keys: ReadonlyArray<string>): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const candidate = asTrimmedString(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function toolSearchDetail(input: unknown): string {
  const query = argumentValue(input, "query", "q");
  return query
    ? `Searching tools: ${truncateInlinePreview(query, 72)}`
    : "Searching available tools";
}

function knownProviderToolTitle(serverOrNamespace: string | null): string | null {
  if (toolNamespaceMatches(serverOrNamespace, "supabase")) return "Supabase";
  if (toolNamespaceMatches(serverOrNamespace, "github")) return "GitHub";
  if (toolNamespaceMatches(serverOrNamespace, "vercel")) return "Vercel";
  if (toolNamespaceMatches(serverOrNamespace, "alpaca")) return "Market data";
  return null;
}

function mcpServerDisplayName(serverName: string): string {
  const known = knownProviderToolTitle(serverName);
  if (known) return known;
  let lastSegment = serverName;
  const segments = serverName.split(":");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]?.trim();
    if (segment) {
      lastSegment = segment;
      break;
    }
  }
  const pretty = prettifyToolAction(lastSegment) ?? serverName;
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function summarizeNamedToolDetail(identity: ToolCallIdentity): string {
  const tool = prettifyToolAction(identity.tool) ?? "Running tool";
  const argumentSummary = summarizeToolArguments(identity.input);
  return argumentSummary ? `${tool}: ${argumentSummary}` : tool;
}

function prettifyToolAction(value: string | null): string | null {
  const normalized = value?.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => normalizeInlinePreview(line))
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function formatOutputByteCount(byteCount: number): string {
  if (byteCount < 1_024) {
    return `${byteCount.toLocaleString()} B`;
  }
  if (byteCount < 1_024 * 1_024) {
    return `${(byteCount / 1_024).toLocaleString(undefined, {
      maximumFractionDigits: 1,
    })} KB`;
  }
  return `${(byteCount / (1_024 * 1_024)).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} MB`;
}

function summarizeStreamingToolOutput(payload: Record<string, unknown> | null): string | null {
  const streamKind = asTrimmedString(payload?.streamKind);
  if (streamKind !== "command_output" && streamKind !== "file_change_output") {
    return null;
  }

  const lineCount = asNumber(payload?.lineCount);
  const byteCount = asNumber(payload?.byteCount);
  const truncated = payload?.truncated === true;
  if (lineCount !== null && lineCount > 0) {
    const suffix = truncated ? "+" : "";
    return `${lineCount.toLocaleString()} output line${lineCount === 1 ? "" : "s"}${suffix}`;
  }
  if (byteCount !== null && byteCount > 0) {
    const suffix = truncated ? "+" : "";
    return `${formatOutputByteCount(byteCount)} output${suffix}`;
  }
  return "Output streaming";
}

function formatToolName(serverOrNamespace: unknown, tool: unknown): string | null {
  const toolName = asTrimmedString(tool);
  if (!toolName) {
    return null;
  }
  const prefix = asTrimmedString(serverOrNamespace);
  return prefix && !toolName.toLowerCase().startsWith(`${prefix.toLowerCase()}.`)
    ? `${prefix}.${toolName}`
    : toolName;
}

function summarizeToolArguments(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return truncateInlinePreview(normalizeInlinePreview(direct));
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const summaryParts: string[] = [];
  for (const key of [
    "url",
    "uri",
    "path",
    "filePath",
    "query",
    "q",
    "pattern",
    "selector",
    "ref_id",
    "id",
    "text",
    "prompt",
    "description",
  ]) {
    const summaryValue = asTrimmedString(record[key]);
    if (!summaryValue) {
      continue;
    }
    summaryParts.push(`${key}=${truncateInlinePreview(normalizeInlinePreview(summaryValue), 48)}`);
    if (summaryParts.length >= 2) {
      break;
    }
  }

  return summaryParts.length > 0 ? summaryParts.join(" ") : null;
}

function summarizeToolRequest(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemType = extractWorkLogItemType(payload);
  if (
    itemType !== "mcp_tool_call" &&
    itemType !== "dynamic_tool_call" &&
    itemType !== "collab_agent_tool_call" &&
    itemType !== "web_search"
  ) {
    return null;
  }

  const toolName = formatToolName(
    item?.server ?? data?.server ?? item?.namespace ?? data?.namespace,
    item?.tool ?? data?.tool,
  );
  if (!toolName) {
    return null;
  }

  const argumentSummary = summarizeToolArguments(item?.arguments ?? data?.arguments);
  return argumentSummary ? `${toolName}: ${argumentSummary}` : toolName;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const streamingOutputSummary = summarizeStreamingToolOutput(payload);
  if (streamingOutputSummary) {
    return streamingOutputSummary;
  }

  const semanticDetail = semanticToolPresentation(payload)?.detail;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedSemanticDetail = normalizePreviewForComparison(semanticDetail);
  if (semanticDetail && normalizedSemanticDetail !== normalizedHeading) {
    return semanticDetail;
  }

  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  const toolRequestSummary = summarizeToolRequest(payload);
  if (toolRequestSummary) {
    const normalizedToolRequestSummary = normalizePreviewForComparison(toolRequestSummary);
    if (normalizedToolRequestSummary !== normalizedHeading) {
      return toolRequestSummary;
    }
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

/** Claude bash failures lead with a literal "Exit code N" line; lift it into
 *  the structured field so output previews start at the actual error text. */
function liftLeadingExitCode(output: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const match = /^exit code (?<code>\d+)[ \t]*(?:\r?\n)?/iu.exec(output);
  if (!match?.groups) {
    return { output };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const rest = output.slice(match[0].length).trim();
  return {
    output: rest.length > 0 ? rest : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change" ||
    payload?.requestKind === "permissions"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  // Claude Code tool inputs use snake_case path keys.
  pushChangedFile(target, seen, record.file_path);
  pushChangedFile(target, seen, record.notebook_path);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function changedFileStatKind(value: unknown): FileChangeStat["kind"] {
  // Claude emits a plain string; Codex wraps it as `{ type: "add" | ... }`.
  const kind = typeof value === "string" ? value : asRecord(value)?.type;
  return kind === "add" || kind === "update" || kind === "delete" ? kind : undefined;
}

function changedFileStatFromRecord(value: unknown): FileChangeStat | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const path =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.file_path);
  if (!path) {
    return null;
  }
  const kind = changedFileStatKind(record.kind);

  if (
    typeof record.additions === "number" &&
    Number.isFinite(record.additions) &&
    typeof record.deletions === "number" &&
    Number.isFinite(record.deletions)
  ) {
    return { path, kind, additions: record.additions, deletions: record.deletions };
  }

  const diff = typeof record.diff === "string" ? record.diff : undefined;
  if (diff !== undefined) {
    return { path, kind, ...countUnifiedDiffStats(diff) };
  }

  return null;
}

/** Reads provider-reported per-file diff stats from a tool payload:
 *  `data.changes` (Claude file tools, Codex patch updates) or
 *  `data.item.changes` (Codex item lifecycle). */
function extractChangedFileStats(payload: Record<string, unknown> | null): FileChangeStat[] {
  const data = asRecord(payload?.data);
  const changes = data?.changes ?? asRecord(data?.item)?.changes;
  if (!Array.isArray(changes)) {
    return [];
  }

  const stats: FileChangeStat[] = [];
  const seenPaths = new Set<string>();
  for (const change of changes) {
    const stat = changedFileStatFromRecord(change);
    if (!stat || seenPaths.has(stat.path)) {
      continue;
    }
    seenPaths.add(stat.path);
    stats.push(stat);
    if (stats.length >= 12) {
      break;
    }
  }
  return stats;
}

function mergeChangedFileStats(
  previous: ReadonlyArray<FileChangeStat> | undefined,
  next: ReadonlyArray<FileChangeStat> | undefined,
): FileChangeStat[] {
  const byPath = new Map<string, FileChangeStat>();
  for (const stat of [...(previous ?? []), ...(next ?? [])]) {
    byPath.set(stat.path, stat);
  }
  return [...byPath.values()];
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
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

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  subagentResults: SubagentResultEntry[] = [],
  forkContexts: ForkContextEntry[] = [],
  subagentLiveEntries: SubagentLiveEntry[] = [],
): TimelineEntry[] {
  const suppressedAssistantEchoIds = findSubagentResultEchoMessageIds(messages, subagentResults);
  const messageRows: TimelineEntry[] = messages
    .filter((message) => !suppressedAssistantEchoIds.has(message.id))
    .map((message) => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  const subagentResultRows: TimelineEntry[] = subagentResults.map((result) => ({
    id: result.id,
    kind: "subagent-result",
    createdAt: result.createdAt,
    result,
  }));
  const subagentLiveRows: TimelineEntry[] = subagentLiveEntries.map((live) => ({
    id: live.id,
    kind: "subagent-live",
    createdAt: live.createdAt,
    live,
  }));
  const forkContextRows: TimelineEntry[] = forkContexts.map((forkContext) => ({
    id: forkContext.id,
    kind: "fork-context",
    createdAt: forkContext.createdAt,
    forkContext,
  }));
  return [
    ...forkContextRows,
    ...messageRows,
    ...proposedPlanRows,
    ...workRows,
    ...subagentLiveRows,
    ...subagentResultRows,
  ].toSorted((a, b) => {
    const timeDelta = a.createdAt.localeCompare(b.createdAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    const rank = (entry: TimelineEntry) => (entry.kind === "fork-context" ? 0 : 1);
    return rank(a) - rank(b);
  });
}

function findSubagentResultEchoMessageIds(
  messages: ReadonlyArray<ChatMessage>,
  subagentResults: ReadonlyArray<SubagentResultEntry>,
): Set<MessageId> {
  const subagentBodiesByTurnId = new Map<TurnId, Set<string>>();
  for (const result of subagentResults) {
    const body = normalizeExactSubagentEchoText(result.body);
    if (!result.turnId || body === null) {
      continue;
    }
    const bodies = subagentBodiesByTurnId.get(result.turnId) ?? new Set<string>();
    bodies.add(body);
    subagentBodiesByTurnId.set(result.turnId, bodies);
  }

  const suppressed = new Set<MessageId>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.turnId) {
      continue;
    }
    const body = normalizeExactSubagentEchoText(message.text);
    if (body === null) {
      continue;
    }
    if (subagentBodiesByTurnId.get(message.turnId)?.has(body)) {
      suppressed.add(message.id);
    }
  }
  return suppressed;
}

function normalizeExactSubagentEchoText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
