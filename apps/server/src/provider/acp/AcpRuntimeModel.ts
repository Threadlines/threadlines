import type * as EffectAcpSchema from "effect-acp/schema";
import { deriveToolActivityPresentation } from "@threadlines/shared/toolActivity";
import type { ToolLifecycleItemType } from "@threadlines/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

export interface AcpPlanUpdate {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface AcpPermissionRequest {
  readonly kind: string | "unknown";
  readonly detail?: string;
  readonly toolCall?: AcpToolCallState;
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: "ModeChanged";
      readonly modeId: string;
    }
  | {
      readonly _tag: "AssistantItemStarted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "AssistantItemCompleted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "PlanUpdated";
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdated";
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ContentDelta";
      readonly itemId?: string;
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      /** Provider-side turn status, e.g. fx's "Rate limited · retrying" recovery. */
      readonly _tag: "SessionStatus";
      readonly message: string;
    }
  | {
      /** The agent's reasoning text, from ACP `agent_thought_chunk`. */
      readonly _tag: "ReasoningDelta";
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      /** How full the context window is, from ACP `usage_update`. */
      readonly _tag: "ContextUsage";
      readonly usedTokens: number;
      readonly maxTokens?: number;
    };

type AcpSessionSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

/**
 * The config option that selects the model. Prefers the conventional `model`
 * id, then falls back to the first `model`-category select — some agents
 * (fx) file a `provider` picker under the same category ahead of the model.
 */
export function findModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) return undefined;
  const byId = configOptions.find(
    (option) => option.id.trim().toLowerCase() === "model" && option.type === "select",
  );
  if (byId) return byId;
  return configOptions.find(
    (option) =>
      option.category === "model" &&
      option.type === "select" &&
      option.id.trim().length > 0 &&
      option.id.trim().toLowerCase() !== "provider",
  );
}

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined {
  return findModelConfigOption(sessionResponse.configOptions)?.id.trim();
}

/** Ids of the config options that stand in for the older `modes` / `models` fields. */
export const LEGACY_MODE_OPTION_ID = "mode";
export const LEGACY_MODEL_OPTION_ID = "model";

/** An option that lets the user choose the agent's mode (its id or category says so). */
export function isModeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  return option.category === "mode" || option.id.trim().toLowerCase() === LEGACY_MODE_OPTION_ID;
}

/**
 * The older `modes` and `models` session fields as config options, each only
 * where the agent lists no option of its own for it. Agents driven through
 * their own controls (`sessionControls: "native"`) then need one code path:
 * options. The runtime routes a change of these two to `session/set_mode` /
 * `session/set_model`. A stand-in never shares an id with an option the
 * agent lists.
 */
export function legacyControlConfigOptions(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly modeState: AcpSessionModeState | undefined;
  readonly modelState: EffectAcpSchema.SessionModelState | null | undefined;
}): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  const legacy: Array<EffectAcpSchema.SessionConfigOption> = [];
  if (input.modeState && !input.configOptions.some(isModeConfigOption)) {
    legacy.push({
      type: "select",
      id: LEGACY_MODE_OPTION_ID,
      name: "Mode",
      category: "mode",
      currentValue: input.modeState.currentModeId,
      options: input.modeState.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    });
  }
  const models = (input.modelState?.availableModels ?? []).flatMap((model) => {
    const value = model.modelId.trim();
    return value ? [{ value, name: model.name.trim() || value }] : [];
  });
  const currentModel = input.modelState?.currentModelId.trim();
  const modelIdTaken = input.configOptions.some(
    (option) => option.id.trim().toLowerCase() === LEGACY_MODEL_OPTION_ID,
  );
  if (
    currentModel &&
    models.length > 0 &&
    !modelIdTaken &&
    !findModelConfigOption(input.configOptions)
  ) {
    legacy.push({
      type: "select",
      id: LEGACY_MODEL_OPTION_ID,
      name: "Model",
      category: "model",
      currentValue: currentModel,
      options: models,
    });
  }
  return legacy;
}

export function findSessionConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  const normalizedConfigId = configId.trim();
  if (!normalizedConfigId) {
    return undefined;
  }
  return configOptions.find((option) => option.id.trim() === normalizedConfigId);
}

