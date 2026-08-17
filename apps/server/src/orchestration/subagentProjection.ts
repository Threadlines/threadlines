import type {
  OrchestrationSubagent,
  OrchestrationSubagentSettingProvenance,
  OrchestrationSubagentStatus,
  OrchestrationThreadActivity,
  TurnId,
} from "@threadlines/contracts";
import {
  claudeSubagentActivityItem,
  isClaudeSubagentToolName,
  isSpawnAgentTool,
} from "@threadlines/shared/claudeSubagentActivity";
import { isRootAgentPath } from "@threadlines/shared/subagentPath";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function settingProvenance(value: unknown): OrchestrationSubagentSettingProvenance | null {
  return value === "explicit" || value === "inherited" || value === "provider" ? value : null;
}

function explicitStatus(value: unknown): OrchestrationSubagentStatus | null {
  return value === "starting" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : null;
}

function lifecycleStatus(input: {
  readonly tool: string | null;
  readonly nativeKind: string | null;
  readonly itemStatus: string | null;
  readonly agentState: string | null;
}): OrchestrationSubagentStatus {
  const status = input.agentState?.toLowerCase() ?? input.itemStatus?.toLowerCase() ?? null;
  if (status === "failed" || status === "error" || status === "errored") return "failed";
  if (status === "interrupted" || status === "cancelled" || status === "canceled") {
    return "interrupted";
  }
  if (status === "completed" || status === "done") return "completed";
  if (status === "waiting" || input.tool === "wait") return "waiting";
  if (input.nativeKind === "interrupted" || input.tool === "closeAgent") return "interrupted";
  return input.nativeKind === "started" ? "starting" : "running";
}

function parentPath(agentPath: string | null): string | null {
  if (!agentPath) return null;
  const segments = agentPath.split("/").filter(Boolean);
  return segments.length > 2 ? `/${segments.slice(0, -1).join("/")}` : null;
}

function treeDepth(agentPath: string | null): number {
  return Math.max(0, (agentPath?.split("/").filter(Boolean).length ?? 1) - 2);
}

interface SubagentPatch {
  readonly id: string;
  readonly agentThreadId?: string | null;
  readonly parentAgentThreadId?: string | null;
  readonly spawnCallId?: string | null;
  readonly transcriptAgentId?: string | null;
  readonly turnId?: TurnId | null;
  readonly agentPath?: string | null;
  readonly parentAgentPath?: string | null;
  readonly treeDepth?: number;
  readonly nickname?: string | null;
  readonly role?: string | null;
  readonly objective?: string | null;
  readonly status?: OrchestrationSubagentStatus;
  readonly requestedModel?: string | null;
  readonly resolvedModel?: string | null;
  readonly reasoningEffort?: string | null;
  readonly modelProvenance?: OrchestrationSubagentSettingProvenance | null;
  readonly reasoningEffortProvenance?: OrchestrationSubagentSettingProvenance | null;
  readonly resultBody?: string | null;
  readonly resultCreatedAt?: string | null;
}

