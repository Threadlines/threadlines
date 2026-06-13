import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { countUnifiedDiffStats, type FileChangeStat } from "@t3tools/shared/diffStats";

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

export interface WorkLogEntry {
  id: string;
  createdAt: string;
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
  requestKind?: PendingApproval["requestKind"];
  executionState?: "running" | "completed" | "failed";
  turnId?: TurnId | null;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  toolCallId?: string;
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
  if (input.phase === "connecting" || input.isConnecting) return "Connecting";
  if (input.isSessionStarting) return "Starting session";
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

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending codex approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
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
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const environmentId =
      payload && typeof payload.environmentId === "string" ? payload.environmentId : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(environmentId ? { environmentId } : {}),
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
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
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
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
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries = ordered
    .filter((activity) => activity.kind !== "task.started")
    .filter((activity) => activity.kind !== "context-window.updated")
    // Account telemetry; belongs in a usage meter, not the work narrative.
    .filter((activity) => activity.kind !== "account.rate-limits.updated")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .map(toDerivedWorkLogEntry);
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

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
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
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : (extractRuntimeActivityDetail(activity, payload) ??
      extractToolDetail(payload, title ?? activity.summary));
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  // Recurring transient warnings (API retries) read as a status line: the
  // message is the label, and repeats collapse into one updating row.
  const transientWarningLabel =
    activity.kind === "runtime.warning" && asTrimmedString(payload?.warningKind) === "api-retry"
      ? asTrimmedString(payload?.message)
      : undefined;
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    label: transientWarningLabel ?? (taskLabel || activity.summary),
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
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  const executionState = deriveWorkLogExecutionState(activity, entry, payload);
  if (executionState) {
    entry.executionState = executionState;
  }
  if (activity.kind === "thinking.progress") {
    entry.redactedThinking = isRedactedThinkingActivity;
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

    const previous = findPreviousReviewableWorkEntry(entries, index);
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
): DerivedWorkLogEntry | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (!candidate || candidate.tone === "thinking") {
      continue;
    }
    if (reviewDetailForPreviousWorkEntry(candidate)) {
      return candidate;
    }
  }
  return null;
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
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const turnId = next.turnId ?? previous.turnId;
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
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
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
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
  return asTrimmedString(payload?.title);
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

  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
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
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
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
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
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