export function collectSessionConfigOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string> {
  if (configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

export function parseSessionModeState(
  sessionResponse: AcpSessionSetupResponse,
): AcpSessionModeState | undefined {
  const modes = sessionResponse.modes;
  if (!modes) return undefined;
  const currentModeId = modes.currentModeId.trim();
  if (!currentModeId) {
    return undefined;
  }
  const availableModes = modes.availableModes
    .map((mode) => {
      const id = mode.id.trim();
      const name = mode.name.trim();
      if (!id || !name) {
        return undefined;
      }
      const description = mode.description?.trim() || undefined;
      return description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode);
    })
    .filter((mode): mode is AcpSessionMode => mode !== undefined);
  if (availableModes.length === 0) {
    return undefined;
  }
  return {
    currentModeId,
    availableModes,
  };
}

function normalizePlanStepStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

/** The first present field among the spellings agents use for it. */
function firstField(record: Record<string, unknown>, keys: ReadonlyArray<string>): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

// Antigravity alone uses three spellings (`CommandLine` on the call,
// `command_line` on updates, `commandLine` in results).
const COMMAND_KEYS = ["command", "commandLine", "CommandLine", "command_line", "cmd"];
const CWD_KEYS = ["cwd", "Cwd", "workingDir", "working_dir", "WorkingDirectory"];
const OUTPUT_KEYS = ["aggregatedOutput", "combinedOutput", "combined_output", "output", "stdout"];
const EXIT_CODE_KEYS = ["exitCode", "exit_code"];

/**
 * The command, cwd, output and exit code of a shell tool call in the shape
 * Codex reports them (`data.item`), so the timeline shows exit codes the
 * same way for every agent.
 */
function commandExecutionItem(
  rawInput: unknown,
  rawOutput: unknown,
  command: string | undefined,
): Record<string, unknown> | undefined {
  const input = isRecord(rawInput) ? rawInput : {};
  const output = isRecord(rawOutput) ? rawOutput : {};
  const cwd = firstField(input, CWD_KEYS) ?? firstField(output, CWD_KEYS);
  const aggregatedOutput =
    firstField(output, OUTPUT_KEYS) ?? (typeof rawOutput === "string" ? rawOutput : undefined);
  const exitCode = firstField(output, EXIT_CODE_KEYS);
  const item = {
    ...(command ? { command } : {}),
    ...(typeof cwd === "string" && cwd.trim() ? { cwd: cwd.trim() } : {}),
    ...(typeof aggregatedOutput === "string" ? { aggregatedOutput } : {}),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
  };
  return Object.keys(item).length > 0 ? item : undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(firstField(rawInput, COMMAND_KEYS));
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const chunks = content
    .map((entry) => {
      if (entry.type !== "content") {
        return undefined;
      }
      const nestedContent = entry.content;
      if (nestedContent.type !== "text") {
        return undefined;
      }
      return nestedContent.text.trim().length > 0 ? nestedContent.text.trim() : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: EffectAcpSchema.ToolKind | null | undefined;
    readonly status?: EffectAcpSchema.ToolCallStatus | null | undefined;
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined;
    readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined;
  },
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  const toolCallId = input.toolCallId.trim();
  if (!toolCallId) {
    return undefined;
  }
  const title = input.title?.trim() || undefined;
  const command = extractToolCallCommand(input.rawInput, title);
  const textContent = extractTextContentFromToolCallContent(input.content);
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const data: Record<string, unknown> = { toolCallId };
  const kind = normalizeToolKind(input.kind);
  if (kind) {
    data.kind = kind;
  }
  if (command) {
    data.command = command;
  }
  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = input.rawOutput;
  }
  if (input.content !== undefined) {
    data.content = input.content;
  }
  if (input.locations !== undefined) {
    data.locations = input.locations;
  }
  if (kind === "execute") {
    const item = commandExecutionItem(input.rawInput, input.rawOutput, command);
    if (item) data.item = item;
  }
  const fallbackDetail = command ?? normalizedTitle ?? textContent;
  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined;
  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType: canonicalItemTypeFromAcpToolKind(kind),
        title,
        detail: fallbackDetail,
        data,
        fallbackSummary: title ?? "Tool",
      })
    : undefined;
  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus);
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  };
}

function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
    },
    options,
  );
}

/**
 * Later updates override earlier ones field by field. A shell call's
 * `item` is rebuilt from the merged input and output: a result often names
 * neither the kind nor the command (Antigravity's completion does not).
 */