function metadataPatch(activity: OrchestrationThreadActivity): SubagentPatch | null {
  if (activity.kind !== "subagent.metadata") return null;
  const payload = record(activity.payload);
  if (!payload) return null;
  const agentThreadId = text(payload.agentThreadId);
  const spawnCallId = text(payload.spawnCallId) ?? text(payload.callId);
  const id = agentThreadId ?? (spawnCallId ? `pending:${spawnCallId}` : null);
  if (!id) return null;
  const agentPath = text(payload.agentPath);
  const modelSource = settingProvenance(payload.modelSource ?? payload.modelProvenance);
  const effortSource = settingProvenance(
    payload.reasoningEffortSource ?? payload.reasoningEffortProvenance,
  );
  const model = text(payload.model);
  const status = explicitStatus(payload.status);
  return {
    id,
    agentThreadId,
    parentAgentThreadId: text(payload.parentAgentThreadId),
    spawnCallId,
    transcriptAgentId: text(payload.transcriptAgentId),
    turnId: (text(payload.turnId) as TurnId | null) ?? activity.turnId,
    agentPath,
    parentAgentPath: text(payload.parentAgentPath) ?? parentPath(agentPath),
    treeDepth: integer(payload.treeDepth) ?? treeDepth(agentPath),
    nickname: text(payload.nickname) ?? text(payload.agentNickname),
    role: text(payload.role) ?? text(payload.agentRole) ?? text(payload.taskName),
    objective: text(payload.objective) ?? text(payload.prompt),
    ...(status === null ? {} : { status }),
    requestedModel:
      text(payload.requestedModel) ??
      (modelSource === "explicit" || modelSource === "inherited" ? model : null),
    resolvedModel: text(payload.resolvedModel) ?? (modelSource === "provider" ? model : null),
    reasoningEffort: text(payload.reasoningEffort),
    modelProvenance: modelSource === "explicit" || modelSource === "inherited" ? modelSource : null,
    reasoningEffortProvenance: effortSource,
    resultBody: typeof payload.resultBody === "string" ? payload.resultBody : null,
    resultCreatedAt: text(payload.resultCreatedAt),
  };
}

function collabPatches(activity: OrchestrationThreadActivity): SubagentPatch[] {
  const payload = record(activity.payload);
  if (text(payload?.itemType) !== "collab_agent_tool_call") return [];
  const data = record(payload?.data);
  // Claude's Agent/Task tool rows carry no nested item; the shared shaper
  // reconstructs the same collab item the Codex driver emits natively.
  const item =
    record(data?.item) ??
    (payload
      ? claudeSubagentActivityItem({
          activityId: activity.id,
          activityKind: activity.kind,
          payload,
          data,
        })
      : null);
  if (!item) return [];
  if (isRootAgentPath(text(item.agentPath))) return [];
  const tool = text(item.tool);
  const nativeAgentId = text(item.agentThreadId);
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.map(text).filter((value): value is string => value !== null)
    : [];
  const states = record(item.agentsStates);
  const stateAgentIds = states ? Object.keys(states) : [];
  const agentIds = [
    ...new Set([...(nativeAgentId ? [nativeAgentId] : []), ...receivers, ...stateAgentIds]),
  ];
  const spawnCallId =
    isSpawnAgentTool(tool) || isClaudeSubagentToolName(tool)
      ? (text(item.id) ?? text(data?.itemId) ?? text(payload?.toolCallId))
      : null;
  const ids =
    agentIds.length > 0
      ? agentIds
      : tool === "spawnAgent" && spawnCallId
        ? [`pending:${spawnCallId}`]
        : [];
  const agentPath = text(item.agentPath);
  const requestedModel = text(item.model);
  const reasoningEffort = text(item.reasoningEffort);
  return ids.map((id) => {
    const state = record(states?.[id]);
    return {
      id,
      agentThreadId: id.startsWith("pending:") ? null : id,
      parentAgentThreadId: text(item.parentAgentThreadId),
      spawnCallId,
      transcriptAgentId: id.startsWith("pending:") ? null : id,
      turnId: activity.turnId,
      agentPath,
      parentAgentPath: parentPath(agentPath),
      treeDepth: treeDepth(agentPath),
      nickname: text(item.agentNickname) ?? text(item.agent_nickname) ?? text(item.nickname),
      role: text(item.agentRole) ?? text(item.role),
      objective: text(item.prompt),
      status: lifecycleStatus({
        tool,
        nativeKind: text(item.kind),
        itemStatus: text(item.status) ?? text(payload?.status),
        agentState: text(state?.status),
      }),
      requestedModel,
      resolvedModel: text(item.resolvedModel),
      reasoningEffort,
      modelProvenance: requestedModel ? "explicit" : null,
      reasoningEffortProvenance: reasoningEffort ? "explicit" : null,
      resultBody: text(state?.message),
      resultCreatedAt: text(state?.message) ? activity.createdAt : null,
    };
  });
}

function patchForActivity(activity: OrchestrationThreadActivity): SubagentPatch[] {
  const metadata = metadataPatch(activity);
  return metadata ? [metadata] : collabPatches(activity);
}

