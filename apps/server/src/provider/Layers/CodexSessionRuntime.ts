import { parseSessionKey } from "@threadlines/shared/threadParticipants";
import {
  BROWSER_MCP_SERVER_NAME,
  mcpEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import {
  buildAgentPageInstructions,
  CODEX_PAGE_RIVAL,
  PAGES_MCP_SERVER_NAME,
} from "../../mcp/pageTools.ts";
import { ensurePageAssetsDir } from "../../pages/PageStore.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { ROOM_MCP_SERVER_NAME, roomToolsFor } from "../../mcp/roomToolAccess.ts";
import {
  type CodexBorrowedSignIn,
  type CodexSideAnswerHomeError,
  removeCodexSideAnswerHome,
} from "../codexSideAnswerHome.ts";
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
  type McpElicitation,
  type SubagentMetadataUpdatedPayload,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { planCliSpawn } from "../../cliSpawn.ts";
import { isLinkedWorktreeCheckout } from "../../vcs/CheckoutPresence.ts";
import { MANAGED_WORKTREE_INSTRUCTION } from "@threadlines/shared/contextSeed";
import { normalizeModelSlug } from "@threadlines/shared/model";
import { isProviderAuthErrorMessage } from "@threadlines/shared/providerAuth";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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
import { codexMcpElicitation, codexMcpElicitationResponse } from "../CodexMcpElicitation.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PREVIEW_PANEL_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { FILE_LINK_INSTRUCTIONS } from "../fileLinkInstructions.ts";
import {
  CODEX_BROWSER_TOKEN_ENV_VAR,
  codexAppServerArgs,
  codexSideAnswerAppServerArgs,
} from "../codexAppServerArgs.ts";
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

const decodeCodexTurnStartParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartParams);

export type CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams;
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadTurn =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]
  | EffectCodexSchema.V2ThreadTurnsListResponse["data"][number];
type CodexThreadItem = CodexThreadTurn["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  /** Where this server is listening, so the thread can be told how to reach
   *  the browser tools. */
  readonly serverPort: number;
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
  /** A room's side answer; see CodexSessionRuntimeLockdown. */
  readonly lockdown?: CodexSessionRuntimeLockdown;
  /**
   * Attach the room tools (ProviderSessionStartInput.roomTools): every tool
   * for a working runtime, the read tools its kind allows for a side one.
   */
  readonly roomTools?: boolean;
  /** Attach the page tools (ProviderSessionStartInput.agentPages). Never for a side runtime. */
  readonly agentPages?: boolean;
  readonly onRealtimeAudio?: (audio: ProviderRealtimeAudioChunk) => Effect.Effect<void>;
}

/**
 * A room's side-answer runtime (ProviderSessionStartInput.lockdown): it runs
 * in its own temporary home (`homePath`), read-only with no approvals or
 * questions, signs in with a borrowed token, and continues a copy of the
 * answering agent's conversation when there is one. See codexSideAnswerHome.
 */
export interface CodexSessionRuntimeLockdown {
  /**
   * `ask` answers from the agent's conversation; `review` is an independent
   * review, fresh, with no project instruction files.
   */
  readonly kind: "ask" | "review";
  /**
   * The user's sign-in to borrow, read from their own Codex home and never
   * written (see `borrowCodexSignIn`). `rejectedAccessToken` is the token
   * Codex just had refused, so it is renewed rather than handed back.
   */
  readonly signIn: (input: {
    readonly rejectedAccessToken?: string;
  }) => Effect.Effect<CodexBorrowedSignIn, CodexSideAnswerHomeError>;
  /** The copied conversation to continue, inside this runtime's own home. */
  readonly rolloutPath?: string;
  readonly sourceProviderThreadId?: string;
}

/** A side answer's thread: read-only, and nothing ever asks for approval. */
const SIDE_ANSWER_THREAD_CONFIG = {
  approvalPolicy: "never",
  sandbox: "read-only",
} as const satisfies {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
};

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
  /**
   * Have this runtime's own auth manager refresh the sign-in (managed auth:
   * it rewrites `auth.json` and serializes against its own refreshes). A
   * room's side answer borrows the renewed token.
   */
  readonly renewSignIn: Effect.Effect<void, CodexSessionRuntimeError>;
  readonly setGoal: (
    input: CodexSessionRuntimeSetGoalInput,
  ) => Effect.Effect<CodexThreadGoal, CodexSessionRuntimeError>;
  readonly getGoal: Effect.Effect<CodexThreadGoal | null, CodexSessionRuntimeError>;
  readonly clearGoal: Effect.Effect<void, CodexSessionRuntimeError>;
  /** Current provider-owned thread id without loading its transcript. */
  readonly readProviderThreadId: Effect.Effect<string, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  /** Read any persisted Codex provider thread without resuming it. Callers
   * must authorize the provider thread before exposing its contents. */
  readonly readStoredThread: (
    providerThreadId: string,
  ) => Effect.Effect<EffectCodexSchema.V2ThreadReadResponse["thread"], CodexSessionRuntimeError>;
  /** Read thread identity and ancestry without materializing its turns. */
  readonly readStoredThreadMetadata: (
    providerThreadId: string,
  ) => Effect.Effect<EffectCodexSchema.V2ThreadReadResponse["thread"], CodexSessionRuntimeError>;
  /** Cursor-paginated provider items, used for bounded transcript reads. */
  readonly readStoredThreadItems: (
    input: EffectCodexSchema.V2ThreadItemsListParams,
  ) => Effect.Effect<EffectCodexSchema.V2ThreadItemsListResponse, CodexSessionRuntimeError>;
  /** Start a turn on another loaded provider thread (a spawned subagent) with
   *  a plain text message. Callers must authorize the thread first; the
   *  app-server rejects threads that do not accept direct input. */
  readonly startStoredThreadTurn: (
    providerThreadId: string,
    text: string,
  ) => Effect.Effect<EffectCodexSchema.V2TurnStartResponse, CodexSessionRuntimeError>;
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

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedError<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedError<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedError<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedError<CodexSessionRuntimeThreadIdMissingError>()(
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
  readonly jsonRpcId: string;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly elicitation?: McpElicitation;
}

