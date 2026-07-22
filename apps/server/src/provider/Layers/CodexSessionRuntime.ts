import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRealtimeAudioChunk,
  type ProviderRealtimeVoicesList,
  type ProviderReviewDelivery,
  type ProviderReviewTarget,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderSessionForkFrom,
  type ProviderStartReviewResult,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { planCliSpawn } from "../../cliSpawn.ts";
import { normalizeModelSlug } from "@threadlines/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SchemaIssue from "effect/SchemaIssue";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { CODEX_APP_SERVER_ARGS } from "../codexAppServerArgs.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);
const decodeV2ReviewStartResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ReviewStartResponse,
);
const decodeV2ThreadForkResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ThreadForkResponse,
);
const decodeV2TurnSteerParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams);
const decodeV2TurnSteerResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerResponse);
const decodeV2ThreadGoalSetResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ThreadGoalSetResponse,
);
const decodeV2ThreadGoalGetResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ThreadGoalGetResponse,
);
const CodexRealtimeAudioChunk = Schema.Struct({
  data: Schema.String,
  sampleRate: Schema.Number,
  numChannels: Schema.Number,
  samplesPerChannel: Schema.optional(Schema.Number),
  itemId: Schema.optional(Schema.String),
});
const CodexRealtimeStartParams = Schema.Struct({
  threadId: Schema.String,
  outputModality: Schema.Literals(["audio", "text"]),
  version: Schema.Literal("v3"),
});
const CodexRealtimeAppendAudioParams = Schema.Struct({
  threadId: Schema.String,
  audio: CodexRealtimeAudioChunk,
});
const CodexRealtimeStopParams = Schema.Struct({ threadId: Schema.String });
const CodexRealtimeListVoicesParams = Schema.Struct({});
const CodexRealtimeEmptyResponse = Schema.Struct({});
const CodexRealtimeVoicesList = Schema.Struct({
  v1: Schema.Array(Schema.String),
  v2: Schema.Array(Schema.String),
  defaultV1: Schema.String,
  defaultV2: Schema.String,
});
const CodexRealtimeListVoicesResponse = Schema.Struct({
  voices: CodexRealtimeVoicesList,
});
const decodeCodexRealtimeStartParams = Schema.decodeUnknownEffect(CodexRealtimeStartParams);
const decodeCodexRealtimeAppendAudioParams = Schema.decodeUnknownEffect(
  CodexRealtimeAppendAudioParams,
);
const decodeCodexRealtimeStopParams = Schema.decodeUnknownEffect(CodexRealtimeStopParams);
const decodeCodexRealtimeListVoicesParams = Schema.decodeUnknownEffect(
  CodexRealtimeListVoicesParams,
);
const decodeCodexRealtimeEmptyResponse = Schema.decodeUnknownEffect(CodexRealtimeEmptyResponse);
const decodeCodexRealtimeListVoicesResponse = Schema.decodeUnknownEffect(
  CodexRealtimeListVoicesResponse,
);

const PROVIDER = ProviderDriverKind.make("codex");
export const CODEX_THREAD_SOURCE = "threadlines";
const CODEX_APP_SERVER_REQUEST_TIMEOUT = Duration.seconds(60);

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+):\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
  "codex_models_manager::manager: failed to refresh available models: timeout",
  "mcp-transport-worker: worker quit with fatal: Transport channel closed",
];
const ACTIONABLE_SUPPRESSED_TOOL_FAILURE_STDERR_SNIPPETS = ["failed to connect to websocket"];
const CODEX_TOOL_ROUTER_LOG_TARGET = "codex_core::tools::router";
const CODEX_MCP_TRANSPORT_WORKER_LOG_TARGETS = new Set([
  "mcp-transport-worker",
  "mcp::transport::worker",
  "rmcp::transport::worker",
]);
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
  // Codex app-server >= 0.144 wording when the rollout JSONL backing a
  // thread id is absent, e.g. "no rollout found for thread id <uuid>".
  "no rollout found",
];

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly resumeCursor?: CodexResumeCursor;
  /** Fail session startup when a requested native thread cannot be resumed.
   *  External imports use this to avoid silently attaching an empty provider
   *  conversation to a transcript that was imported from another thread. */
  readonly resumeRequired?: boolean | undefined;
  /** Open the session as a provider-side fork of another thread's history.
   *  Ignored when `resumeCursor` is present (a restart resumes the session's
   *  own thread). Fork failures fail the start — the orchestration reactor
   *  owns the fallback to context-seed seeding. */
  readonly forkFrom?: ProviderSessionForkFrom;
  readonly onRealtimeAudio?: (audio: ProviderRealtimeAudioChunk) => Effect.Effect<void>;
}

