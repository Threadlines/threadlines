import type {
  OrchestrationSubagent,
  OrchestrationSubagentSettingProvenance,
  OrchestrationSubagentStatus,
  OrchestrationThreadActivity,
  TurnId,
} from "@threadlines/contracts";

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
  if (status === "failed" || status === "error") return "failed";
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
  const item = record(data?.item);
  if (!item) return [];
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
    tool === "spawnAgent"
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

/** Fold one timeline activity into the uncapped durable child-agent roster. */
export function projectSubagentActivity(
  current: ReadonlyArray<OrchestrationSubagent>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationSubagent> {
  const patches = patchForActivity(activity);
  if (patches.length === 0) return current;
  const next = [...current];
  for (const patch of patches) {
    const index = next.findIndex(
      (entry) =>
        (patch.agentThreadId !== null && patch.agentThreadId === entry.agentThreadId) ||
        (patch.spawnCallId !== null && patch.spawnCallId === entry.spawnCallId) ||
        patch.id === entry.id,
    );
    const merged = mergeSubagent(index >= 0 ? next[index] : undefined, patch, activity);
    if (index >= 0) next[index] = merged;
    else next.push(merged);
  }
  return next.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}