function mergeValue<T>(incoming: T | null | undefined, current: T | null): T | null {
  return incoming ?? current;
}

function mergeSubagent(
  current: OrchestrationSubagent | undefined,
  patch: SubagentPatch,
  activity: OrchestrationThreadActivity,
): OrchestrationSubagent {
  return {
    id: patch.agentThreadId ?? current?.agentThreadId ?? patch.id,
    agentThreadId: mergeValue(patch.agentThreadId, current?.agentThreadId ?? null),
    parentAgentThreadId: mergeValue(
      patch.parentAgentThreadId,
      current?.parentAgentThreadId ?? null,
    ),
    spawnCallId: mergeValue(patch.spawnCallId, current?.spawnCallId ?? null),
    transcriptAgentId: mergeValue(patch.transcriptAgentId, current?.transcriptAgentId ?? null),
    turnId: mergeValue(patch.turnId, current?.turnId ?? null),
    agentPath: mergeValue(patch.agentPath, current?.agentPath ?? null),
    parentAgentPath: mergeValue(patch.parentAgentPath, current?.parentAgentPath ?? null),
    treeDepth: patch.treeDepth ?? current?.treeDepth ?? 0,
    nickname: mergeValue(patch.nickname, current?.nickname ?? null),
    role: mergeValue(patch.role, current?.role ?? null),
    objective: mergeValue(patch.objective, current?.objective ?? null),
    status: patch.status ?? current?.status ?? "starting",
    requestedModel: mergeValue(patch.requestedModel, current?.requestedModel ?? null),
    resolvedModel: mergeValue(patch.resolvedModel, current?.resolvedModel ?? null),
    reasoningEffort: mergeValue(patch.reasoningEffort, current?.reasoningEffort ?? null),
    modelProvenance: mergeValue(patch.modelProvenance, current?.modelProvenance ?? null),
    reasoningEffortProvenance: mergeValue(
      patch.reasoningEffortProvenance,
      current?.reasoningEffortProvenance ?? null,
    ),
    resultBody: mergeValue(patch.resultBody, current?.resultBody ?? null),
    resultCreatedAt: mergeValue(patch.resultCreatedAt, current?.resultCreatedAt ?? null),
    createdAt: current?.createdAt ?? activity.createdAt,
    updatedAt: activity.createdAt,
  };
}

/** Settles a spawned agent's status from a task.completed activity that links
 *  back via toolUseId (the spawn call id doubles as the agent id for Claude).
 *  Update-only: background command tasks share the activity kind, so a
 *  completion that matches no known agent must not invent a roster row. */