/** Attachment input items appended after the prompt text. Codex app-server
 *  has no document input type, so non-image attachments arrive as extra
 *  text items referencing their staged local path. */
export type CodexTurnAttachmentInput =
  | { readonly type: "image"; readonly url: string }
  | { readonly type: "text"; readonly text: string };

export interface CodexTurnSkillInput {
  readonly type: "skill";
  readonly name: string;
  readonly path: string;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly clientUserMessageId?: string;
  readonly input?: string;
  readonly skills?: ReadonlyArray<CodexTurnSkillInput>;
  readonly attachments?: ReadonlyArray<CodexTurnAttachmentInput>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexSessionRuntimeSteerTurnInput {
  readonly expectedTurnId: TurnId;
  readonly clientUserMessageId?: string;
  readonly input?: string;
  readonly skills?: ReadonlyArray<CodexTurnSkillInput>;
  readonly attachments?: ReadonlyArray<CodexTurnAttachmentInput>;
}

export interface CodexSessionRuntimeStartReviewInput {
  readonly target: ProviderReviewTarget;
  readonly delivery?: ProviderReviewDelivery;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly steerTurn: (
    input: CodexSessionRuntimeSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly startReview: (
    input: CodexSessionRuntimeStartReviewInput,
  ) => Effect.Effect<ProviderStartReviewResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly realtimeStart: (
    input?: CodexSessionRuntimeRealtimeStartInput,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly realtimeStop: Effect.Effect<void, CodexSessionRuntimeError>;
  readonly realtimeAppendAudio: (
    audio: ProviderRealtimeAudioChunk,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly realtimeListVoices: Effect.Effect<ProviderRealtimeVoicesList, CodexSessionRuntimeError>;
  readonly compactContext: Effect.Effect<void, CodexSessionRuntimeError>;
  readonly setGoal: (
    input: CodexSessionRuntimeSetGoalInput,
  ) => Effect.Effect<CodexThreadGoal, CodexSessionRuntimeError>;
  readonly getGoal: Effect.Effect<CodexThreadGoal | null, CodexSessionRuntimeError>;
  readonly clearGoal: Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  /** Read any persisted Codex provider thread without resuming it. Callers
   * must authorize the provider thread before exposing its contents. */
  readonly readStoredThread: (
    providerThreadId: string,
  ) => Effect.Effect<EffectCodexSchema.V2ThreadReadResponse["thread"], CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly deleteThread: Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexThreadGoal = EffectCodexSchema.V2ThreadGoalSetResponse__ThreadGoal;

export interface CodexSessionRuntimeRealtimeStartInput {
  readonly outputModality?: "audio" | "text";
}

export interface CodexSessionRuntimeSetGoalInput {
  readonly objective?: string;
  readonly status?: EffectCodexSchema.V2ThreadGoalSetParams__ThreadGoalStatus;
  readonly tokenBudget?: number | null;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface CollabChildThreadMetadata {
  readonly agentNickname?: string;
  readonly agentRole?: string;
}

export type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
  readonly approvalsReviewer?: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    // Codex auto-review: same sandbox/approval surface as auto-accept-edits,
    // but escalation requests route to the reviewer subagent instead of the
    // user. Approvals the reviewer declines still fall back to the agent
    // (deny-and-continue), so no in-app prompt storm.
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    cwd: input.cwd,
    threadSource: CODEX_THREAD_SOURCE,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    ...(config.approvalsReviewer ? { approvalsReviewer: config.approvalsReviewer } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function buildThreadForkParams(input: {
  readonly sourceThreadId: string;
  readonly lastTurnId: string | undefined;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): EffectCodexSchema.V2ThreadForkParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    threadId: input.sourceThreadId,
    threadSource: CODEX_THREAD_SOURCE,
    ...(input.lastTurnId !== undefined ? { lastTurnId: input.lastTurnId } : {}),
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    ...(config.approvalsReviewer ? { approvalsReviewer: config.approvalsReviewer } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
    case "auto":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  return {
    mode: input.interactionMode,
    settings: {
      model,
      ...(input.effort ? { reasoning_effort: input.effort } : {}),
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly skills?: ReadonlyArray<CodexTurnSkillInput>;
  readonly attachments?: ReadonlyArray<CodexTurnAttachmentInput>;
  readonly clientUserMessageId?: string;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const skill of input.skills ?? []) {
    turnInput.push(skill);
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
    input: turnInput,
    ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
    approvalPolicy: config.approvalPolicy,
    ...(config.approvalsReviewer ? { approvalsReviewer: config.approvalsReviewer } : {}),
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/start request payload", error)),
  );
}

export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: TurnId;
  readonly prompt?: string;
  readonly skills?: ReadonlyArray<CodexTurnSkillInput>;
  readonly attachments?: ReadonlyArray<CodexTurnAttachmentInput>;
  readonly clientUserMessageId?: string;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnSteerParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const skill of input.skills ?? []) {
    turnInput.push(skill);
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  return decodeV2TurnSteerParams({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    input: turnInput,
    ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/steer request payload", error)),
  );
}

export function buildPermissionsApprovalResponse(
  payload: EffectCodexSchema.PermissionsRequestApprovalParams,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.PermissionsRequestApprovalResponse {
  const accepted = decision === "accept" || decision === "acceptForSession";
  if (!accepted) {
    return { permissions: {} };
  }

  return {
    permissions: payload.permissions,
    scope: decision === "acceptForSession" ? "session" : "turn",
  };
}

export function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  return makeCodexStderrLineClassifier().classify(rawLine);
}

export function makeCodexStderrLineClassifier(): {
  readonly classify: (rawLine: string) => { readonly message: string } | null;
} {
  let suppressLoggedToolFailureContinuation = false;

  return {
    classify: (rawLine) => {
      const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
      if (!line) {
        return null;
      }

      const match = line.match(CODEX_STDERR_LOG_REGEX);
      if (match) {
        suppressLoggedToolFailureContinuation = false;

        const level = match[1];
        const target = match[2];
        const message = match[3] ?? "";

        if (level && level !== "ERROR") {
          return null;
        }
        if (isBenignCodexErrorLog(line, target, message)) {
          return null;
        }
        if (isLoggedToolRouterExitCode(target, message)) {
          suppressLoggedToolFailureContinuation = true;
          return null;
        }

        return { message: line };
      }

      if (suppressLoggedToolFailureContinuation) {
        if (
          !ACTIONABLE_SUPPRESSED_TOOL_FAILURE_STDERR_SNIPPETS.some((snippet) =>
            line.toLowerCase().includes(snippet),
          )
        ) {
          return null;
        }
        suppressLoggedToolFailureContinuation = false;
      }

      return { message: line };
    },
  };
}

function isBenignCodexErrorLog(line: string, target: string | undefined, message: string): boolean {
  if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
    return true;
  }

  return (
    target !== undefined &&
    CODEX_MCP_TRANSPORT_WORKER_LOG_TARGETS.has(target) &&
    message.includes("worker quit with fatal: Transport channel closed")
  );
}

function isLoggedToolRouterExitCode(target: string | undefined, message: string): boolean {
  return target === CODEX_TOOL_ROUTER_LOG_TARGET && /^error=Exit code: \d+\b/.test(message);
}

/** True when the app-server predates `thread/fork` + `lastTurnId` (JSON-RPC
 *  method-not-found / invalid-params from Codex binaries older than 0.143),
 *  so callers can fall back to the deprecated `thread/rollback`. */
export function isNativeThreadForkUnsupportedError(error: unknown): boolean {
  return (
    error instanceof CodexErrors.CodexAppServerRequestError &&
    (error.code === -32601 || error.code === -32602)
  );
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/fork"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume" | "thread/fork";

interface CodexThreadOpenClient {
  readonly raw?: {
    readonly request: (
      method: string,
      payload?: unknown,
    ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  };
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

function codexRequestTimeoutError(operation: string): CodexErrors.CodexAppServerRequestError {
  return CodexErrors.CodexAppServerRequestError.internalError(
    `Timed out waiting for Codex App Server to ${operation}.`,
  );
}

function withCodexRequestTimeout<A, R>(
  operation: string,
  effect: Effect.Effect<A, CodexErrors.CodexAppServerError, R>,
): Effect.Effect<A, CodexErrors.CodexAppServerError, R> {
  return effect.pipe(
    Effect.timeoutOption(CODEX_APP_SERVER_REQUEST_TIMEOUT),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(codexRequestTimeoutError(operation)),
    ),
  );
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
  readonly resumeRequired?: boolean | undefined;
  /** Same-driver native fork. `beforeTurnId` is preferred for exact
   *  user-prompt replacement; `lastTurnId` remains the stable compatibility
   *  fallback. Only honored when there is no `resumeThreadId`. */
  readonly forkFrom?: ProviderSessionForkFrom | undefined;
  /** Invoked when a requested native resume is unrecoverable and the thread
   *  falls back to a fresh start. Lets callers surface the degraded resume
   *  instead of silently continuing without history. */
  readonly onResumeFallback?: (cause: string) => Effect.Effect<void>;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
  });

  if (resumeThreadId === undefined) {
    const forkFrom = input.forkFrom;
    if (forkFrom !== undefined) {
      const stableFork = () =>
        input.client.request(
          "thread/fork",
          buildThreadForkParams({
            sourceThreadId: forkFrom.providerThreadId,
            lastTurnId: forkFrom.lastTurnId,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            model: input.requestedModel,
            serviceTier: input.serviceTier,
          }),
        );
      const forkRequest =
        forkFrom.beforeTurnId !== undefined && input.client.raw !== undefined
          ? input.client.raw
              .request("thread/fork", {
                ...buildThreadForkParams({
                  sourceThreadId: forkFrom.providerThreadId,
                  lastTurnId: undefined,
                  cwd: input.cwd,
                  runtimeMode: input.runtimeMode,
                  model: input.requestedModel,
                  serviceTier: input.serviceTier,
                }),
                beforeTurnId: forkFrom.beforeTurnId,
              })
              .pipe(
                Effect.flatMap((response) =>
                  decodeV2ThreadForkResponse(response).pipe(
                    Effect.mapError((cause) =>
                      toProtocolParseError("Invalid thread/fork response", cause),
                    ),
                  ),
                ),
                Effect.catchIf(
                  (error) =>
                    forkFrom.lastTurnId !== undefined && isNativeThreadForkUnsupportedError(error),
                  stableFork,
                ),
              )
          : stableFork();
      return withCodexRequestTimeout("fork a Codex thread", forkRequest);
    }
    return withCodexRequestTimeout(
      "start a Codex thread",
      input.client.request("thread/start", startParams),
    );
  }

  // `threadSource` classifies newly created/forked threads. Resume does not
  // accept that field and retains the source already stored by Codex.
  const { threadSource: _threadSource, ...resumeParams } = startParams;
  const resume = withCodexRequestTimeout(
    "resume a Codex thread",
    input.client.request("thread/resume", {
      threadId: resumeThreadId,
      ...resumeParams,
    }),
  );

  if (input.resumeRequired === true) {
    return resume;
  }

  return resume.pipe(
    Effect.catchIf(isRecoverableThreadResumeError, (error) =>
      Effect.logWarning("codex app-server thread resume fell back to fresh start", {
        threadId: input.threadId,
        requestedRuntimeMode: input.runtimeMode,
        resumeThreadId,
        recoverable: true,
        cause: error.message,
      }).pipe(
        Effect.andThen(input.onResumeFallback?.(error.message) ?? Effect.void),
        Effect.andThen(
          withCodexRequestTimeout(
            "start a Codex thread",
            input.client.request("thread/start", startParams),
          ),
        ),
      ),
    ),
  );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/deleted":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "turn/started":
    case "model/safetyBuffering/updated":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRawResponseItemId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  for (const key of ["id", "call_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "model/safetyBuffering/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "rawResponseItem/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: Option.fromNullishOr(readRawResponseItemId(notification.params.item)).pipe(
          Option.map(ProviderItemId.make),
          Option.getOrUndefined,
        ),
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

export function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
  rootThreadId?: string,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  for (const receiverThreadId of readCollabReceiverThreadIds(notification)) {
    // A child may send input or activity back to its root conversation. The
    // root must never enter the child-route map or its terminal notifications
    // will subsequently be suppressed as child lifecycle noise.
    if (receiverThreadId === rootThreadId) {
      continue;
    }
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

export function readCollabParentTurnId(input: {
  readonly collabReceiverTurns: ReadonlyMap<string, TurnId>;
  readonly providerConversationId: string | undefined;
  readonly rootThreadId: string | undefined;
}): TurnId | undefined {
  if (
    input.providerConversationId === undefined ||
    input.providerConversationId === input.rootThreadId
  ) {
    return undefined;
  }
  return input.collabReceiverTurns.get(input.providerConversationId);
}

export function readCollabReceiverThreadIds(
  notification: CodexServerNotification,
): ReadonlyArray<string> {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return [];
  }

  const item = notification.params.item;
  if (item.type === "collabAgentToolCall") {
    return item.receiverThreadIds;
  }
  if (item.type === "subAgentActivity") {
    return [item.agentThreadId];
  }
  return [];
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readSubAgentSourceMetadata(source: unknown): CollabChildThreadMetadata | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const subAgent = (source as Record<string, unknown>).subAgent;
  if (!subAgent || typeof subAgent !== "object") {
    return undefined;
  }

  const threadSpawn = (subAgent as Record<string, unknown>).thread_spawn;
  if (!threadSpawn || typeof threadSpawn !== "object") {
    return undefined;
  }

  const threadSpawnRecord = threadSpawn as Record<string, unknown>;
  const agentNickname = readTrimmedString(threadSpawnRecord.agent_nickname);
  const agentRole = readTrimmedString(threadSpawnRecord.agent_role);
  return agentNickname || agentRole
    ? {
        ...(agentNickname ? { agentNickname } : {}),
        ...(agentRole ? { agentRole } : {}),
      }
    : undefined;
}

function mergeCollabChildThreadMetadata(
  current: CollabChildThreadMetadata | undefined,
  incoming: CollabChildThreadMetadata,
): CollabChildThreadMetadata {
  return {
    ...current,
    ...(incoming.agentNickname ? { agentNickname: incoming.agentNickname } : {}),
    ...(incoming.agentRole ? { agentRole: incoming.agentRole } : {}),
  };
}

export function readCollabChildThreadMetadata(
  notification: CodexServerNotification,
): { readonly threadId: string; readonly metadata: CollabChildThreadMetadata } | undefined {
  if (notification.method !== "thread/started") {
    return undefined;
  }

  const thread = notification.params.thread;
  const sourceMetadata = readSubAgentSourceMetadata(thread.source);
  const agentNickname = readTrimmedString(thread.agentNickname) ?? sourceMetadata?.agentNickname;
  const agentRole = readTrimmedString(thread.agentRole) ?? sourceMetadata?.agentRole;
  const metadata = {
    ...(agentNickname ? { agentNickname } : {}),
    ...(agentRole ? { agentRole } : {}),
  };

  return Object.keys(metadata).length > 0 ? { threadId: thread.id, metadata } : undefined;
}

function rememberCollabChildThreadMetadata(
  childThreadMetadata: Map<string, CollabChildThreadMetadata>,
  notification: CodexServerNotification,
): void {
  const childMetadata = readCollabChildThreadMetadata(notification);
  if (!childMetadata) {
    return;
  }

  childThreadMetadata.set(
    childMetadata.threadId,
    mergeCollabChildThreadMetadata(
      childThreadMetadata.get(childMetadata.threadId),
      childMetadata.metadata,
    ),
  );
}

function readCollabAgentMetadataForItem(
  item: Extract<
    CodexRpc.ServerNotificationParamsByMethod["item/started"]["item"],
    { readonly type: "collabAgentToolCall" }
  >,
  childThreadMetadata: ReadonlyMap<string, CollabChildThreadMetadata>,
): CollabChildThreadMetadata | undefined {
  for (const receiverThreadId of item.receiverThreadIds) {
    const metadata = childThreadMetadata.get(receiverThreadId);
    if (metadata?.agentNickname || metadata?.agentRole) {
      return metadata;
    }
  }
  return undefined;
}

export function enrichCollabAgentToolPayload(
  notification: CodexServerNotification,
  childThreadMetadata: ReadonlyMap<string, CollabChildThreadMetadata>,
): unknown {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return notification.params;
  }

  const item = notification.params.item;
  if (item.type !== "collabAgentToolCall") {
    return notification.params;
  }

  const metadata = readCollabAgentMetadataForItem(item, childThreadMetadata);
  if (!metadata) {
    return notification.params;
  }

  const itemRecord = item as typeof item & {
    readonly agentNickname?: string | null;
    readonly agentRole?: string | null;
  };
  const agentNickname = readTrimmedString(itemRecord.agentNickname) ?? metadata.agentNickname;
  const agentRole = readTrimmedString(itemRecord.agentRole) ?? metadata.agentRole;
  if (!agentNickname && !agentRole) {
    return notification.params;
  }

  return {
    ...notification.params,
    item: {
      ...item,
      ...(agentNickname ? { agentNickname } : {}),
      ...(agentRole ? { agentRole } : {}),
    },
  };
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function toProtocolParseError(
  detail: string,
  cause: Schema.SchemaError,
): CodexErrors.CodexAppServerProtocolParseError {
  return new CodexErrors.CodexAppServerProtocolParseError({
    detail: `${detail}: ${formatSchemaIssue(cause.issue)}`,
    cause,
  });
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

export function shouldAcceptCodexNotificationForSession(input: {
  readonly currentProviderThreadId: string | undefined;
  readonly notificationThreadId: string | undefined;
  readonly isKnownChildThread?: boolean;
}): boolean {
  if (!input.currentProviderThreadId || !input.notificationThreadId) {
    return true;
  }
  return (
    input.notificationThreadId === input.currentProviderThreadId ||
    input.isKnownChildThread === true
  );
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...updates,
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const collabChildThreadMetadataRef = yield* Ref.make(
      new Map<string, CollabChildThreadMetadata>(),
    );
    const closedRef = yield* Ref.make(false);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const spawnPlan = planCliSpawn(options.binaryPath, CODEX_APP_SERVER_ARGS, env);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          spawnPlan.command,
          [...spawnPlan.args],
          hideWindowsConsole({
            cwd: options.cwd,
            env,
            forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
            ...spawnPlan.options,
          }),
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: [options.binaryPath, ...CODEX_APP_SERVER_ARGS].join(" "),
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4;
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const collabChildThreadMetadata = yield* Ref.get(collabChildThreadMetadataRef);
        rememberCollabChildThreadMetadata(collabChildThreadMetadata, notification);
        const providerConversationId = readNotificationThreadId(notification);
        const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
        const childParentTurnId = readCollabParentTurnId({
          collabReceiverTurns,
          providerConversationId,
          rootThreadId: providerThreadId,
        });

        if (
          !shouldAcceptCodexNotificationForSession({
            currentProviderThreadId: providerThreadId,
            notificationThreadId: providerConversationId,
            isKnownChildThread: childParentTurnId !== undefined,
          })
        ) {
          yield* Ref.set(collabChildThreadMetadataRef, collabChildThreadMetadata);
          return;
        }

        const effectiveTurnId = childParentTurnId ?? route.turnId;
        rememberCollabReceiverTurns(
          collabReceiverTurns,
          notification,
          effectiveTurnId,
          providerThreadId,
        );
        if (childParentTurnId && shouldSuppressChildConversationNotification(notification.method)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          yield* Ref.set(collabChildThreadMetadataRef, collabChildThreadMetadata);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = effectiveTurnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        yield* Ref.set(collabChildThreadMetadataRef, collabChildThreadMetadata);
        if (notification.method === "thread/realtime/outputAudio/delta") {
          const audio = notification.params.audio;
          if (options.onRealtimeAudio) {
            yield* options.onRealtimeAudio({
              data: audio.data,
              sampleRate: audio.sampleRate,
              numChannels: audio.numChannels,
              ...(audio.samplesPerChannel !== undefined && audio.samplesPerChannel !== null
                ? { samplesPerChannel: audio.samplesPerChannel }
                : {}),
              ...(audio.itemId !== undefined && audio.itemId !== null
                ? { itemId: audio.itemId }
                : {}),
            });
          }
          return;
        }
        const payload = enrichCollabAgentToolPayload(notification, collabChildThreadMetadata);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(providerConversationId ? { providerThreadId: providerConversationId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;
          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;
          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }
          const errorMessage = payload.error.message;
          const willRetry = payload.willRetry;
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "permissions",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "permissions",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/permissions/requestApproval",
          requestId,
          requestKind: "permissions",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return buildPermissionsApprovalResponse(payload, resolved);
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      emitEvent({
        kind: "error",
        threadId: options.threadId,
        method,
        message: `Unsupported Codex app-server request: ${method}`,
      }).pipe(
        Effect.andThen(Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method))),
      ),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    const stderrClassifier = makeCodexStderrLineClassifier();
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = stderrClassifier.classify(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* withCodexRequestTimeout(
        "initialize a Codex session",
        client.request("initialize", buildCodexInitializeParams()),
      );
      yield* withCodexRequestTimeout(
        "confirm Codex initialization",
        client.notify("initialized", undefined),
      );

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
        resumeRequired: options.resumeRequired,
        forkFrom: options.forkFrom,
        onResumeFallback: (cause) =>
          emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "warning",
            message: `Could not restore this thread's previous Codex session (${cause}). Starting fresh — the provider no longer has this thread's earlier context.`,
          }),
      });

      const providerThreadId = opened.thread.id;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped");
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );
          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            runtimeMode: options.runtimeMode,
            ...(input.clientUserMessageId
              ? { clientUserMessageId: input.clientUserMessageId }
              : {}),
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.skills ? { skills: input.skills } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
          });
          const rawResponse = yield* withCodexRequestTimeout(
            "start a Codex turn",
            client.raw.request("turn/start", params),
          );
          const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/start response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turn.id);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      startReview: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const delivery = input.delivery ?? "inline";
          const rawResponse = yield* withCodexRequestTimeout(
            "start a Codex review",
            client.raw.request("review/start", {
              threadId: providerThreadId,
              target: input.target,
              delivery,
            }),
          );
          const response = yield* decodeV2ReviewStartResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid review/start response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turn.id);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            reviewThreadId: response.reviewThreadId,
            delivery,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderStartReviewResult;
        }),
      steerTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const params = yield* buildTurnSteerParams({
            threadId: providerThreadId,
            expectedTurnId: input.expectedTurnId,
            ...(input.clientUserMessageId
              ? { clientUserMessageId: input.clientUserMessageId }
              : {}),
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.skills ? { skills: input.skills } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
          const rawResponse = yield* withCodexRequestTimeout(
            "steer a Codex turn",
            client.raw.request("turn/steer", params),
          );
          const response = yield* decodeV2TurnSteerResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/steer response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turnId);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const effectiveTurnId = turnId ?? session.activeTurnId;
          if (!effectiveTurnId) {
            return;
          }
          yield* client.request("turn/interrupt", {
            threadId: providerThreadId,
            turnId: effectiveTurnId,
          });
        }),
      realtimeStart: Effect.fnUntraced(function* (input?: CodexSessionRuntimeRealtimeStartInput) {
        const providerThreadId = yield* readProviderThreadId;
        const params = yield* decodeCodexRealtimeStartParams({
          threadId: providerThreadId,
          outputModality: input?.outputModality ?? "audio",
          version: "v3",
        }).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/realtime/start params", error),
          ),
        );
        const response = yield* withCodexRequestTimeout(
          "start Codex realtime",
          client.raw.request("thread/realtime/start", params),
        );
        yield* decodeCodexRealtimeEmptyResponse(response).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/realtime/start response payload", error),
          ),
        );
      }),
      realtimeStop: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const params = yield* decodeCodexRealtimeStopParams({ threadId: providerThreadId }).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/realtime/stop params", error),
          ),
        );
        const response = yield* withCodexRequestTimeout(
          "stop Codex realtime",
          client.raw.request("thread/realtime/stop", params),
        );
        yield* decodeCodexRealtimeEmptyResponse(response).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/realtime/stop response payload", error),
          ),
        );
      }),
      realtimeAppendAudio: (audio) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const params = yield* decodeCodexRealtimeAppendAudioParams({
            threadId: providerThreadId,
            audio,
          }).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid thread/realtime/appendAudio params", error),
            ),
          );
          const response = yield* withCodexRequestTimeout(
            "append Codex realtime audio",
            client.raw.request("thread/realtime/appendAudio", params),
          );
          yield* decodeCodexRealtimeEmptyResponse(response).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid thread/realtime/appendAudio response payload", error),
            ),
          );
        }),
      realtimeListVoices: Effect.gen(function* () {
        yield* readProviderThreadId;
        const params = yield* decodeCodexRealtimeListVoicesParams({}).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/realtime/listVoices params", error),
          ),
        );
        const rawResponse = yield* withCodexRequestTimeout(
          "list Codex realtime voices",
          client.raw.request("thread/realtime/listVoices", params),
        );
        const response = yield* decodeCodexRealtimeListVoicesResponse(rawResponse).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/realtime/listVoices response payload", error),
          ),
        );
        return response.voices;
      }),
      compactContext: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        yield* withCodexRequestTimeout(
          "compact a Codex thread",
          client.request("thread/compact/start", {
            threadId: providerThreadId,
          }),
        );
      }),
      setGoal: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const rawResponse = yield* withCodexRequestTimeout(
            "set a Codex thread goal",
            client.raw.request("thread/goal/set", {
              threadId: providerThreadId,
              ...(input.objective !== undefined ? { objective: input.objective } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
            }),
          );
          const response = yield* decodeV2ThreadGoalSetResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid thread/goal/set response payload", error),
            ),
          );
          return response.goal;
        }),
      getGoal: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const rawResponse = yield* withCodexRequestTimeout(
          "read a Codex thread goal",
          client.raw.request("thread/goal/get", {
            threadId: providerThreadId,
          }),
        );
        const response = yield* decodeV2ThreadGoalGetResponse(rawResponse).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/goal/get response payload", error),
          ),
        );
        return response.goal ?? null;
      }),
      clearGoal: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        yield* withCodexRequestTimeout(
          "clear a Codex thread goal",
          client.raw.request("thread/goal/clear", {
            threadId: providerThreadId,
          }),
        );
      }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      readStoredThread: (providerThreadId) =>
        client
          .request("thread/read", {
            threadId: providerThreadId,
            includeTurns: true,
          })
          .pipe(Effect.map((response) => response.thread)),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;

          const legacyRollback = Effect.gen(function* () {
            const response = yield* client.request("thread/rollback", {
              threadId: providerThreadId,
              numTurns,
            });
            yield* updateSession(sessionRef, {
              status: "ready",
              activeTurnId: undefined,
            });
            return parseThreadSnapshot(response);
          });

          // Codex is deprecating `thread/rollback` in favor of `thread/fork`
          // + `lastTurnId`: fork history through the last surviving turn and
          // adopt the forked thread as this session's provider thread. The
          // superseded thread intentionally survives — it still holds the
          // undone turns.
          const current = parseThreadSnapshot(
            yield* client.request("thread/read", {
              threadId: providerThreadId,
              includeTurns: true,
            }),
          );
          const lastSurvivingTurn = current.turns[current.turns.length - 1 - numTurns];
          if (lastSurvivingTurn === undefined) {
            // Rolling back the entire history leaves no fork cut point; the
            // in-place rollback still models "empty thread" correctly.
            return yield* legacyRollback;
          }

          const forkRollback = Effect.gen(function* () {
            const session = yield* Ref.get(sessionRef);
            const forked = yield* withCodexRequestTimeout(
              "fork a Codex thread to roll back",
              client.request(
                "thread/fork",
                buildThreadForkParams({
                  sourceThreadId: providerThreadId,
                  lastTurnId: lastSurvivingTurn.id,
                  cwd: session.cwd ?? options.cwd,
                  runtimeMode: options.runtimeMode,
                  model: normalizeCodexModelSlug(session.model),
                  serviceTier: options.serviceTier,
                }),
              ),
            );
            const forkedThreadId = forked.thread.id;
            yield* updateSession(sessionRef, {
              status: "ready",
              activeTurnId: undefined,
              resumeCursor: { threadId: forkedThreadId },
            });
            yield* Effect.logInfo("codex thread rollback forked to a new provider thread", {
              threadId: options.threadId,
              supersededProviderThreadId: providerThreadId,
              forkedProviderThreadId: forkedThreadId,
              lastTurnId: lastSurvivingTurn.id,
            });
            const response = yield* client.request("thread/read", {
              threadId: forkedThreadId,
              includeTurns: true,
            });
            return parseThreadSnapshot(response);
          });

          return yield* forkRollback.pipe(
            Effect.catchIf(isNativeThreadForkUnsupportedError, (error) =>
              Effect.logWarning(
                "codex thread/fork rollback fell back to deprecated thread/rollback",
                {
                  threadId: options.threadId,
                  providerThreadId,
                  cause: error.message,
                },
              ).pipe(Effect.andThen(legacyRollback)),
            ),
          );
        }),
      deleteThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        yield* withCodexRequestTimeout(
          "delete a Codex thread",
          client.request("thread/delete", {
            threadId: providerThreadId,
          }),
        );
        yield* updateSession(sessionRef, {
          status: "closed",
          activeTurnId: undefined,
        });
      }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