function mergeToolCallData(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  kind: string | undefined,
  command: string | undefined,
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...previous, ...next };
  if (kind === "execute") {
    const item = {
      ...(isRecord(previous?.item) ? previous.item : {}),
      ...commandExecutionItem(data.rawInput, data.rawOutput, command),
    };
    if (Object.keys(item).length > 0) data.item = item;
  }
  return data;
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = typeof next.data.kind === "string" ? next.data.kind : undefined;
  const kind = nextKind ?? previous?.kind;
  const title = next.title ?? previous?.title;
  const status = next.status ?? previous?.status;
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: mergeToolCallData(previous?.data, next.data, kind, command),
  };
}

/** The paths an edit's ACP `diff` content touches, for naming it in an approval. */
function diffContentPaths(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): ReadonlyArray<string> {
  return (content ?? []).flatMap((entry) =>
    entry.type === "diff" && entry.path.trim() ? [entry.path.trim()] : [],
  );
}

export function parsePermissionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionRequest {
  const toolCall = makeToolCallState(
    {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      kind: params.toolCall.kind,
      status: params.toolCall.status,
      rawInput: params.toolCall.rawInput,
      rawOutput: params.toolCall.rawOutput,
      content: params.toolCall.content,
      locations: params.toolCall.locations,
    },
    { fallbackStatus: "pending" },
  );
  const kind = normalizeToolKind(params.toolCall.kind) ?? "unknown";
  // An edit is named by the files it changes, not its generic title.
  const editedPaths = diffContentPaths(params.toolCall.content);
  const detail =
    toolCall?.command ??
    (editedPaths.length > 0 ? editedPaths.join(", ") : undefined) ??
    toolCall?.title ??
    toolCall?.detail ??
    (typeof params.sessionId === "string" ? `Session ${params.sessionId}` : undefined);
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
  };
}

function sessionInfoStatusMessage(update: { readonly _meta?: unknown }): string | undefined {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const fx = (meta as Record<string, unknown>).fx;
  if (typeof fx !== "object" || fx === null) return undefined;
  const recovery = (fx as Record<string, unknown>).modelResponseRecovery;
  if (typeof recovery !== "object" || recovery === null) return undefined;
  const message = (recovery as Record<string, unknown>).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

export function parseSessionUpdateEvent(params: EffectAcpSchema.SessionNotification): {
  readonly modeId?: string;
  readonly events: ReadonlyArray<AcpParsedSessionEvent>;
} {
  const upd = params.update;
  const events: Array<AcpParsedSessionEvent> = [];
  let modeId: string | undefined;

  switch (upd.sessionUpdate) {
    case "current_mode_update": {
      modeId = upd.currentModeId.trim();
      if (modeId) {
        events.push({
          _tag: "ModeChanged",
          modeId,
        });
      }
      break;
    }
    case "plan": {
      const plan = upd.entries.map((entry, index) => ({
        step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
        status: normalizePlanStepStatus(entry.status),
      }));
      if (plan.length > 0) {
        events.push({
          _tag: "PlanUpdated",
          payload: {
            plan,
          },
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call": {
      const toolCall = parseTypedToolCallState(upd, {
        fallbackStatus: "pending",
      });
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call_update": {
      const toolCall = parseTypedToolCallState(upd);
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_message_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        events.push({
          _tag: "ContentDelta",
          text: upd.content.text,
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_thought_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        events.push({
          _tag: "ReasoningDelta",
          text: upd.content.text,
          rawPayload: params,
        });
      }
      break;
    }
    case "session_info_update": {
      // fx reports mid-turn model recovery (rate limits, retries) through
      // vendor metadata here; without it a retried turn looks like a hang
      // and an exhausted retry looks like a model refusal.
      const message = sessionInfoStatusMessage(upd);
      if (message) {
        events.push({ _tag: "SessionStatus", message });
      }
      break;
    }
    case "usage_update": {
      const isCount = (value: number) => Number.isInteger(value) && value >= 0;
      if (isCount(upd.used)) {
        events.push({
          _tag: "ContextUsage",
          usedTokens: upd.used,
          ...(isCount(upd.size) && upd.size > 0 ? { maxTokens: upd.size } : {}),
        });
      }
      break;
    }
    default:
      break;
  }

  return { ...(modeId !== undefined ? { modeId } : {}), events };
}