export interface CollabChildThreadMetadata {
  readonly agentNickname?: string;
  readonly agentRole?: string;
  readonly agentPath?: string;
  readonly parentAgentThreadId?: string;
  readonly depth?: number;
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
  readonly lockdown?: boolean;
}): EffectCodexSchema.V2ThreadStartParams {
  const config: ReturnType<typeof runtimeModeToThreadConfig> = input.lockdown
    ? SIDE_ANSWER_THREAD_CONFIG
    : runtimeModeToThreadConfig(input.runtimeMode);
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
    excludeTurns: true,
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
  /** Session runs in a git worktree Threadlines created and must not delete. */
  readonly managedWorktree?: boolean;
  /** The session has the page tools; their images go in this folder. */
  readonly agentPageAssetsDir?: string;
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
      // Appended rather than replacing the mode block: which browser the user
      // means, and how to cite a file, are orthogonal to how the model is
      // collaborating.
      developer_instructions: [
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        CODEX_PREVIEW_PANEL_DEVELOPER_INSTRUCTIONS,
        ...(input.agentPageAssetsDir !== undefined
          ? [
              buildAgentPageInstructions({
                assetsDir: input.agentPageAssetsDir,
                rival: CODEX_PAGE_RIVAL,
              }),
            ]
          : []),
        FILE_LINK_INSTRUCTIONS,
        ...(input.managedWorktree ? [MANAGED_WORKTREE_INSTRUCTION] : []),
      ].join("\n\n"),
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
  /** Session runs in a git worktree Threadlines created and must not delete. */
  readonly managedWorktree?: boolean;
  /** The session has the page tools; their images go in this folder. */
  readonly agentPageAssetsDir?: string;
  /** A side answer: every turn is read-only with no approvals. */
  readonly lockdown?: boolean;
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

  const config: ReturnType<typeof runtimeModeToThreadConfig> = input.lockdown
    ? SIDE_ANSWER_THREAD_CONFIG
    : runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.managedWorktree ? { managedWorktree: true } : {}),
    ...(input.agentPageAssetsDir !== undefined
      ? { agentPageAssetsDir: input.agentPageAssetsDir }
      : {}),
  });

  return decodeCodexTurnStartParams({
    threadId: input.threadId,
    input: turnInput,
    ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
    approvalPolicy: config.approvalPolicy,
    ...(config.approvalsReviewer ? { approvalsReviewer: config.approvalsReviewer } : {}),
    sandboxPolicy: input.lockdown
      ? { type: "readOnly" }
      : runtimeModeToTurnSandboxPolicy(input.runtimeMode),
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
 *  so callers can fall back to a stabler boundary or a fresh thread. */
export function isNativeThreadForkUnsupportedError(error: unknown): boolean {
  return (
    error instanceof CodexErrors.CodexAppServerRequestError &&
    (error.code === -32601 || error.code === -32602)
  );
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread") || message.includes("already has an active writer")) {
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

const CODEX_REQUEST_TIMEOUT_PREFIX = "Timed out waiting for Codex App Server to ";

export function codexRequestTimeoutError(
  operation: string,
): CodexErrors.CodexAppServerRequestError {
  return CodexErrors.CodexAppServerRequestError.internalError(
    `${CODEX_REQUEST_TIMEOUT_PREFIX}${operation}.`,
  );
}

/** A request we gave up waiting on, which the app-server may still finish. */
function isCodexRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof CodexErrors.CodexAppServerRequestError &&
    error.errorMessage.startsWith(CODEX_REQUEST_TIMEOUT_PREFIX)
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
  /** A side answer: continue the copied conversation, or start fresh,
   *  read-only. Resume ids and forks are never used. */
  readonly lockdown?: CodexSessionRuntimeLockdown | undefined;
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
    ...(input.lockdown !== undefined ? { lockdown: true } : {}),
  });

  if (input.lockdown !== undefined) {
    const { rolloutPath, sourceProviderThreadId } = input.lockdown;
    if (rolloutPath === undefined || sourceProviderThreadId === undefined) {
      return withCodexRequestTimeout(
        "start a Codex thread",
        input.client.request("thread/start", startParams),
      );
    }
    // The copy lives in this runtime's own home, so resuming it forks the
    // agent's conversation without touching the original.
    const { threadSource: _threadSource, ...resumeParams } = startParams;
    return withCodexRequestTimeout(
      "resume a Codex thread",
      input.client.request("thread/resume", {
        threadId: sourceProviderThreadId,
        path: rolloutPath,
        excludeTurns: true,
        ...resumeParams,
      }),
    );
  }

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
      excludeTurns: true,
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

type CodexThreadTurnsMethod = "thread/read" | "thread/turns/list";

interface CodexThreadTurnsClient {
  readonly request: <M extends CodexThreadTurnsMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

/**
 * Reads a Codex thread and every one of its turns. Paginated threads (the
 * default for new threads since Codex 0.159) are paged through
 * `thread/turns/list`: Codex deprecates full-history `thread/read` for them
 * and answers each one with a deprecation notice that would land in the
 * user's chat. Legacy threads keep the single full read.
 */
export const readCodexThreadTurns = (input: {
  readonly client: CodexThreadTurnsClient;
  readonly threadId: string;
  /** "notLoaded" when only turn ids and statuses are needed. */
  readonly itemsView: "notLoaded" | "full";
}): Effect.Effect<
  {
    readonly thread: EffectCodexSchema.V2ThreadReadResponse["thread"];
    readonly turns: ReadonlyArray<CodexThreadTurn>;
  },
  CodexErrors.CodexAppServerError
> =>
  Effect.gen(function* () {
    const { client, threadId } = input;
    const { thread } = yield* client.request("thread/read", { threadId, includeTurns: false });
    if (thread.historyMode !== "paginated") {
      const full = yield* client.request("thread/read", { threadId, includeTurns: true });
      return { thread: full.thread, turns: full.thread.turns };
    }
    const turns: Array<CodexThreadTurn> = [];
    let cursor: string | undefined;
    do {
      const page = yield* client.request("thread/turns/list", {
        threadId,
        sortDirection: "asc",
        itemsView: input.itemsView,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      turns.push(...page.data);
      const nextCursor = page.nextCursor?.trim() || undefined;
      cursor = nextCursor === cursor ? undefined : nextCursor;
    } while (cursor !== undefined);
    return { thread, turns };
  });

type CodexRollbackMethod =
  | CodexThreadTurnsMethod
  | "thread/revert"
  | "thread/resume"
  | "thread/fork"
  | "thread/start";

interface CodexRollbackClient {
  readonly request: <M extends CodexRollbackMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export interface CodexThreadRollbackResult {
  /** The surviving turns. Their items are empty in one corner: Codex
   *  confirmed a revert and the read-back after it failed. */
  readonly snapshot: CodexThreadSnapshot;
  /** Set when the surviving history now lives in a new provider thread (a
   *  fork, or a fresh thread when nothing survives) that the session must
   *  adopt. The superseded thread intentionally survives: it still holds the
   *  undone turns. */
  readonly replacementProviderThreadId?: string;
}

/** Codex refused the fork cut point, e.g. a legacy rollout whose turns have
 *  generated ids and no persisted boundary to cut at. */
const isForkBoundaryRejectedError = (error: unknown): boolean =>
  error instanceof CodexErrors.CodexAppServerRequestError && error.code === -32600;

/**
 * Undoes the last `numTurns` turns of a Codex thread.
 *
 * Paginated threads (every new thread since Codex 0.159) are reverted in
 * place with `thread/revert`: the same provider thread keeps its goal and
 * settings, and no copy piles up in the user's Codex session list.
 *
 * Legacy threads, and any revert that fails or keeps the undone turns, fork
 * the surviving history into a new provider thread instead (Codex removed the
 * in-place `thread/rollback` in 0.159). Keeping some turns forks through the
 * last survivor (`lastTurnId`); undoing every turn forks before the first turn
 * (`beforeTurnId`), and falls back to a fresh thread, which is the same empty
 * conversation, when Codex can't cut there. Forks carry the thread's goal
 * without restarting it; the user's next turn picks it back up. The
 * fresh-thread fallback does not: it only serves legacy rollouts and old
 * app-servers, both older than goals.
 *
 * A fork that still holds the first undone turn (an app-server that ignores
 * an unknown boundary copies everything) is never adopted, and a running turn
 * is refused rather than reverted or forked, since it would keep working.
 */
export const rollbackCodexThread = (input: {
  readonly client: CodexRollbackClient;
  readonly threadId: ThreadId;
  readonly providerThreadId: string;
  readonly numTurns: number;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): Effect.Effect<CodexThreadRollbackResult, CodexErrors.CodexAppServerError> =>
  Effect.gen(function* () {
    const { client, providerThreadId, numTurns } = input;
    const freshThread = (reason: string) =>
      Effect.logWarning("codex thread rollback fell back to a fresh thread", {
        threadId: input.threadId,
        providerThreadId,
        reason,
      }).pipe(
        Effect.andThen(
          withCodexRequestTimeout(
            "start a Codex thread to roll back",
            client.request(
              "thread/start",
              buildThreadStartParams({
                cwd: input.cwd,
                runtimeMode: input.runtimeMode,
                model: input.model,
                serviceTier: input.serviceTier,
              }),
            ),
          ),
        ),
        Effect.map((started): CodexThreadRollbackResult => ({
          snapshot: threadSnapshot(started.thread.id, []),
          replacementProviderThreadId: started.thread.id,
        })),
      );

    const current = yield* readCodexThreadTurns({
      client,
      threadId: providerThreadId,
      itemsView: "notLoaded",
    });
    if (current.turns.some((turn) => turn.status === "inProgress")) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Stop the running turn before reverting this conversation.",
      );
    }
    const survivingTurnCount = Math.max(current.turns.length - numTurns, 0);
    const firstUndoneTurn = current.turns[survivingTurnCount];
    if (firstUndoneTurn === undefined) {
      return { snapshot: threadSnapshot(providerThreadId, current.turns) };
    }
    const lastSurvivingTurn = current.turns[survivingTurnCount - 1];
    const cannotCut = (reason: string) =>
      lastSurvivingTurn === undefined
        ? freshThread(reason)
        : Effect.fail(
            CodexErrors.CodexAppServerRequestError.invalidRequest(
              `This Codex version can't revert part of a conversation (${reason}). Update Codex and try again.`,
            ),
          );

    if (current.thread.historyMode === "paginated") {
      const reverted = yield* withCodexRequestTimeout(
        "revert a Codex thread",
        client.request("thread/revert", {
          threadId: providerThreadId,
          beforeTurnId: firstUndoneTurn.id,
        }),
      ).pipe(Effect.result);
      // Codex commits the new history before it reloads the thread, so even a
      // failed or timed-out revert may have landed: read back before deciding.
      const readBack = yield* withCodexRequestTimeout(
        "read back a reverted Codex thread",
        readCodexThreadTurns({ client, threadId: providerThreadId, itemsView: "full" }),
      ).pipe(Effect.result);
      if (
        Result.isSuccess(readBack) &&
        !readBack.success.turns.some((turn) => turn.id === firstUndoneTurn.id)
      ) {
        if (Result.isFailure(reverted)) {
          // It landed but the reload failed, which leaves the thread unloaded
          // and the next turn with nothing to run on: load it again.
          const { threadSource: _threadSource, ...resumeParams } = buildThreadStartParams({
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            model: input.model,
            serviceTier: input.serviceTier,
          });
          yield* withCodexRequestTimeout(
            "reload a reverted Codex thread",
            client.request("thread/resume", {
              threadId: providerThreadId,
              excludeTurns: true,
              ...resumeParams,
            }),
          );
        }
        return { snapshot: threadSnapshot(providerThreadId, readBack.success.turns) };
      }
      if (Result.isFailure(readBack)) {
        if (Result.isFailure(reverted)) {
          // Neither answer says what the thread holds now; forking could cut
          // at turns that are already gone.
          return yield* Effect.fail(reverted.failure);
        }
        yield* Effect.logWarning("codex thread revert succeeded but its read-back failed", {
          threadId: input.threadId,
          providerThreadId,
          cause: readBack.failure.message,
        });
        return {
          snapshot: threadSnapshot(providerThreadId, current.turns.slice(0, survivingTurnCount)),
        };
      }
      if (Result.isFailure(reverted) && isCodexRequestTimeoutError(reverted.failure)) {
        // The revert may still land; a fork now would race it.
        return yield* Effect.fail(reverted.failure);
      }
      yield* Effect.logWarning("codex thread revert fell back to a fork", {
        threadId: input.threadId,
        providerThreadId,
        reason: Result.isFailure(reverted)
          ? reverted.failure.message
          : "the revert kept the undone turns",
      });
    }

    const fork = yield* withCodexRequestTimeout(
      "fork a Codex thread to roll back",
      client.request("thread/fork", {
        ...buildThreadForkParams({
          sourceThreadId: providerThreadId,
          lastTurnId: lastSurvivingTurn?.id,
          cwd: input.cwd,
          runtimeMode: input.runtimeMode,
          model: input.model,
          serviceTier: input.serviceTier,
        }),
        ...(lastSurvivingTurn === undefined ? { beforeTurnId: firstUndoneTurn.id } : {}),
        deferGoalContinuation: true,
      }),
    ).pipe(Effect.result);
    if (Result.isFailure(fork)) {
      const canFallBack =
        isNativeThreadForkUnsupportedError(fork.failure) ||
        (lastSurvivingTurn === undefined && isForkBoundaryRejectedError(fork.failure));
      return yield* canFallBack ? cannotCut(fork.failure.message) : Effect.fail(fork.failure);
    }
    const replacementProviderThreadId = fork.success.thread.id;
    const forked = yield* readCodexThreadTurns({
      client,
      threadId: replacementProviderThreadId,
      itemsView: "full",
    });
    if (forked.turns.some((turn) => turn.id === firstUndoneTurn.id)) {
      return yield* cannotCut("the fork kept the undone turns");
    }
    return {
      snapshot: threadSnapshot(replacementProviderThreadId, forked.turns),
      replacementProviderThreadId,
    } satisfies CodexThreadRollbackResult;
  });

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
    case "thread/settings/updated":
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

/** Seed routing as soon as Codex announces a spawned thread. In app-server v2
 *  this notification can arrive before the parent collab item, so waiting for
 *  item/started would drop the child's first deltas as foreign-thread noise. */
export function rememberCollabThreadStartTurn(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  input: {
    readonly rootThreadId: string | undefined;
    readonly activeRootTurnId: TurnId | undefined;
  },
): void {
  if (notification.method !== "thread/started") {
    return;
  }
  const thread = notification.params.thread;
  if (thread.id === input.rootThreadId) {
    return;
  }
  const sourceMetadata = readSubAgentSourceMetadata(thread.source);
  const parentThreadId =
    readTrimmedString(thread.parentThreadId) ?? sourceMetadata?.parentAgentThreadId;
  if (!parentThreadId) {
    return;
  }
  const parentTurnId =
    parentThreadId === input.rootThreadId
      ? input.activeRootTurnId
      : collabReceiverTurns.get(parentThreadId);
  if (parentTurnId) {
    collabReceiverTurns.set(thread.id, parentTurnId);
  }
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
  const agentPath = readTrimmedString(threadSpawnRecord.agent_path);
  const parentAgentThreadId = readTrimmedString(threadSpawnRecord.parent_thread_id);
  const depth =
    typeof threadSpawnRecord.depth === "number" && Number.isInteger(threadSpawnRecord.depth)
      ? threadSpawnRecord.depth
      : undefined;
  return agentNickname || agentRole || agentPath || parentAgentThreadId || depth !== undefined
    ? {
        ...(agentNickname ? { agentNickname } : {}),
        ...(agentRole ? { agentRole } : {}),
        ...(agentPath ? { agentPath } : {}),
        ...(parentAgentThreadId ? { parentAgentThreadId } : {}),
        ...(depth !== undefined ? { depth } : {}),
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
    ...(incoming.agentPath ? { agentPath: incoming.agentPath } : {}),
    ...(incoming.parentAgentThreadId ? { parentAgentThreadId: incoming.parentAgentThreadId } : {}),
    ...(incoming.depth !== undefined ? { depth: incoming.depth } : {}),
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
  const parentAgentThreadId =
    readTrimmedString(thread.parentThreadId) ?? sourceMetadata?.parentAgentThreadId;
  const metadata = {
    ...(agentNickname ? { agentNickname } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(sourceMetadata?.agentPath ? { agentPath: sourceMetadata.agentPath } : {}),
    ...(parentAgentThreadId ? { parentAgentThreadId } : {}),
    ...(sourceMetadata?.depth !== undefined ? { depth: sourceMetadata.depth } : {}),
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

function readCollabAgentMetadataForThreadIds(
  receiverThreadIds: ReadonlyArray<string>,
  childThreadMetadata: ReadonlyMap<string, CollabChildThreadMetadata>,
): CollabChildThreadMetadata | undefined {
  for (const receiverThreadId of receiverThreadIds) {
    const metadata = childThreadMetadata.get(receiverThreadId);
    if (metadata) {
      return metadata;
    }
  }
  return undefined;
}

export function enrichCollabAgentToolPayload(
  notification: CodexServerNotification,
  childThreadMetadata: ReadonlyMap<string, CollabChildThreadMetadata>,
  isChildThread = false,
): unknown {
  if (notification.method === "thread/started" && isChildThread) {
    const agentThreadId = notification.params.thread.id;
    const metadata = childThreadMetadata.get(agentThreadId);
    return {
      ...notification.params,
      subagentMetadata: {
        agentThreadId,
        ...metadata,
      },
    };
  }

  if (notification.method === "thread/settings/updated" && isChildThread) {
    const agentThreadId = notification.params.threadId;
    const metadata = childThreadMetadata.get(agentThreadId);
    return {
      ...notification.params,
      subagentMetadata: {
        agentThreadId,
        ...metadata,
      },
    };
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return notification.params;
  }

  const item = notification.params.item;
  if (item.type !== "collabAgentToolCall" && item.type !== "subAgentActivity") {
    return notification.params;
  }

  const receiverThreadIds =
    item.type === "collabAgentToolCall" ? item.receiverThreadIds : [item.agentThreadId];
  const metadata = readCollabAgentMetadataForThreadIds(receiverThreadIds, childThreadMetadata);
  if (!metadata) {
    return notification.params;
  }

  const itemRecord = item as typeof item & {
    readonly agentNickname?: string | null;
    readonly agentRole?: string | null;
  };
  const agentNickname = readTrimmedString(itemRecord.agentNickname) ?? metadata.agentNickname;
  const agentRole = readTrimmedString(itemRecord.agentRole) ?? metadata.agentRole;
  if (
    !agentNickname &&
    !agentRole &&
    !metadata.agentPath &&
    !metadata.parentAgentThreadId &&
    metadata.depth === undefined
  ) {
    return notification.params;
  }

  return {
    ...notification.params,
    item: {
      ...item,
      ...(agentNickname ? { agentNickname } : {}),
      ...(agentRole ? { agentRole } : {}),
      ...(metadata.agentPath ? { agentPath: metadata.agentPath } : {}),
      ...(metadata.parentAgentThreadId
        ? { parentAgentThreadId: metadata.parentAgentThreadId }
        : {}),
      ...(metadata.depth !== undefined ? { depth: metadata.depth } : {}),
    },
  };
}

/** Converts a child's real turn lifecycle into a roster update. The caller
 *  must establish that the notification belongs to a known child first. */
export function readCollabChildTurnStatus(
  notification: CodexServerNotification,
): SubagentMetadataUpdatedPayload | undefined {
  if (notification.method === "turn/started") {
    return { agentThreadId: notification.params.threadId, status: "running" };
  }
  if (notification.method === "turn/completed") {
    const status = notification.params.turn.status;
    if (status === "inProgress") return undefined;
    return { agentThreadId: notification.params.threadId, status };
  }
  return undefined;
}

/** Child-conversation notifications that describe the child's own turn rather
 *  than work done inside the parent's. Mapped onto the parent turn they would
 *  overwrite the parent's state: a child's `turn/diff/updated` covers only its
 *  own edits, so letting it through would replace the parent's cumulative diff
 *  evidence with a subset. The child's item lifecycle still flows through. */
export function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/diff/updated" ||
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
  return session.providerThreadId ?? readResumeCursorThreadId(session.resumeCursor);
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

function threadSnapshot(
  threadId: string,
  turns: ReadonlyArray<CodexThreadTurn>,
): CodexThreadSnapshot {
  return {
    threadId,
    turns: turns.map((turn) => ({ id: TurnId.make(turn.id), items: turn.items })),
  };
}

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const fileSystem = yield* FileSystem.FileSystem;
    // Resolved once per session: the checkout cannot change kind underneath a
    // running runtime, and every turn asks the same question.
    const runsInManagedWorktree = yield* isLinkedWorktreeCheckout(options.cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.cached,
    );
    // The page tools' image folder, made once; workspace-write sandboxes can
    // write there because it sits in the system temp folder.
    const agentPageAssetsDir =
      options.agentPages === true && options.lockdown === undefined
        ? yield* ensurePageAssetsDir(parseSessionKey(options.threadId).threadId).pipe(
            Effect.map((dir): string | undefined => dir),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
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
    const lockdown = options.lockdown;
    // A side answer borrows the user's sign-in read-only: a ChatGPT token is
    // handed over after initialize, an API key through the environment.
    const borrowedSignIn =
      lockdown !== undefined
        ? yield* lockdown.signIn({}).pipe(
            Effect.mapError(
              (cause) =>
                new CodexErrors.CodexAppServerSpawnError({
                  command: options.binaryPath,
                  cause,
                }),
            ),
          )
        : undefined;
    // The MCP servers are named at spawn, and this runtime's credential
    // travels in the environment so it never appears in argv. A side answer
    // never gets the browser; in a room it gets the room's read tools. The
    // credential dies with the runtime's scope, whichever way it ends.
    const roomTools = options.roomTools === true;
    const agentPages = options.agentPages === true && lockdown === undefined;
    const credential =
      lockdown === undefined || roomTools
        ? yield* mcpSessionRegistry.credentialFor({
            sessionKey: options.threadId,
            browser: lockdown === undefined,
            room: roomTools,
            pages: agentPages,
            ...(lockdown !== undefined ? { sideKind: lockdown.kind } : {}),
          })
        : undefined;
    if (credential !== undefined) {
      yield* Scope.addFinalizer(
        runtimeScope,
        mcpSessionRegistry.revoke(options.threadId, credential.generation),
      );
    }
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      ...(credential !== undefined ? { [CODEX_BROWSER_TOKEN_ENV_VAR]: credential.token } : {}),
      ...(borrowedSignIn?.kind === "apiKey" ? { OPENAI_API_KEY: borrowedSignIn.apiKey } : {}),
    };
    const roomServer = {
      url: mcpRoomEndpointUrl(options.serverPort),
      serverName: ROOM_MCP_SERVER_NAME,
    };
    const spawnPlan = planCliSpawn(
      options.binaryPath,
      lockdown !== undefined
        ? codexSideAnswerAppServerArgs({
            kind: lockdown.kind,
            ...(roomTools ? { room: { ...roomServer, tools: roomToolsFor(lockdown.kind) } } : {}),
          })
        : codexAppServerArgs({
            browser: {
              url: mcpEndpointUrl(options.serverPort),
              serverName: BROWSER_MCP_SERVER_NAME,
            },
            ...(roomTools ? { room: roomServer } : {}),
            ...(agentPages
              ? {
                  pages: {
                    url: mcpPagesEndpointUrl(options.serverPort),
                    serverName: PAGES_MCP_SERVER_NAME,
                  },
                }
              : {}),
          }),
      env,
    );
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
              command: [spawnPlan.command, ...spawnPlan.args].join(" "),
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
      ...(roomTools ? { roomTools: true } : {}),
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
      Ref.getAndSet(pendingUserInputsRef, new Map()).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const expirePendingUserInputs = (
      matches: (pending: PendingUserInput) => boolean,
      reason: "resolved" | "turn-completed",
    ) =>
      Effect.gen(function* () {
        const expired = yield* Ref.modify(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          const expired = Array.from(current.values()).filter(matches);
          for (const pending of expired) next.delete(pending.requestId);
          return [expired, next];
        });
        for (const pending of expired) {
          yield* Deferred.succeed(pending.answers, {});
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/resolved",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: { reason },
          });
        }
      });

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const collabChildThreadMetadata = yield* Ref.get(collabChildThreadMetadataRef);
        rememberCollabChildThreadMetadata(collabChildThreadMetadata, notification);
        const providerConversationId = readNotificationThreadId(notification);
        const session = yield* Ref.get(sessionRef);
        const providerThreadId = currentProviderThreadId(session);
        rememberCollabThreadStartTurn(collabReceiverTurns, notification, {
          rootThreadId: providerThreadId,
          activeRootTurnId: session.activeTurnId,
        });
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
          // Keep child turns out of the parent's lifecycle, but use them to
          // track real work after a follow-up instead of guessing from messages.
          const childStatus = readCollabChildTurnStatus(notification);
          if (childStatus) {
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              method: "subagent/status/changed",
              ...(providerConversationId ? { providerThreadId: providerConversationId } : {}),
              turnId: childParentTurnId,
              payload: childStatus,
            });
          }
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
          yield* expirePendingUserInputs(
            (pending) => pending.jsonRpcId === rawRequestId,
            "resolved",
          );
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
        const payload = enrichCollabAgentToolPayload(
          notification,
          collabChildThreadMetadata,
          childParentTurnId !== undefined,
        );
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
            providerThreadId: payload.thread.id,
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
          }).pipe(
            Effect.andThen(
              expirePendingUserInputs(
                (pending) => pending.turnId === payload.turn.id,
                "turn-completed",
              ),
            ),
          );
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
          // An expired credential cannot heal by retrying: the app-server
          // would replay its full reconnect schedule (visible as 20-30s of
          // "reconnecting" noise) before failing with the same 401. Treat a
          // retrying auth error as terminal so the sign-in surface appears
          // on the first attempt instead of the last.
          const willRetry = payload.willRetry && !isProviderAuthErrorMessage(errorMessage);
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    // A side answer never reaches the user with a question or an approval:
    // anything that asks is declined on the spot, so no request is left
    // hanging. Codex should not ask at all (approvals are off, questions are
    // disabled, and no MCP server is loaded); this is the backstop.
    if (lockdown !== undefined) {
      // Codex asks after a 401: the token it holds was refused.
      const handedAccessTokenRef = yield* Ref.make(
        borrowedSignIn?.kind === "chatgpt" ? borrowedSignIn.accessToken : undefined,
      );
      yield* client.handleServerRequest("account/chatgptAuthTokens/refresh", () =>
        Ref.get(handedAccessTokenRef).pipe(
          Effect.flatMap((rejectedAccessToken) =>
            lockdown.signIn(rejectedAccessToken !== undefined ? { rejectedAccessToken } : {}),
          ),
          Effect.tap((signIn) =>
            signIn.kind === "chatgpt"
              ? Ref.set(handedAccessTokenRef, signIn.accessToken)
              : Effect.void,
          ),
          Effect.flatMap((signIn) =>
            signIn.kind === "chatgpt"
              ? Effect.succeed({
                  accessToken: signIn.accessToken,
                  chatgptAccountId: signIn.chatgptAccountId,
                  ...(signIn.chatgptPlanType !== undefined
                    ? { chatgptPlanType: signIn.chatgptPlanType }
                    : {}),
                })
              : Effect.fail(signIn),
          ),
          Effect.orDie,
        ),
      );
    }

    yield* client.handleServerRequest(
      "item/commandExecution/requestApproval",
      (payload, metadata) =>
        Effect.gen(function* () {
          if (lockdown !== undefined) {
            return {
              decision: "decline",
            } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
          }
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const turnId = TurnId.make(payload.turnId);
          const itemId = ProviderItemId.make(payload.itemId);
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          // Typing into a terminal that is already running is its own ask.
          const requestKind = payload.kind === "writeStdin" ? "terminal-input" : "command";

          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.set(requestId, {
              requestId,
              jsonRpcId: String(metadata.id),
              requestKind,
              turnId,
              itemId,
              decision,
            });
            return next;
          });
          yield* Ref.update(approvalCorrelationsRef, (current) => {
            const next = new Map(current);
            next.set(String(metadata.id), {
              requestId,
              requestKind,
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
            requestKind,
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

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload, metadata) =>
      Effect.gen(function* () {
        if (lockdown !== undefined) {
          return {
            decision: "decline",
          } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: String(metadata.id),
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(String(metadata.id), {
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

    yield* client.handleServerRequest("item/permissions/requestApproval", (payload, metadata) =>
      Effect.gen(function* () {
        if (lockdown !== undefined) {
          return buildPermissionsApprovalResponse(payload, "decline");
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: String(metadata.id),
            requestKind: "permissions",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(String(metadata.id), {
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

    yield* client.handleServerRequest("mcpServer/elicitation/request", (payload, metadata) =>
      Effect.gen(function* () {
        if (lockdown !== undefined) {
          return { action: "decline" as const, content: null };
        }
        const elicitation = codexMcpElicitation(payload);
        if (!elicitation) {
          yield* emitEvent({
            kind: "error",
            threadId: options.threadId,
            method: "mcpServer/elicitation/request",
            message: `${payload.serverName} requested a confirmation that this client cannot display (${payload.mode}).`,
          });
          return { action: "cancel" as const, content: null };
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();
        const turnId = payload.turnId ? TurnId.make(payload.turnId) : undefined;
        yield* Ref.update(pendingUserInputsRef, (current) =>
          new Map(current).set(requestId, {
            requestId,
            jsonRpcId: String(metadata.id),
            turnId,
            itemId: undefined,
            answers,
            elicitation,
          }),
        );
        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "mcpServer/elicitation/request",
          requestId,
          ...(turnId ? { turnId } : {}),
          payload: { questions: [], isBlocking: true, elicitation },
        });
        const resolved = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return codexMcpElicitationResponse(elicitation, resolved);
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload, metadata) =>
      Effect.gen(function* () {
        if (lockdown !== undefined) {
          return { answers: {} };
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: String(metadata.id),
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
          payload: { ...payload, isBlocking: payload.isBlocking ?? true },
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

    yield* client.handleUnknownServerNotification((method, params) =>
      emitEvent({
        kind: "notification",
        threadId: options.threadId,
        method,
        ...(params !== undefined ? { payload: params } : {}),
      }),
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
      if (borrowedSignIn?.kind === "chatgpt") {
        yield* withCodexRequestTimeout(
          "sign in a Codex side answer",
          client.request("account/login/start", {
            type: "chatgptAuthTokens",
            accessToken: borrowedSignIn.accessToken,
            chatgptAccountId: borrowedSignIn.chatgptAccountId,
            ...(borrowedSignIn.chatgptPlanType !== undefined
              ? { chatgptPlanType: borrowedSignIn.chatgptPlanType }
              : {}),
          }),
        );
      }

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId:
          lockdown === undefined ? readResumeCursorThreadId(options.resumeCursor) : undefined,
        resumeRequired: options.resumeRequired,
        forkFrom: lockdown === undefined ? options.forkFrom : undefined,
        lockdown,
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
        providerThreadId,
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
      // A side answer's home (and its copy of the conversation) goes with it.
      if (lockdown !== undefined && resolvedHomePath !== undefined) {
        yield* removeCodexSideAnswerHome(resolvedHomePath);
      }
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
            ...((yield* runsInManagedWorktree) ? { managedWorktree: true } : {}),
            ...(agentPageAssetsDir !== undefined ? { agentPageAssetsDir } : {}),
            ...(lockdown !== undefined ? { lockdown: true } : {}),
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
          yield* withCodexRequestTimeout(
            "interrupt a Codex turn",
            client.request("turn/interrupt", {
              threadId: providerThreadId,
              turnId: effectiveTurnId,
            }),
          );
          // Codex clears provider-side requests owned by an interrupted turn.
          // Release the matching local handlers too, otherwise their deferred
          // waits survive until the entire session closes.
          yield* settlePendingApprovals("cancel");
          yield* settlePendingUserInputs({});
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
      renewSignIn: withCodexRequestTimeout(
        "renew the Codex sign-in",
        client.request("account/read", { refreshToken: true }),
      ).pipe(Effect.asVoid),
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
      readProviderThreadId,
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const { turns } = yield* readCodexThreadTurns({
          client,
          threadId: providerThreadId,
          itemsView: "full",
        });
        return threadSnapshot(providerThreadId, turns);
      }),
      readStoredThread: (providerThreadId) =>
        readCodexThreadTurns({ client, threadId: providerThreadId, itemsView: "full" }).pipe(
          Effect.map(({ thread, turns }) => ({ ...thread, turns: [...turns] })),
        ),
      readStoredThreadMetadata: (providerThreadId) =>
        client
          .request("thread/read", {
            threadId: providerThreadId,
            includeTurns: false,
          })
          .pipe(Effect.map((response) => response.thread)),
      readStoredThreadItems: (input) => client.request("thread/items/list", input),
      startStoredThreadTurn: (providerThreadId, text) =>
        client.request("turn/start", {
          threadId: providerThreadId,
          input: [{ type: "text", text }],
        }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const { snapshot, replacementProviderThreadId } = yield* rollbackCodexThread({
            client,
            threadId: options.threadId,
            providerThreadId,
            numTurns,
            cwd: session.cwd ?? options.cwd,
            runtimeMode: options.runtimeMode,
            model: normalizeCodexModelSlug(session.model),
            serviceTier: options.serviceTier,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
            ...(replacementProviderThreadId !== undefined
              ? {
                  resumeCursor: { threadId: replacementProviderThreadId },
                  providerThreadId: replacementProviderThreadId,
                }
              : {}),
          });
          if (replacementProviderThreadId !== undefined) {
            yield* Effect.logInfo("codex thread rollback moved to a new provider thread", {
              threadId: options.threadId,
              supersededProviderThreadId: providerThreadId,
              replacementProviderThreadId,
              numTurns,
            });
          }
          return snapshot;
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
          const waiting = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          const elicitation = waiting?.elicitation;
          if (elicitation) {
            yield* Effect.try({
              try: () => codexMcpElicitationResponse(elicitation, answers),
              catch: (cause) =>
                CodexErrors.CodexAppServerRequestError.invalidParams(
                  cause instanceof Error ? cause.message : "Invalid form response",
                ),
            });
          }
          const codexAnswers = waiting?.elicitation
            ? undefined
            : yield* toCodexUserInputAnswers(answers);
          const pending = yield* Ref.modify(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return [current.get(requestId), next];
          });
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: pending.elicitation
              ? "mcpServer/elicitation/answered"
              : "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers ?? answers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