function settleTaskCompletion(
  current: ReadonlyArray<OrchestrationSubagent>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationSubagent> {
  const payload = record(activity.payload);
  const toolUseId = text(payload?.toolUseId);
  // A completion synthesized after a session restart carries only the taskId;
  // the transcript link learned from the task stream is what still names the
  // agent then.
  const taskId = text(payload?.taskId);
  if (!toolUseId && !taskId) return current;
  const index = current.findIndex(
    (entry) =>
      (toolUseId !== null &&
        (entry.agentThreadId === toolUseId ||
          entry.spawnCallId === toolUseId ||
          entry.id === toolUseId)) ||
      (taskId !== null && entry.transcriptAgentId === taskId),
  );
  const existing = index >= 0 ? current[index] : undefined;
  if (!existing) return current;
  const rawStatus = text(payload?.status);
  const status: OrchestrationSubagentStatus =
    rawStatus === "failed" ? "failed" : rawStatus === "stopped" ? "interrupted" : "completed";
  if (existing.status === status && existing.updatedAt >= activity.createdAt) return current;
  const next = [...current];
  next[index] = { ...existing, status, updatedAt: activity.createdAt };
  return next;
}

/** Claude addresses an agent's on-disk transcript by the task id it reports on
 *  the task stream, not by the spawning tool_use id this roster is keyed by.
 *  The task stream is the only place the two are linked, so the link is folded
 *  in here. Update-only for the same reason completions are: background
 *  command tasks share these activity kinds and must not become roster rows. */
function linkTaskTranscript(
  current: ReadonlyArray<OrchestrationSubagent>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationSubagent> {
  const payload = record(activity.payload);
  const taskId = text(payload?.taskId);
  const toolUseId = text(payload?.toolUseId);
  if (!taskId || !toolUseId) return current;
  const index = current.findIndex(
    (entry) =>
      entry.agentThreadId === toolUseId ||
      entry.spawnCallId === toolUseId ||
      entry.id === toolUseId,
  );
  const existing = index >= 0 ? current[index] : undefined;
  if (!existing || existing.transcriptAgentId === taskId) return current;
  const next = [...current];
  next[index] = { ...existing, transcriptAgentId: taskId };
  return next;
}

/** Fold one timeline activity into the uncapped durable child-agent roster. */
export function projectSubagentActivity(
  current: ReadonlyArray<OrchestrationSubagent>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationSubagent> {
  if (activity.kind === "task.started" || activity.kind === "task.progress") {
    return linkTaskTranscript(current, activity);
  }
  if (activity.kind === "task.completed") {
    return linkTaskTranscript(settleTaskCompletion(current, activity), activity);
  }
  const patches = patchForActivity(activity);
  if (patches.length === 0) return current;
  const next = [...current];
  for (const patch of patches) {
    // A patch can match more than one row: a spawn that started as a
    // `pending:` placeholder and an id-keyed row learned from a later item
    // are the same agent once a patch carries both keys. All matches merge
    // into one row — the persisted table is unique on id, agentThreadId and
    // spawnCallId per thread, so leaving both rows behind is not a cosmetic
    // duplicate but a constraint violation that fails the write.
    const matches: number[] = [];
    for (let index = 0; index < next.length; index += 1) {
      const entry = next[index];
      if (
        entry &&
        ((patch.agentThreadId !== null && patch.agentThreadId === entry.agentThreadId) ||
          (patch.spawnCallId !== null && patch.spawnCallId === entry.spawnCallId) ||
          patch.id === entry.id)
      ) {
        matches.push(index);
      }
    }
    const [primary, ...absorbed] = matches;
    let base = primary !== undefined ? next[primary] : undefined;
    for (const index of absorbed) {
      const duplicate = next[index];
      if (base && duplicate) {
        base = mergeSubagent(
          base,
          { ...duplicatePatchFrom(duplicate), id: duplicate.id },
          activity,
        );
      }
    }
    const merged = mergeSubagent(base, patch, activity);
    if (primary !== undefined) next[primary] = merged;
    else next.push(merged);
    for (let cursor = absorbed.length - 1; cursor >= 0; cursor -= 1) {
      const index = absorbed[cursor];
      if (index !== undefined) next.splice(index, 1);
    }
  }
  return next.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Reshapes an absorbed duplicate row into a patch so its learned fields fold
 *  into the surviving row through the same merge path patches use. */
function duplicatePatchFrom(duplicate: OrchestrationSubagent): SubagentPatch {
  return {
    id: duplicate.id,
    agentThreadId: duplicate.agentThreadId,
    parentAgentThreadId: duplicate.parentAgentThreadId,
    spawnCallId: duplicate.spawnCallId,
    transcriptAgentId: duplicate.transcriptAgentId,
    turnId: duplicate.turnId,
    agentPath: duplicate.agentPath,
    parentAgentPath: duplicate.parentAgentPath,
    treeDepth: duplicate.treeDepth,
    nickname: duplicate.nickname,
    role: duplicate.role,
    objective: duplicate.objective,
    status: duplicate.status,
    requestedModel: duplicate.requestedModel,
    resolvedModel: duplicate.resolvedModel,
    reasoningEffort: duplicate.reasoningEffort,
    modelProvenance: duplicate.modelProvenance,
    reasoningEffortProvenance: duplicate.reasoningEffortProvenance,
    resultBody: duplicate.resultBody,
    resultCreatedAt: duplicate.resultCreatedAt,
  };
}
