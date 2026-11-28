/**
 * OpenCodeAdapter — `ProviderAdapterShape` for OpenCode 2 (HTTP `/api` + SSE).
 *
 * One OpenCode server per provider instance serves every thread (see
 * `OpenCodeServerManager`); a thread is one OpenCode session in its realpath'd
 * directory. Requests go over HTTP; everything the agent does arrives on the
 * server's single event stream and is routed here by session id.
 *
 * How OpenCode's model maps onto Threadlines turns:
 *
 * - A turn starts with a prompt whose id we choose: `msg_tl_<message id>`. The
 *   turn id *is* that prompt id, so a fork or rollback boundary needs no
 *   lookup, and a resent message is deduplicated by OpenCode.
 * - OpenCode runs prompts in *executions*. A turn ends on the execution's end,
 *   unless input we steered into it is still undelivered: OpenCode then starts
 *   another execution to deliver it, and the turn spans both.
 * - An execution nobody asked for (a background subagent or shell reporting
 *   back) becomes a provider-started turn, the way Claude's do.
 * - Subagents are child sessions. Their events carry the child's session id as
 *   `providerRefs.providerThreadId`, so ingestion files them under the agent.
 *
 * The stream drops whatever happens while it is disconnected, so every
 * reconnect re-reads what the adapter was tracking: running turns, pending
 * approvals and pending questions.
 *
 * @module provider/Layers/OpenCodeAdapter
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ChatAttachment,
  EventId,
  type OpenCodeSettings,
  type ProviderApprovalDecision,
  type ProviderFailureCategory,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSubagentTranscriptEntry,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeMode,
  type RuntimeUsageLimit,
  type ServerProviderSlashCommand,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { withFailureCategory } from "../providerFailureCategory.ts";
import { nonEmptyTrimmed } from "../providerSnapshot.ts";
import {
  MANAGED_WORKTREE_INSTRUCTION,
  renderThreadContextSeed,
  withContextSeedPreamble,
} from "@threadlines/shared/contextSeed";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildFileAttachmentNote, isLargeTextAttachment } from "../fileAttachmentPrompt.ts";
import { ServerConfig } from "../../config.ts";
import {
  mcpEndpointUrl,
  mcpCommandsEndpointUrl,
  mcpDeviceEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import { buildAgentPageInstructions } from "../../mcp/pageTools.ts";
import { buildCommandRequestInstructions } from "../../mcp/commandTools.ts";
import { buildDeviceInstructions } from "../deviceInstructions.ts";
import { buildGuideInstructions } from "../../mcp/guideTools.ts";
import { roomEndpointGrant } from "../../mcp/roomToolAccess.ts";
import { buildScheduleInstructions } from "../../mcp/scheduleTools.ts";
import { ensurePageAssetsDir } from "../../pages/PageStore.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { isLinkedWorktreeCheckout } from "../../vcs/CheckoutPresence.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  steerRejectedError,
} from "../Errors.ts";
import { FILE_LINK_INSTRUCTIONS } from "../fileLinkInstructions.ts";
import {
  type OpenCodeClient,
  OpenCodeError,
  type OpenCodeModelRef,
  openCodeErrorDetail,
  openCodeErrorStatus,
  openCodeErrorTag,
  openCodeModelSlug,
  parseOpenCodeModelSlug,
  runOpenCode,
} from "../opencode/OpenCodeClient.ts";
import type {
  OpenCodeEvent,
  OpenCodeEventOf,
  OpenCodeForm,
  OpenCodePermissionRequest,
  OpenCodeTokens,
} from "../opencode/OpenCodeEvents.ts";
import { openCodeEventSessionId } from "../opencode/OpenCodeEvents.ts";
import {
  isOpenCodeQuestionForm,
  openCodeFormAnswer,
  openCodeFormQuestions,
} from "../opencode/OpenCodeQuestions.ts";
import {
  isOpenCodeRule,
  type OpenCodeRule,
  openCodeBrowserServerName,
  openCodeRoomServerName,
  openCodeCommandsServerName,
  openCodeDeviceServerName,
  openCodePagesServerName,
  openCodeSessionGrantRules,
  openCodeSessionRules,
  openCodeThreadToolKey,
} from "../opencode/OpenCodeRules.ts";
import type {
  OpenCodeServerManagerShape,
  OpenCodeServerSignal,
} from "../opencode/OpenCodeServerManager.ts";
import {
  identifyOpenCodeTool,
  type OpenCodeToolIdentity,
  openCodeCommandOutput,
  openCodeSubagentReport,
  openCodeToolData,
  openCodeToolDetail,
  openCodeToolOutputText,
} from "../opencode/OpenCodeToolItems.ts";
import { buildPreviewPanelInstructions } from "../previewPanelInstructions.ts";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const RESUME_SCHEMA_VERSION = 1;
const BUILD_AGENT = "build";
const PLAN_AGENT = "plan";
/** How long a stop may take before the adapter checks whether OpenCode is still running. */
const STOP_SETTLE_TIMEOUT = Duration.seconds(10);
/** Maximum repeated stop checks before leaving an unresponsive turn open. */
const STOP_SETTLE_MAX_CHECKS = 6;
/** Asking OpenCode whether stopped work ended: each call's limit, and how often to ask again. */
const OPENCODE_CONFIRM_CALL_TIMEOUT = Duration.seconds(5);
const OPENCODE_CONFIRM_RETRY = Duration.millis(500);
const OPENCODE_CONFIRM_ATTEMPTS = 10;
/** How long a turn waits for the execution OpenCode starts to deliver steered input. */
const HELD_END_GRACE = Duration.seconds(5);
/** Maximum repeated inbox polls while waiting for a steered prompt to start executing. */
const HELD_END_MAX_CHECKS = 12;
/** Lists (models, agents) are empty for a moment in a directory the server has not loaded yet. */
const CATALOG_RETRY_DEADLINE = Duration.seconds(5);
/** How long a live shell output poll may wait before returning `pending`. */
const COMMAND_OUTPUT_TIMEOUT_MS = 5_000;
const OPENCODE_PLAN_FILE_PATTERN = /(?:^|[\\/])\.opencode[\\/]plans[\\/][^\\/]+\.md$/iu;
const DECLINE_MESSAGE =
  "The user declined this action. Do not try it again; continue without it or ask the user how to proceed.";
const QUESTION_DISMISSED_MESSAGE =
  "The user dismissed the question without answering. Continue without the answer.";
const UNSUPPORTED_FORM_MESSAGE =
  "This kind of form cannot be shown in Threadlines. Continue without it, or ask in plain text.";

export interface OpenCodeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenCodeSettings;
  readonly manager: OpenCodeServerManagerShape;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  /** Per-session slash commands, for the provider snapshot (`sessionCommands`). */
  readonly onSessionCommands?: (
    sessionKey: string,
    commands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
  ) => Effect.Effect<void>;
  /** Fired when OpenCode reports a catalog, config, skill, command, or credential change. */
  readonly onCatalogChanged?: Effect.Effect<void>;
  /** Current plan usage limit when a rate-limit or quota failure does not name a reset time. */
  readonly readUsageLimit?: Effect.Effect<RuntimeUsageLimit | undefined>;
}

type Terminal =
  | { readonly kind: "succeeded" }
  | {
      readonly kind: "failed";
      readonly message: string | undefined;
      readonly type: string | undefined;
    }
  | { readonly kind: "interrupted"; readonly reason: string | undefined };

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly origin: "user" | "provider";
  /** True when this turn ran on OpenCode's `plan` agent. */
  readonly plan: boolean;
  /** The prompt that opened a user turn; also its fork and rollback boundary. */
  readonly promptId: string | undefined;
  /** Prompts and steers of ours OpenCode has not delivered yet. */
  readonly undelivered: Set<string>;
  /** When the turn began (epoch ms); history after it belongs to the turn. */
  readonly startedAt: number;
  /** Last non-empty assistant text block completed during this turn. */
  finalText: string;
  /** Plan markdown file under `.opencode/plans/` written during this plan turn, if any. */
  planFilePath: string | undefined;
  executionStarted: boolean;
  stopRequested: boolean;
  heldEnd: Terminal | undefined;
  holdToken: number;
  heldEndFiber: Fiber.Fiber<void> | undefined;
  stopCheckFiber: Fiber.Fiber<void> | undefined;
  readonly done: Deferred.Deferred<void>;
}

interface ChildAgent {
  readonly sessionId: string;
  readonly parentSessionId: string;
  /** The turn whose call (re)started it; a reused child moves to the new turn. */
  turnId: TurnId | undefined;
  readonly agent: string | undefined;
  readonly title: string | undefined;
  callId: string | undefined;
  background: boolean;
  status: "running" | "completed" | "failed" | "interrupted";
  lastText: string;
}

interface ToolCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly identity: OpenCodeToolIdentity;
  readonly turnId: TurnId | undefined;
  input: unknown;
  done: boolean;
}

interface Block {
  readonly itemId: string;
  readonly kind: "text" | "reasoning";
  readonly sessionId: string;
  readonly turnId: TurnId | undefined;
  text: string;
  done: boolean;
}

interface PendingApproval {
  readonly permission: OpenCodePermissionRequest;
  readonly requestType: CanonicalRequestType;
  readonly turnId: TurnId | undefined;
}

interface PendingQuestion {
  readonly form: OpenCodeForm;
  readonly turnId: TurnId | undefined;
}

type SessionSignalItem =
  | { readonly _tag: "Event"; readonly event: OpenCodeEvent }
  | { readonly _tag: "ChildSpawned"; readonly event: OpenCodeEventOf<"session.created"> }
  | { readonly _tag: "ShellExited"; readonly event: OpenCodeEventOf<"shell.exited"> }
  | {
      readonly _tag: "Resync";
      readonly activeSessions: Effect.Effect<Option.Option<Record<string, unknown>>>;
      readonly snapshotTurn: ActiveTurn | undefined;
    }
  | {
      readonly _tag: "ShowApprovalCard";
      readonly permission: OpenCodePermissionRequest;
    }
  | {
      readonly _tag: "FinishTurn";
      readonly turn: ActiveTurn;
      readonly terminal: Terminal;
    }
  | {
      readonly _tag: "FinishHeldTurn";
      readonly turn: ActiveTurn;
      readonly holdToken: number;
      readonly terminal: Terminal;
    }
  | {
      readonly _tag: "ServerGone";
      readonly failure: string | undefined;
    };

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly rootSessionId: string;
  readonly directory: string;
  readonly external: boolean;
  readonly generation: number;
  readonly client: OpenCodeClient;
  readonly scope: Scope.Closeable;
  /** Per-session FIFO queue so one thread's HTTP work never blocks another thread's SSE stream. */
  readonly eventQueue: Queue.Queue<SessionSignalItem>;
  readonly toolKey: string;
  /** Whether Threadlines' local loopback MCP servers are attached for this session. */
  localToolServers: boolean;
  /** The room endpoint is attached: every room tool, or the app guide alone (roomEndpointGrant). */
  readonly roomEndpoint: boolean;
  /** With the room tools: agents may change scheduled tasks; its instructions say so. */
  readonly scheduleTools: boolean;
  /** The page tools' image folder, when the session has them. */
  readonly agentPageAssetsDir: string | undefined;
  /** The session has `ask_user_to_run`. */
  readonly commandRequests: boolean;
  /** The session has the device tools. */
  readonly deviceTools: boolean;
  /** The project's brief (ProviderSessionStartInput.projectInstructions), last in the instructions entry. */
  readonly projectInstructions: string | undefined;
  readonly runtimeMode: RuntimeMode;
  agent: string;
  /** Preferred non-plan primary agent for this session (kept when resuming a custom agent). */
  defaultAgent: string;
  model: OpenCodeModelRef | undefined;
  contextLimit: number | undefined;
  pendingSeed: string | undefined;
  activeTurn: ActiveTurn | undefined;
  /**
   * Executions to discard rather than show as the agent's turn: the empty
   * one a revert clear starts, and the wake a stopped subagent's report
   * would cause.
   */
  silenceNextWake: boolean;
  /**
   * Started fresh from outside work (`quietResume`): until Threadlines sends
   * this runtime a turn, nothing the previous runtime left queued in the
   * native session (a report, a shell's exit) may wake it.
   */
  quietUntilTurn: boolean;
  silencedExecution: boolean;
  /** Reports from subagents the user stopped, withdrawn before they wake the agent. */
  readonly withdrawnReports: Set<string>;
  readonly turns: Array<{ readonly id: TurnId; readonly promptId: string | undefined }>;
  /** Rules currently on each owned OpenCode session (root and children). */
  readonly rules: Map<string, ReadonlyArray<OpenCodeRule>>;
  /** Resolves once initial base rules for a spawned child have been installed (or failed). */
  readonly childRulesReady: Map<string, Deferred.Deferred<void>>;
  readonly children: Map<string, ChildAgent>;
  readonly stoppedChildren: Set<string>;
  readonly tools: Map<string, ToolCall>;
  readonly blocks: Map<string, Block>;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly approvalIds: Map<string, ApprovalRequestId>;
  /** Full-access auto-approvals currently in flight (permissionId -> sessionId). */
  readonly inFlightAutoApprovals: Map<string, string>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly questionIds: Map<string, ApprovalRequestId>;
  /** Unsupported form cancellations currently in flight (formId -> sessionId). */
  readonly inFlightFormCancels: Map<string, string>;
  readonly backgroundShells: Map<
    string,
    {
      readonly callId: string;
      readonly sessionId: string;
      readonly description?: string;
    }
  >;
  /** Background shells the user moved past (`releaseBackgroundCommands`); kept alive, not awaited. */
  readonly releasedBackgroundShells: Set<string>;
  /** Diff previews from approval requests, by tool call: `write` reports none when it succeeds. */
  readonly approvalPreviews: Map<string, unknown>;
  readonly shellCalls: Map<string, string>;
  compactionCount: number;
  readonly turnStartLock: Semaphore.Semaphore;
  /** Held while a steer is sent, so Stop withdraws it rather than racing it. */
  readonly steerLock: Semaphore.Semaphore;
  /** Currently executing reconnect resync fiber, interrupted immediately on `ServerGone`. */
  activeResyncFiber: Fiber.Fiber<void, never> | undefined;
  /** Number of queued/running `Resync` items accounted in `resyncsInFlightByGeneration`. */
  pendingResyncCount: number;
  /** Set when `ServerGone` is observed so queued resyncs skip dead-server HTTP calls. */
  serverGone: boolean;
  stopped: boolean;
  /** Resolved when `stopContext` runs so callers awaiting queue settlement never hang. */
  readonly stoppedDeferred: Deferred.Deferred<void>;
}

interface AgentInfo {
  readonly id: string;
  readonly mode: string | undefined;
  readonly rules: ReadonlyArray<OpenCodeRule>;
}

interface ModelInfo {
  readonly ref: { readonly providerID: string; readonly id: string };
  readonly contextLimit: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackServerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function resolveProjectPlanFilePath(
  directory: string,
  rawPath: string,
): { readonly absolute: string; readonly relative: string } | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed || !OPENCODE_PLAN_FILE_PATTERN.test(trimmed)) return undefined;
  const plansDir = NodePath.resolve(directory, ".opencode", "plans");
  const absolute = NodePath.resolve(directory, trimmed);
  const rel = NodePath.relative(plansDir, absolute);
  if (
    rel.length === 0 ||
    rel.startsWith("..") ||
    NodePath.isAbsolute(rel) ||
    /[\\/]/u.test(rel) ||
    !/\.md$/iu.test(rel)
  ) {
    return undefined;
  }
  return { absolute, relative: `.opencode/plans/${rel}` };
}

function extractPlanFilePath(
  directory: string,
  toolInput: unknown,
  metadata: unknown,
): string | undefined {
  if (isRecord(metadata) && Array.isArray(metadata.files)) {
    for (const file of metadata.files) {
      if (!isRecord(file)) continue;
      for (const key of ["filePath", "path", "file"] as const) {
        const candidate = file[key];
        if (typeof candidate === "string") {
          const resolved = resolveProjectPlanFilePath(directory, candidate);
          if (resolved) return resolved.relative;
        }
      }
    }
  }
  if (isRecord(toolInput)) {
    for (const key of ["filePath", "path", "file"] as const) {
      const candidate = toolInput[key];
      if (typeof candidate === "string") {
        const resolved = resolveProjectPlanFilePath(directory, candidate);
        if (resolved) return resolved.relative;
      }
    }
  }
  return undefined;
}

function isOpenCodeSessionNotFound(error: OpenCodeError): boolean {
  return openCodeErrorStatus(error) === 404 || openCodeErrorTag(error) === "SessionNotFoundError";
}

/** The prompt id for a Threadlines message: stable, so a resend is the same prompt. */
export function openCodePromptId(messageId: string | undefined, fallback: string): string {
  const raw = (messageId ?? fallback).replace(/[^A-Za-z0-9_-]/gu, "");
  return `msg_tl_${raw.length > 0 ? raw : fallback.replace(/[^A-Za-z0-9]/gu, "")}`;
}

export function parseOpenCodeResumeCursor(
  raw: unknown,
): { readonly sessionId: string } | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== RESUME_SCHEMA_VERSION) return undefined;
  return typeof raw.sessionId === "string" && raw.sessionId.startsWith("ses_")
    ? { sessionId: raw.sessionId }
    : undefined;
}

function terminalFromEvent(event: OpenCodeEvent): Terminal | undefined {
  switch (event.type) {
    case "session.execution.succeeded":
      return { kind: "succeeded" };
    case "session.execution.failed":
      return { kind: "failed", message: event.data.error?.message, type: event.data.error?.type };
    case "session.execution.interrupted":
      return { kind: "interrupted", reason: event.data.reason };
    default:
      return undefined;
  }
}

function requestTypeForAction(action: string): CanonicalRequestType {
  switch (action) {
    case "shell":
      return "exec_command_approval";
    case "edit":
      return "file_change_approval";
    case "read":
    case "external_directory":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

function usedContextTokens(tokens: OpenCodeTokens): number {
  return Math.max(
    0,
    Math.round(
      tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) + tokens.output,
    ),
  );
}

/**
 * The failure category OpenCode's error type names (the `type` of its
 * structured error, as in 2.0's `provider.rate-limit`). Types not listed leave
 * it unset.
 */
export function openCodeFailureCategory(
  type: string | undefined,
): ProviderFailureCategory | undefined {
  switch (type) {
    case "provider.rate-limit":
    case "provider.quota":
      return "rate_limit";
    case "provider.auth":
      return "auth";
    case "provider.content-filter":
      return "refusal";
    case "provider.transport":
    case "provider.timeout":
      return "network";
    case "provider.internal":
      return "server_error";
    case "provider.invalid-request":
    case "provider.unsupported-operation":
      return "validation";
    case "provider.no-route":
      return "model_unavailable";
    case "permission.rejected":
      return "permission";
    default:
      return undefined;
  }
}

function failureMessage(terminal: Extract<Terminal, { kind: "failed" }>): string {
  const message = terminal.message?.trim() || "OpenCode reported the run failed.";
  return terminal.type === "provider.auth"
    ? `${message} Sign in to a model provider with \`opencode auth login\`.`
    : message;
}

export function makeOpenCodeAdapter(options: OpenCodeAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const adapterScope = yield* Scope.Scope;
    const { manager, nativeEventLogger } = options;
    const boundInstanceId = options.instanceId;

    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();
    /**
     * Work a stop interrupted, by session key, until OpenCode confirms it
     * ended (confirmThreadStopped). One OpenCode server runs every thread's
     * agent, so the server's own word is the proof: its process stays up.
     */
    const stoppedWork = new Map<
      ThreadId,
      {
        readonly generation: number;
        readonly client: OpenCodeClient;
        readonly directory: string;
        readonly sessionIds: ReadonlyArray<string>;
        readonly shellIds: ReadonlyArray<string>;
      }
    >();
    /**
     * Session keys this process ran. One it never ran may still have work on
     * the server from before a restart, whose stop evidence died with the
     * process: confirmThreadStopped asks the server about it instead.
     */
    const ranHere = new Set<ThreadId>();
    /** Every OpenCode session we own, root or child, to the thread it belongs to. */
    const owners = new Map<string, SessionContext>();
    /** Which session registered each Threadlines tool server, so a stale stop never removes a newer one. */
    const toolServerOwners = new Map<string, SessionContext>();
    const agentCache = new Map<
      string,
      { readonly generation: number; readonly value: ReadonlyArray<AgentInfo> }
    >();
    const modelCache = new Map<
      string,
      { readonly generation: number; readonly value: ReadonlyArray<ModelInfo> }
    >();
    const MCP_SERVER_CACHE_TTL_MS = 30_000;
    let mcpCacheVersion = 0;
    let commandCacheVersion = 0;
    const mcpServerCache = new Map<
      string,
      {
        readonly generation: number;
        readonly version: number;
        readonly loadedAtMs: number;
        readonly value: ReadonlyArray<string>;
      }
    >();
    const commandCache = new Map<
      string,
      {
        readonly generation: number;
        readonly version: number;
        readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
        readonly names: ReadonlySet<string>;
      }
    >();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const stamp = Effect.all({
      eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
      createdAt: nowIso,
    });
    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

    /** The base of every event: child sessions are named so ingestion files them under the agent. */
    const eventBase = (ctx: SessionContext, sessionId: string, turnId: TurnId | undefined) =>
      Effect.map(stamp, (s) => ({
        ...s,
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
        ...(sessionId !== ctx.rootSessionId
          ? { providerRefs: { providerThreadId: sessionId } }
          : {}),
      }));

    const OPENCODE_STREAM_FRAGMENT_EVENT_TYPES = new Set<string>([
      "session.text.delta",
      "session.reasoning.delta",
    ]);

    const logNative = (ctx: SessionContext, event: OpenCodeEvent) => {
      const streamFragment = OPENCODE_STREAM_FRAGMENT_EVENT_TYPES.has(event.type);
      if (
        !nativeEventLogger ||
        (streamFragment && nativeEventLogger.keepsStreamFragments === false)
      ) {
        return Effect.void;
      }
      return Effect.flatMap(nowIso, (observedAt) =>
        nativeEventLogger.write(
          { observedAt, event: { provider: PROVIDER, method: event.type, payload: event } },
          ctx.threadId,
          { streamFragment },
        ),
      ).pipe(Effect.ignore);
    };

    const toRequestError = (method: string) => (error: OpenCodeError) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: error.detail,
        cause: error,
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    // ── Catalogs ─────────────────────────────────────────────────────────

    /** Model and agent lists are empty until a new directory finishes loading. */
    const loadNonEmpty = <A>(load: Effect.Effect<ReadonlyArray<A>, OpenCodeError>) =>
      load.pipe(
        Effect.flatMap((items) =>
          items.length > 0 ? Effect.succeed(items) : Effect.fail("empty" as const),
        ),
        Effect.retry({
          while: (error) => error === "empty",
          schedule: Schedule.spaced(Duration.millis(250)),
          times: 20,
        }),
        Effect.timeoutOption(CATALOG_RETRY_DEADLINE),
        Effect.map((found) => (found._tag === "Some" ? found.value : [])),
        Effect.catch((error) => (error === "empty" ? Effect.succeed([]) : Effect.fail(error))),
      );

    const loadAgents = (client: OpenCodeClient, directory: string, generation: number) =>
      Effect.gen(function* () {
        const cached = agentCache.get(directory);
        if (cached && cached.generation === generation && cached.value.length > 0) {
          return cached.value;
        }
        const agents = yield* loadNonEmpty(
          runOpenCode("agent.list", (signal) =>
            client.agent.list({ location: { directory } }, { signal }),
          ).pipe(
            Effect.map((result) =>
              (result.data ?? []).map((agent): AgentInfo => ({
                id: agent.id,
                mode: agent.mode,
                rules: (agent.permissions ?? []).filter(isOpenCodeRule),
              })),
            ),
          ),
        );
        if (agents.length > 0 && (agentCache.get(directory)?.generation ?? -1) <= generation) {
          agentCache.set(directory, { generation, value: agents });
        }
        return agents;
      });

    const loadModels = (client: OpenCodeClient, directory: string, generation: number) =>
      Effect.gen(function* () {
        const cached = modelCache.get(directory);
        if (cached && cached.generation === generation && cached.value.length > 0) {
          return cached.value;
        }
        const models = yield* loadNonEmpty(
          runOpenCode("model.list", (signal) =>
            client.model.list({ location: { directory } }, { signal }),
          ).pipe(
            Effect.map((result) =>
              (result.data ?? []).map((model): ModelInfo => ({
                ref: { providerID: model.providerID, id: model.id },
                contextLimit: model.limit?.input ?? model.limit?.context,
              })),
            ),
          ),
        );
        if (models.length > 0 && (modelCache.get(directory)?.generation ?? -1) <= generation) {
          modelCache.set(directory, { generation, value: models });
        }
        return models;
      });

    const loadMcpServers = (client: OpenCodeClient, directory: string, generation: number) =>
      Effect.suspend(() => {
        const version = mcpCacheVersion;
        return runOpenCode("mcp.list", (signal) =>
          client.mcp.list({ location: { directory } }, { signal }),
        ).pipe(
          Effect.map((result) => (result.data ?? []).map((server) => server.name)),
          Effect.tap((names) =>
            Effect.sync(() => {
              const existing = mcpServerCache.get(directory);
              if (
                version === mcpCacheVersion &&
                (existing?.generation ?? -1) <= generation &&
                (existing?.version ?? -1) <= version
              ) {
                mcpServerCache.set(directory, {
                  generation,
                  version,
                  loadedAtMs: Date.now(),
                  value: names,
                });
              }
            }),
          ),
          Effect.orElseSucceed(() => mcpServerCache.get(directory)?.value ?? []),
        );
      });

    /** The project's slash commands (`/init`, `/review`, the user's own). */
    const loadCommands = (client: OpenCodeClient, directory: string, generation: number) =>
      Effect.gen(function* () {
        const version = commandCacheVersion;
        const cached = commandCache.get(directory);
        if (cached && cached.generation === generation && cached.version === version) {
          return { commands: cached.commands, names: cached.names, version };
        }
        const commands = yield* runOpenCode("command.list", (signal) =>
          client.command.list({ location: { directory } }, { signal }),
        ).pipe(
          Effect.map((result) =>
            (result.data ?? []).flatMap((command): ReadonlyArray<ServerProviderSlashCommand> => {
              const name = nonEmptyTrimmed(command.name);
              if (!name) return [];
              const description = nonEmptyTrimmed(command.description);
              return [{ name, ...(description ? { description } : {}) }];
            }),
          ),
          Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderSlashCommand>),
        );
        const names = new Set(commands.map((command) => command.name));
        const existing = commandCache.get(directory);
        if (
          version === commandCacheVersion &&
          commands.length > 0 &&
          (existing?.generation ?? -1) <= generation &&
          (existing?.version ?? -1) <= version
        ) {
          commandCache.set(directory, { generation, version, commands, names });
        }
        return { commands, names, version };
      });

    const publishSessionCommands = (ctx: SessionContext) =>
      options.onSessionCommands
        ? loadCommands(ctx.client, ctx.directory, ctx.generation).pipe(
            Effect.flatMap(({ commands, version }) =>
              ctx.stopped || version !== commandCacheVersion
                ? Effect.void
                : options.onSessionCommands!(ctx.threadId, commands),
            ),
            Effect.ignore,
          )
        : Effect.void;

    const cachedContextLimit = (
      directory: string,
      generation: number,
      model: OpenCodeModelRef | undefined,
    ): { readonly hit: true; readonly value: number | undefined } | { readonly hit: false } => {
      if (!model) return { hit: true, value: undefined };
      const cached = modelCache.get(directory);
      if (!cached || cached.generation !== generation || cached.value.length === 0) {
        return { hit: false };
      }
      const found = cached.value.find(
        (candidate) =>
          candidate.ref.providerID === model.providerID && candidate.ref.id === model.id,
      );
      return { hit: true, value: found?.contextLimit };
    };

    const contextLimitFor = (ctx: SessionContext, model: OpenCodeModelRef | undefined) =>
      Effect.gen(function* () {
        if (!model) return undefined;
        const models = yield* loadModels(ctx.client, ctx.directory, ctx.generation).pipe(
          Effect.orElseSucceed(() => []),
        );
        return models.find(
          (candidate) =>
            candidate.ref.providerID === model.providerID && candidate.ref.id === model.id,
        )?.contextLimit;
      });

    const rulesFor = (ctx: SessionContext, agentId: string) =>
      Effect.gen(function* () {
        const agents = yield* loadAgents(ctx.client, ctx.directory, ctx.generation);
        if (agents.length === 0) {
          return yield* new OpenCodeError({
            operation: "agent.list",
            detail: "OpenCode returned no agents, so session permission rules could not be built.",
          });
        }
        return openCodeSessionRules({
          runtimeMode: ctx.runtimeMode,
          agentRules: agents.find((agent) => agent.id === agentId)?.rules ?? [],
          toolKey: ctx.toolKey,
          browserTools: ctx.localToolServers,
          roomTools: ctx.localToolServers && ctx.roomEndpoint,
          agentPages: ctx.localToolServers && ctx.agentPageAssetsDir !== undefined,
          commandRequests: ctx.localToolServers && ctx.commandRequests,
          deviceTools: ctx.localToolServers && ctx.deviceTools,
        });
      });

    const applyRules = (
      ctx: SessionContext,
      sessionId: string,
      rules: ReadonlyArray<OpenCodeRule>,
    ) =>
      runOpenCode("session.update", (signal) =>
        ctx.client.session.update({ sessionID: sessionId, permissions: rules }, { signal }),
      ).pipe(Effect.tap(() => Effect.sync(() => ctx.rules.set(sessionId, rules))));

    // ── Runtime events ───────────────────────────────────────────────────

    const turnIdFor = (ctx: SessionContext, sessionId: string): TurnId | undefined =>
      sessionId === ctx.rootSessionId
        ? ctx.activeTurn?.turnId
        : (ctx.children.get(sessionId)?.turnId ?? ctx.activeTurn?.turnId);

    const closeBlocks = (ctx: SessionContext, sessionId: string) =>
      Effect.forEach(
        [...ctx.blocks.values()].filter((block) => block.sessionId === sessionId && !block.done),
        (block) => completeBlock(ctx, block),
        { discard: true },
      );

    const startBlock = (
      ctx: SessionContext,
      sessionId: string,
      kind: Block["kind"],
      assistantMessageId: string,
      ordinal: number,
    ) =>
      Effect.gen(function* () {
        const key = `${sessionId}:${assistantMessageId}:${kind}:${ordinal}`;
        const existing = ctx.blocks.get(key);
        if (existing) return existing;
        const block: Block = {
          itemId: `${assistantMessageId}:${kind}:${ordinal}`,
          kind,
          sessionId,
          turnId: turnIdFor(ctx, sessionId),
          text: "",
          done: false,
        };
        ctx.blocks.set(key, block);
        yield* emit({
          type: "item.started",
          ...(yield* eventBase(ctx, sessionId, block.turnId)),
          itemId: RuntimeItemId.make(block.itemId),
          payload:
            kind === "text"
              ? { itemType: "assistant_message", status: "inProgress" }
              : { itemType: "reasoning", status: "inProgress", title: "Thinking" },
        });
        return block;
      });

    const appendBlock = (ctx: SessionContext, block: Block, delta: string) =>
      Effect.gen(function* () {
        if (delta.length === 0 || block.done) return;
        block.text += delta;
        yield* emit({
          type: "content.delta",
          ...(yield* eventBase(ctx, block.sessionId, block.turnId)),
          itemId: RuntimeItemId.make(block.itemId),
          payload: {
            streamKind: block.kind === "text" ? "assistant_text" : "reasoning_summary_text",
            delta,
          },
        });
      });

    const completeBlock = (ctx: SessionContext, block: Block, finalText?: string) =>
      Effect.gen(function* () {
        if (block.done) return;
        // The end event carries the whole text; deltas missed while the
        // stream was down are made up here.
        if (finalText !== undefined && finalText.startsWith(block.text)) {
          yield* appendBlock(ctx, block, finalText.slice(block.text.length));
        }
        block.done = true;
        if (block.kind === "text") {
          const trimmed = block.text.trim();
          if (block.sessionId === ctx.rootSessionId) {
            if (trimmed && ctx.activeTurn && block.turnId === ctx.activeTurn.turnId) {
              ctx.activeTurn.finalText = trimmed;
            }
          } else {
            const child = ctx.children.get(block.sessionId);
            if (child && trimmed) child.lastText = trimmed;
          }
        }
        const summary = block.text.trim();
        block.text = "";
        yield* emit({
          type: "item.completed",
          ...(yield* eventBase(ctx, block.sessionId, block.turnId)),
          itemId: RuntimeItemId.make(block.itemId),
          payload:
            block.kind === "text"
              ? {
                  itemType: "assistant_message",
                  status: "completed",
                  ...(summary ? { detail: summary.slice(0, 4_000) } : {}),
                }
              : {
                  itemType: "reasoning",
                  status: "completed",
                  title: "Thinking",
                  ...(summary ? { data: { summary } } : {}),
                },
        });
      });

    const toolStarted = (ctx: SessionContext, sessionId: string, callId: string, name: string) =>
      Effect.gen(function* () {
        if (ctx.tools.has(callId)) return ctx.tools.get(callId)!;
        const identity = identifyOpenCodeTool(name, mcpServerCache.get(ctx.directory)?.value ?? []);
        const tool: ToolCall = {
          callId,
          sessionId,
          name,
          identity,
          turnId: turnIdFor(ctx, sessionId),
          input: undefined,
          done: false,
        };
        ctx.tools.set(callId, tool);
        yield* emit({
          type: "item.started",
          ...(yield* eventBase(ctx, sessionId, tool.turnId)),
          itemId: RuntimeItemId.make(callId),
          payload: {
            itemType: identity.itemType,
            status: "inProgress",
            title: identity.title,
            data:
              identity.kind === "subagent"
                ? subagentItemData(ctx, tool, "inProgress")
                : openCodeToolData({
                    name,
                    identity,
                    directory: ctx.directory,
                    toolInput: undefined,
                  }),
          },
        });
        return tool;
      });

    /** Codex's collab item shape, which the Agents panel builds its rows from. */
    const subagentItemData = (
      ctx: SessionContext,
      tool: ToolCall,
      status: "inProgress" | "completed" | "failed",
      result?: string,
    ) => {
      const child = [...ctx.children.values()].find(
        (candidate) => candidate.callId === tool.callId,
      );
      const input = isRecord(tool.input) ? tool.input : {};
      return {
        toolName: tool.name,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
        item: {
          id: tool.callId,
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status,
          senderThreadId: tool.sessionId,
          receiverThreadIds: child ? [child.sessionId] : [],
          ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
          ...(typeof input.agent === "string" ? { agentRole: input.agent } : {}),
          ...(typeof input.model === "string" ? { model: input.model } : {}),
          agentsStates: child
            ? {
                [child.sessionId]: { status: child.status, ...(result ? { message: result } : {}) },
              }
            : {},
        },
      };
    };

    const toolUpdated = (ctx: SessionContext, tool: ToolCall) =>
      Effect.gen(function* () {
        const detail = openCodeToolDetail(tool.identity, tool.input);
        yield* emit({
          type: "item.updated",
          ...(yield* eventBase(ctx, tool.sessionId, tool.turnId)),
          itemId: RuntimeItemId.make(tool.callId),
          payload: {
            itemType: tool.identity.itemType,
            status: "inProgress",
            title: tool.identity.title,
            ...(detail ? { detail } : {}),
            data:
              tool.identity.kind === "subagent"
                ? subagentItemData(ctx, tool, "inProgress")
                : openCodeToolData({
                    name: tool.name,
                    identity: tool.identity,
                    directory: ctx.directory,
                    toolInput: tool.input,
                  }),
          },
        });
      });

    const toolFinished = (
      ctx: SessionContext,
      tool: ToolCall,
      outcome: {
        readonly failed: boolean;
        readonly declined?: boolean;
        readonly content?: ReadonlyArray<unknown>;
        readonly metadata?: unknown;
        readonly error?: string;
      },
    ) =>
      Effect.gen(function* () {
        if (tool.done) return;
        tool.done = true;
        if (
          !outcome.failed &&
          tool.sessionId === ctx.rootSessionId &&
          tool.identity.kind === "edit" &&
          ctx.activeTurn?.plan &&
          tool.turnId === ctx.activeTurn.turnId
        ) {
          const planPath = extractPlanFilePath(ctx.directory, tool.input, outcome.metadata);
          if (planPath) ctx.activeTurn.planFilePath = planPath;
        }
        const base = yield* eventBase(ctx, tool.sessionId, tool.turnId);
        if (tool.identity.kind === "shell") {
          const output = openCodeCommandOutput(outcome.content) || outcome.error || "";
          if (output) {
            yield* emit({
              type: "content.delta",
              ...base,
              itemId: RuntimeItemId.make(tool.callId),
              payload: { streamKind: "command_output", delta: output },
            });
          }
        }
        const detail = openCodeToolDetail(tool.identity, tool.input);
        const resultText = openCodeToolOutputText(outcome.content);
        yield* emit({
          type: "item.completed",
          ...(yield* eventBase(ctx, tool.sessionId, tool.turnId)),
          itemId: RuntimeItemId.make(tool.callId),
          payload: {
            itemType: tool.identity.itemType,
            status: outcome.declined ? "declined" : outcome.failed ? "failed" : "completed",
            title: tool.identity.title,
            ...(detail ? { detail } : {}),
            data:
              tool.identity.kind === "subagent"
                ? subagentItemData(
                    ctx,
                    tool,
                    outcome.failed ? "failed" : "completed",
                    openCodeSubagentReport(resultText),
                  )
                : {
                    ...openCodeToolData({
                      name: tool.name,
                      identity: tool.identity,
                      directory: ctx.directory,
                      toolInput: tool.input,
                      metadata: outcome.metadata,
                      ...(outcome.content !== undefined ? { content: outcome.content } : {}),
                      failed: outcome.failed,
                      final: true,
                    }),
                    ...(tool.sessionId !== ctx.rootSessionId
                      ? { sourceAgentThreadId: tool.sessionId }
                      : {}),
                    ...(outcome.error ? { error: outcome.error } : {}),
                  },
          },
        });
        ctx.approvalPreviews.delete(tool.callId);
        if (tool.identity.kind !== "subagent" && tool.identity.kind !== "shell") {
          tool.input = undefined;
        }
      });

    const closeTools = (ctx: SessionContext, sessionId: string, failed: boolean) =>
      Effect.forEach(
        [...ctx.tools.values()].filter((tool) => tool.sessionId === sessionId && !tool.done),
        (tool) => toolFinished(ctx, tool, { failed }),
        { discard: true },
      );

    // ── Approvals and questions ──────────────────────────────────────────

    const resolveApproval = (
      ctx: SessionContext,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const pending = ctx.approvals.get(requestId);
        if (!pending) return;
        ctx.approvals.delete(requestId);
        ctx.approvalIds.delete(pending.permission.id);
        yield* emit({
          type: "request.resolved",
          ...(yield* eventBase(ctx, pending.permission.sessionID, pending.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: pending.requestType, decision },
        });
      });

    const resolveQuestion = (
      ctx: SessionContext,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const pending = ctx.questions.get(requestId);
        if (!pending) return;
        ctx.questions.delete(requestId);
        ctx.questionIds.delete(pending.form.id);
        yield* emit({
          type: "user-input.resolved",
          ...(yield* eventBase(ctx, pending.form.sessionID, pending.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    /** OpenCode drops a session's pending requests silently when its execution ends. */
    const dropPendingRequests = (ctx: SessionContext, sessionId: string | undefined) =>
      Effect.gen(function* () {
        if (sessionId === undefined) {
          ctx.inFlightAutoApprovals.clear();
          ctx.inFlightFormCancels.clear();
        } else {
          for (const [permissionId, ownerSessionId] of ctx.inFlightAutoApprovals) {
            if (ownerSessionId === sessionId) ctx.inFlightAutoApprovals.delete(permissionId);
          }
          for (const [formId, ownerSessionId] of ctx.inFlightFormCancels) {
            if (ownerSessionId === sessionId) ctx.inFlightFormCancels.delete(formId);
          }
        }
        // Resolving deletes from these maps; walk a copy.
        for (const [requestId, pending] of Array.from(ctx.approvals)) {
          if (sessionId === undefined || pending.permission.sessionID === sessionId) {
            yield* resolveApproval(ctx, requestId, "cancel");
          }
        }
        for (const [requestId, pending] of Array.from(ctx.questions)) {
          if (sessionId === undefined || pending.form.sessionID === sessionId) {
            yield* resolveQuestion(ctx, requestId, {});
          }
        }
      });

    const replyPermission = (
      ctx: SessionContext,
      permission: OpenCodePermissionRequest,
      decision: "once" | "reject",
      message?: string,
    ) =>
      runOpenCode("permission.reply", (signal) =>
        ctx.client.permission.reply(
          {
            sessionID: permission.sessionID,
            requestID: permission.id,
            decision,
            ...(message ? { message } : {}),
          },
          { signal },
        ),
      );

    const showApprovalCard = (ctx: SessionContext, permission: OpenCodePermissionRequest) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.approvalIds.has(permission.id)) return;
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const requestType = requestTypeForAction(permission.action);
        const turnId = turnIdFor(ctx, permission.sessionID);
        ctx.approvals.set(requestId, { permission, requestType, turnId });
        ctx.approvalIds.set(permission.id, requestId);
        const detail = permission.resources.join("\n").trim();
        yield* emit({
          type: "request.opened",
          ...(yield* eventBase(ctx, permission.sessionID, turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType,
            ...(detail ? { detail: detail.slice(0, 2_000) } : {}),
            args: {
              action: permission.action,
              resources: permission.resources,
              ...(requestType === "dynamic_tool_call" ? { toolName: permission.action } : {}),
              ...(permission.action === "shell" ? { command: detail } : {}),
            },
          },
          raw: { source: "opencode.sdk.event", method: "permission.asked", payload: permission },
        });
      });

    const openApproval = (ctx: SessionContext, permission: OpenCodePermissionRequest) =>
      Effect.gen(function* () {
        if (ctx.approvalIds.has(permission.id) || ctx.inFlightAutoApprovals.has(permission.id)) {
          return;
        }
        const callId = permission.source?.id;
        if (callId && isRecord(permission.metadata) && Array.isArray(permission.metadata.files)) {
          ctx.approvalPreviews.set(callId, permission.metadata);
        }
        // Full access approves whatever OpenCode would ask; the user's own
        // denies never reach here, so they still hold. Fork the HTTP reply off
        // the session's event loop so streaming deltas don't stall behind it.
        if (ctx.runtimeMode === "full-access") {
          ctx.inFlightAutoApprovals.set(permission.id, permission.sessionID);
          yield* replyPermission(ctx, permission, "once").pipe(
            Effect.retry({ times: 1 }),
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("OpenCode auto-approval failed; asking the user", { error }).pipe(
                Effect.as(false),
              ),
            ),
            Effect.flatMap((approved) => {
              // On success, clear the in-flight entry right away. On failure,
              // keep it until `ShowApprovalCard` executes on `ctx.eventQueue` so
              // an earlier `permission.replied` or turn end cancels the fallback.
              if (approved) {
                ctx.inFlightAutoApprovals.delete(permission.id);
                return Effect.void;
              }
              if (!ctx.inFlightAutoApprovals.has(permission.id) || ctx.stopped) {
                return Effect.void;
              }
              return Queue.offer(ctx.eventQueue, {
                _tag: "ShowApprovalCard",
                permission,
              }).pipe(Effect.asVoid);
            }),
            Effect.forkIn(ctx.scope, { startImmediately: true }),
          );
          return;
        }
        yield* showApprovalCard(ctx, permission);
      });

    const openQuestion = (ctx: SessionContext, form: OpenCodeForm) =>
      Effect.gen(function* () {
        if (ctx.questionIds.has(form.id) || ctx.inFlightFormCancels.has(form.id)) return;
        if (!isOpenCodeQuestionForm(form)) {
          ctx.inFlightFormCancels.set(form.id, form.sessionID);
          yield* runOpenCode("form.cancel", (signal) =>
            ctx.client.session.form.cancel(
              { sessionID: form.sessionID, formID: form.id, message: UNSUPPORTED_FORM_MESSAGE },
              { signal },
            ),
          ).pipe(
            Effect.retry({ times: 1 }),
            // A form nobody can answer or dismiss would hold the run forever.
            // Skip interrupting if the form already resolved or the turn ended.
            Effect.catch(() =>
              ctx.stopped || !ctx.inFlightFormCancels.has(form.id)
                ? Effect.void
                : runOpenCode("session.interrupt", (signal) =>
                    ctx.client.session.interrupt({ sessionID: form.sessionID }, { signal }),
                  ).pipe(Effect.ignore),
            ),
            Effect.ensuring(Effect.sync(() => ctx.inFlightFormCancels.delete(form.id))),
            Effect.forkIn(ctx.scope, { startImmediately: true }),
          );
          return;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = turnIdFor(ctx, form.sessionID);
        ctx.questions.set(requestId, { form, turnId });
        ctx.questionIds.set(form.id, requestId);
        yield* emit({
          type: "user-input.requested",
          ...(yield* eventBase(ctx, form.sessionID, turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: { questions: openCodeFormQuestions(form) },
          raw: { source: "opencode.sdk.event", method: "form.created", payload: form },
        });
      });

    // ── Background tasks ────────────────────────────────────────────────

    const publishBackgroundTasks = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const shellTasks = [...ctx.backgroundShells.entries()].map(([shellId, shell]) => ({
          taskId: RuntimeTaskId.make(shellId),
          taskType: "local_bash",
          kind: "command" as const,
          toolUseId: shell.callId,
          stoppable: true,
          ...(shell.description ? { description: shell.description } : {}),
          ...(ctx.releasedBackgroundShells.has(shellId) ? { awaited: false } : {}),
        }));
        const agentTasks = [...ctx.children.values()]
          .filter((child) => child.background && child.status === "running")
          .map((child) => ({
            taskId: RuntimeTaskId.make(child.sessionId),
            taskType: "local_agent",
            kind: "agent" as const,
            stoppable: true,
            ...(child.callId ? { toolUseId: child.callId } : {}),
            ...(child.title ? { description: child.title } : {}),
          }));
        yield* emit({
          type: "task.snapshot.updated",
          ...(yield* eventBase(ctx, ctx.rootSessionId, ctx.activeTurn?.turnId)),
          payload: {
            tasks: [...shellTasks, ...agentTasks],
          },
        });
      });

    // ── Turns ────────────────────────────────────────────────────────────

    const finishTurn = (ctx: SessionContext, turn: ActiveTurn, terminal: Terminal) =>
      Effect.gen(function* () {
        if (ctx.activeTurn !== turn) return;
        const heldFiber = turn.heldEndFiber;
        turn.heldEndFiber = undefined;
        if (heldFiber) yield* Fiber.interrupt(heldFiber);
        const stopFiber = turn.stopCheckFiber;
        turn.stopCheckFiber = undefined;
        if (stopFiber) yield* Fiber.interrupt(stopFiber);
        yield* closeBlocks(ctx, ctx.rootSessionId);
        yield* closeTools(ctx, ctx.rootSessionId, terminal.kind !== "succeeded");
        yield* dropPendingRequests(ctx, ctx.rootSessionId);
        // Retain the just-finished turn's tombstones so queued stream frames
        // arriving after a reconnect resync still deduplicate and attach
        // background shells, while capping older finished turns' tombstones.
        const MAX_RETAINED_DONE_BLOCKS = 256;
        const MAX_RETAINED_DONE_TOOLS = 256;
        const evictableBlocks: Array<string> = [];
        for (const [key, block] of ctx.blocks) {
          if (block.sessionId === ctx.rootSessionId && block.done && block.turnId !== turn.turnId) {
            evictableBlocks.push(key);
          }
        }
        const blocksToDrop = evictableBlocks.length - MAX_RETAINED_DONE_BLOCKS;
        for (let index = 0; index < blocksToDrop; index += 1) {
          ctx.blocks.delete(evictableBlocks[index]!);
        }
        const activeShellCallIds = new Set(
          [...ctx.backgroundShells.values()].map((shell) => shell.callId),
        );
        const evictableTools: Array<string> = [];
        for (const [callId, tool] of ctx.tools) {
          if (tool.sessionId === ctx.rootSessionId && tool.done) {
            ctx.approvalPreviews.delete(callId);
            if (
              tool.turnId !== turn.turnId &&
              tool.identity.kind !== "subagent" &&
              !activeShellCallIds.has(callId)
            ) {
              evictableTools.push(callId);
            }
          }
        }
        const toolsToDrop = evictableTools.length - MAX_RETAINED_DONE_TOOLS;
        if (toolsToDrop > 0) {
          const prunedCallIds = new Set<string>();
          for (let index = 0; index < toolsToDrop; index += 1) {
            const callId = evictableTools[index]!;
            ctx.tools.delete(callId);
            prunedCallIds.add(callId);
          }
          for (const [shellId, callId] of ctx.shellCalls) {
            if (prunedCallIds.has(callId) && !ctx.backgroundShells.has(shellId)) {
              ctx.shellCalls.delete(shellId);
            }
          }
        }
        // Perform any async lookups (plan file read, usage limit lookup) while
        // `ctx.activeTurn` still holds `turn`, so a concurrent `sendTurn` waits
        // on `turn.done` and can never start a new turn before terminal events
        // and `runtime.error` are emitted in order.
        const stopped =
          turn.stopRequested || (terminal.kind === "interrupted" && terminal.reason === "user");
        const failureCategory =
          terminal.kind === "failed" ? openCodeFailureCategory(terminal.type) : undefined;
        const failedErrorMessage =
          terminal.kind === "failed"
            ? failureMessage(terminal)
            : terminal.kind === "interrupted" && !stopped && terminal.reason !== "superseded"
              ? terminal.reason === "inactivity"
                ? "OpenCode stopped the run after an hour without activity."
                : "OpenCode stopped the run before it finished."
              : undefined;

        let planMarkdown = "";
        if (turn.plan && terminal.kind === "succeeded") {
          const resolvedPlan = turn.planFilePath
            ? resolveProjectPlanFilePath(ctx.directory, turn.planFilePath)
            : undefined;
          let planFromFile = "";
          if (resolvedPlan) {
            if (typeof ctx.client.file?.read === "function") {
              planFromFile = yield* runOpenCode(
                "file.read",
                (signal) =>
                  ctx.client.file.read(
                    { location: { directory: ctx.directory }, path: resolvedPlan.relative },
                    { signal },
                  ),
                { timeoutMs: COMMAND_OUTPUT_TIMEOUT_MS },
              ).pipe(
                Effect.map((bytes) => new TextDecoder().decode(bytes).trim()),
                Effect.orElseSucceed(() => ""),
              );
            }
            if (!planFromFile && !ctx.external) {
              planFromFile = yield* fileSystem.readFileString(resolvedPlan.absolute).pipe(
                Effect.map((content) => content.trim()),
                Effect.orElseSucceed(() => ""),
              );
            }
          }
          planMarkdown = planFromFile || turn.finalText.trim();
        }
        const usageLimit =
          failureCategory === "rate_limit" && options.readUsageLimit
            ? yield* options.readUsageLimit.pipe(Effect.orElseSucceed(() => undefined))
            : undefined;

        if (ctx.stopped || ctx.activeTurn !== turn) return;
        ctx.activeTurn = undefined;
        ctx.turns.push({ id: turn.turnId, promptId: turn.promptId });
        const { activeTurnId: _active, ...session } = ctx.session;
        ctx.session = { ...session, status: "ready", updatedAt: yield* nowIso };
        if (planMarkdown.length > 0) {
          yield* emit({
            type: "turn.proposed.completed",
            ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
            payload: { planMarkdown },
          });
        }
        yield* emit({
          type: "turn.completed",
          ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
          payload:
            terminal.kind === "succeeded"
              ? { state: "completed" }
              : terminal.kind === "failed"
                ? {
                    state: "failed",
                    errorMessage: failedErrorMessage!,
                    ...withFailureCategory(failureCategory),
                    ...(usageLimit ? { usageLimit } : {}),
                  }
                : stopped || terminal.reason === "superseded"
                  ? { state: "interrupted", stopReason: terminal.reason ?? "user" }
                  : {
                      state: "failed",
                      stopReason: terminal.reason ?? null,
                      errorMessage: failedErrorMessage!,
                    },
        });
        if (failedErrorMessage !== undefined) {
          yield* emit({
            type: "runtime.error",
            ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
            payload: {
              message: failedErrorMessage,
              class: failureCategory === "auth" ? "authentication_error" : "provider_error",
              ...withFailureCategory(failureCategory),
            },
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });

    const beginTurn = (
      ctx: SessionContext,
      input: {
        readonly turnId: TurnId;
        readonly origin: ActiveTurn["origin"];
        readonly promptId?: string;
        readonly plan?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        if (input.origin === "user") ctx.quietUntilTurn = false;
        const turn: ActiveTurn = {
          turnId: input.turnId,
          origin: input.origin,
          plan: input.plan ?? false,
          promptId: input.promptId,
          undelivered: new Set(input.promptId ? [input.promptId] : []),
          startedAt: Date.now(),
          finalText: "",
          planFilePath: undefined,
          executionStarted: false,
          stopRequested: false,
          heldEnd: undefined,
          holdToken: 0,
          heldEndFiber: undefined,
          stopCheckFiber: undefined,
          done: yield* Deferred.make<void>(),
        };
        ctx.activeTurn = turn;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turn.turnId,
          updatedAt: yield* nowIso,
        };
        yield* emit({
          type: "turn.started",
          ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
          payload: ctx.model ? { model: openCodeModelSlug(ctx.model) } : {},
        });
        return turn;
      });

    /**
     * Steered input OpenCode has not delivered yet makes it start another
     * execution; the turn stays open for it. If none comes, the turn ends
     * with the execution that did. Settlement runs on `ctx.eventQueue` so it
     * never races with live SSE handlers.
     */
    const holdTurnEnd = (ctx: SessionContext, turn: ActiveTurn, terminal: Terminal) =>
      Effect.gen(function* () {
        if (turn.heldEndFiber) {
          const previous = turn.heldEndFiber;
          turn.heldEndFiber = undefined;
          yield* Fiber.interrupt(previous);
        }
        turn.heldEnd = terminal;
        turn.holdToken += 1;
        const holdToken = turn.holdToken;
        turn.heldEndFiber = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < HELD_END_MAX_CHECKS; attempt += 1) {
            yield* Effect.sleep(HELD_END_GRACE);
            if (
              ctx.stopped ||
              ctx.activeTurn !== turn ||
              turn.holdToken !== holdToken ||
              !turn.heldEnd
            ) {
              return;
            }
            const inbox = yield* runOpenCode("session.inbox.list", (signal) =>
              ctx.client.session.inbox.list({ sessionID: ctx.rootSessionId }, { signal }),
            ).pipe(Effect.option);
            if (
              ctx.stopped ||
              ctx.activeTurn !== turn ||
              turn.holdToken !== holdToken ||
              !turn.heldEnd
            ) {
              return;
            }
            // A failed inbox check proves nothing: keep the turn held and retry
            // so a queued steer is not split into a separate turn.
            if (Option.isNone(inbox)) continue;
            const stillQueued = inbox.value.some((item) => turn.undelivered.has(item.id));
            if (!stillQueued) {
              yield* Queue.offer(ctx.eventQueue, {
                _tag: "FinishHeldTurn",
                turn,
                holdToken,
                terminal,
              });
              return;
            }
          }
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const handleExecutionStarted = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        if (turn) {
          turn.executionStarted = true;
          if (turn.heldEnd) {
            turn.heldEnd = undefined;
            turn.holdToken += 1;
            const heldFiber = turn.heldEndFiber;
            turn.heldEndFiber = undefined;
            if (heldFiber) yield* Fiber.interrupt(heldFiber);
          }
          return;
        }
        if (ctx.silenceNextWake || ctx.quietUntilTurn || ctx.withdrawnReports.size > 0) {
          ctx.silenceNextWake = false;
          ctx.silencedExecution = true;
          yield* runOpenCode("session.interrupt", (signal) =>
            ctx.client.session.interrupt({ sessionID: ctx.rootSessionId }, { signal }),
          ).pipe(Effect.ignore, Effect.forkIn(ctx.scope, { startImmediately: true }));
          return;
        }
        // OpenCode woke the agent up by itself: a background subagent or
        // shell reported back. It is the agent's turn, as Claude's are.
        const wake = yield* beginTurn(ctx, {
          turnId: TurnId.make(`wake_${(yield* randomUUIDv4).replaceAll("-", "")}`),
          origin: "provider",
        });
        wake.executionStarted = true;
      });

    const handleExecutionEnded = (ctx: SessionContext, terminal: Terminal) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        if (!turn) {
          ctx.silencedExecution = false;
          return;
        }
        if (!turn.stopRequested && terminal.kind !== "interrupted" && turn.undelivered.size > 0) {
          yield* holdTurnEnd(ctx, turn, terminal);
          return;
        }
        yield* finishTurn(ctx, turn, terminal);
      });

    // ── Subagents ────────────────────────────────────────────────────────

    const emitSubagentMetadata = (
      ctx: SessionContext,
      child: ChildAgent,
      payload: Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        yield* emit({
          type: "subagent.metadata.updated",
          ...(yield* eventBase(ctx, child.sessionId, child.turnId)),
          payload: {
            agentThreadId: child.sessionId,
            transcriptAgentId: child.sessionId,
            ...(child.parentSessionId !== ctx.rootSessionId
              ? { parentAgentThreadId: child.parentSessionId }
              : {}),
            ...payload,
          },
        } as ProviderRuntimeEvent);
      });

    const childSpawned = (ctx: SessionContext, event: OpenCodeEventOf<"session.created">) =>
      Effect.gen(function* () {
        const sessionId = event.data.sessionID;
        if (ctx.children.has(sessionId)) return;
        const child: ChildAgent = {
          sessionId,
          parentSessionId: event.data.parentID!,
          turnId: ctx.activeTurn?.turnId,
          agent: event.data.agent,
          title: event.data.title,
          callId: undefined,
          background: false,
          status: "running",
          lastText: "",
        };
        ctx.children.set(sessionId, child);
        owners.set(sessionId, ctx);
        // OpenCode creates a subagent's session without its parent's rules,
        // so it would neither ask for approval nor be kept to this thread's
        // tools. Its own agent's rules are layered the same way as the root's.
        // OpenCode starts the child at once, so this races its first step;
        // the model's first reply almost always loses. A child the rules
        // could not reach is stopped rather than left unsupervised.
        const rulesReady = yield* Deferred.make<void>();
        ctx.childRulesReady.set(sessionId, rulesReady);
        yield* rulesFor(ctx, event.data.agent ?? BUILD_AGENT).pipe(
          Effect.flatMap((rules) =>
            ctx.stopped ? Effect.void : applyRules(ctx, sessionId, rules),
          ),
          Effect.catch((error) =>
            ctx.stopped
              ? Effect.void
              : Effect.logWarning("Could not apply rules to an OpenCode subagent; stopping it", {
                  error,
                }).pipe(
                  Effect.andThen(
                    runOpenCode("session.interrupt", (signal) =>
                      ctx.client.session.interrupt({ sessionID: sessionId }, { signal }),
                    ).pipe(Effect.ignore),
                  ),
                ),
          ),
          Effect.ensuring(Deferred.succeed(rulesReady, undefined)),
          Effect.forkIn(ctx.scope, { startImmediately: true }),
        );
        yield* emitSubagentMetadata(ctx, child, {
          status: "running",
          ...(event.data.title ? { taskName: event.data.title } : {}),
          ...(event.data.agent ? { agentRole: event.data.agent } : {}),
          ...(event.data.model
            ? { model: openCodeModelSlug(event.data.model), modelSource: "provider" }
            : {}),
        });
      });

    /** The parent's `subagent` call names the child once it has one. */
    const linkChild = (ctx: SessionContext, tool: ToolCall, childSessionId: string) =>
      Effect.gen(function* () {
        const child = ctx.children.get(childSessionId);
        if (!child || child.callId === tool.callId) return;
        const input = isRecord(tool.input) ? tool.input : {};
        // A `subagent` call may continue an existing child: it now works for
        // this call's turn, and the user has not stopped it.
        child.callId = tool.callId;
        child.turnId = tool.turnId;
        child.background = input.background === true;
        child.status = "running";
        ctx.stoppedChildren.delete(child.sessionId);
        yield* emitSubagentMetadata(ctx, child, {
          callId: tool.callId,
          status: child.status,
          isBackgrounded: child.background,
          ...(typeof input.description === "string" ? { taskName: input.description } : {}),
          ...(typeof input.prompt === "string" ? { objective: input.prompt } : {}),
          ...(typeof input.model === "string"
            ? { model: input.model, modelSource: "explicit" }
            : {}),
        });
        yield* toolUpdated(ctx, tool);
        if (child.background) {
          yield* emit({
            type: "task.started",
            ...(yield* eventBase(ctx, ctx.rootSessionId, child.turnId)),
            payload: {
              taskId: RuntimeTaskId.make(child.sessionId),
              taskType: "local_agent",
              toolUseId: tool.callId,
              isBackgrounded: true,
              pendingCountManagedBySnapshot: true,
              ...(child.agent ? { subagentType: child.agent } : {}),
              ...(typeof input.description === "string" ? { description: input.description } : {}),
              stoppable: true,
            },
          } as ProviderRuntimeEvent);
          yield* publishBackgroundTasks(ctx);
        }
      });

    // One end per run, claimed before anything waits: the child's own end, a
    // resync and a Stop can each report it, and the first one is the end.
    // Every report still clears what the child left open, since a request
    // can arrive after a Stop already ended the run.
    const childEnded = (ctx: SessionContext, child: ChildAgent, terminal: Terminal) =>
      Effect.gen(function* () {
        const status: ChildAgent["status"] =
          terminal.kind === "succeeded"
            ? "completed"
            : terminal.kind === "failed"
              ? "failed"
              : "interrupted";
        const ending = child.status === "running";
        if (ending) child.status = status;
        yield* closeBlocks(ctx, child.sessionId);
        yield* closeTools(ctx, child.sessionId, terminal.kind !== "succeeded");
        yield* dropPendingRequests(ctx, child.sessionId);
        if (!ending) return;
        yield* emitSubagentMetadata(ctx, child, {
          status,
          ...(child.lastText ? { resultBody: child.lastText } : {}),
        });
        if (child.background && child.callId) {
          yield* emit({
            type: "task.completed",
            ...(yield* eventBase(ctx, ctx.rootSessionId, child.turnId)),
            payload: {
              taskId: RuntimeTaskId.make(child.sessionId),
              taskType: "local_agent",
              toolUseId: child.callId,
              pendingCountManagedBySnapshot: true,
              status:
                status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
            },
          } as ProviderRuntimeEvent);
          yield* publishBackgroundTasks(ctx);
        }
      });

    const emitTokenUsage = (ctx: SessionContext, tokens: OpenCodeTokens) =>
      Effect.gen(function* () {
        const used = usedContextTokens(tokens);
        if (used <= 0) return;
        yield* emit({
          type: "thread.token-usage.updated",
          ...(yield* eventBase(ctx, ctx.rootSessionId, ctx.activeTurn?.turnId)),
          payload: {
            usage: {
              usedTokens: used,
              lastUsedTokens: used,
              lastInputTokens: Math.round(tokens.input),
              lastCachedInputTokens: Math.round(tokens.cache?.read ?? 0),
              lastOutputTokens: Math.round(tokens.output),
              ...(tokens.reasoning
                ? { lastReasoningOutputTokens: Math.round(tokens.reasoning) }
                : {}),
              ...(ctx.contextLimit && ctx.contextLimit > 0 ? { maxTokens: ctx.contextLimit } : {}),
              compactsAutomatically: true,
            },
          },
        });
      });

    // ── Event routing ────────────────────────────────────────────────────

    const handleEvent = (ctx: SessionContext, event: OpenCodeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sessionId = openCodeEventSessionId(event);
        const isRoot = sessionId === ctx.rootSessionId;
        yield* logNative(ctx, event);
        // Output of a run we are discarding never reaches the thread.
        if (
          isRoot &&
          ctx.silencedExecution &&
          !ctx.activeTurn &&
          !event.type.startsWith("session.execution.") &&
          !event.type.startsWith("session.inbox.")
        ) {
          return;
        }
        switch (event.type) {
          case "session.created":
            return;
          case "session.deleted":
            if (isRoot) {
              // Run outside `ctx.scope` so closing `ctx.scope` does not
              // interrupt the fiber before `runtime.error` and `session.exited`.
              yield* stopContext(ctx, "OpenCode deleted the session.").pipe(
                Effect.forkIn(adapterScope, { startImmediately: true }),
              );
            }
            return;
          case "session.inbox.delivered":
          case "session.inbox.cancelled": {
            ctx.withdrawnReports.delete(event.data.inboxID);
            const turn = ctx.activeTurn;
            if (!isRoot || !turn) return;
            turn.undelivered.delete(event.data.inboxID);
            if (
              turn.heldEnd &&
              turn.undelivered.size === 0 &&
              event.type === "session.inbox.cancelled"
            ) {
              yield* finishTurn(ctx, turn, turn.heldEnd);
            }
            return;
          }
          case "session.inbox.enqueued": {
            // A stopped subagent still reports back, and the report would
            // wake the agent the user just stopped. Withdraw it.
            const payload = isRecord(event.data.item.payload) ? event.data.item.payload : {};
            const metadata = isRecord(payload.metadata) ? payload.metadata : {};
            const childId = typeof metadata.childID === "string" ? metadata.childID : undefined;
            if (isRoot && childId && ctx.stoppedChildren.has(childId)) {
              ctx.withdrawnReports.add(event.data.inboxID);
              yield* runOpenCode("session.inbox.cancel", (signal) =>
                ctx.client.session.inbox.cancel(
                  { sessionID: ctx.rootSessionId, inboxID: event.data.inboxID },
                  { signal },
                ),
              ).pipe(Effect.ignore, Effect.forkIn(ctx.scope, { startImmediately: true }));
            }
            return;
          }
          case "session.execution.started":
            if (isRoot) {
              yield* handleExecutionStarted(ctx);
            } else {
              const child = ctx.children.get(event.data.sessionID);
              if (child && child.status !== "running") {
                child.status = "running";
                yield* emitSubagentMetadata(ctx, child, { status: "running" });
              }
            }
            return;
          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted": {
            const terminal = terminalFromEvent(event)!;
            if (isRoot) {
              yield* handleExecutionEnded(ctx, terminal);
            } else {
              const child = ctx.children.get(event.data.sessionID);
              if (child) yield* childEnded(ctx, child, terminal);
            }
            return;
          }
          case "session.step.started":
            if (isRoot && event.data.model) {
              const model = event.data.model;
              if (
                !ctx.model ||
                ctx.model.id !== model.id ||
                ctx.model.providerID !== model.providerID
              ) {
                const nextModel: OpenCodeModelRef = {
                  providerID: model.providerID,
                  id: model.id,
                  ...(model.variant ? { variant: model.variant } : {}),
                };
                ctx.model = nextModel;
                const cached = cachedContextLimit(ctx.directory, ctx.generation, nextModel);
                if (cached.hit) {
                  ctx.contextLimit = cached.value;
                } else {
                  yield* contextLimitFor(ctx, nextModel).pipe(
                    Effect.tap((limit) =>
                      Effect.sync(() => {
                        if (
                          !ctx.stopped &&
                          ctx.model?.providerID === nextModel.providerID &&
                          ctx.model?.id === nextModel.id
                        ) {
                          ctx.contextLimit = limit;
                        }
                      }),
                    ),
                    Effect.ignore,
                    Effect.forkIn(ctx.scope, { startImmediately: true }),
                  );
                }
              }
            }
            return;
          case "session.step.ended":
          case "session.step.failed": {
            const tokens = event.data.tokens;
            if (!isRoot || !tokens) return;
            yield* emitTokenUsage(ctx, tokens);
            return;
          }
          case "session.text.started":
          case "session.reasoning.started":
            yield* startBlock(
              ctx,
              event.data.sessionID,
              event.type === "session.text.started" ? "text" : "reasoning",
              event.data.assistantMessageID,
              event.data.ordinal,
            );
            return;
          case "session.text.delta":
          case "session.reasoning.delta": {
            const block = yield* startBlock(
              ctx,
              event.data.sessionID,
              event.type === "session.text.delta" ? "text" : "reasoning",
              event.data.assistantMessageID,
              event.data.ordinal,
            );
            yield* appendBlock(ctx, block, event.data.delta);
            return;
          }
          case "session.text.ended":
          case "session.reasoning.ended": {
            const block = yield* startBlock(
              ctx,
              event.data.sessionID,
              event.type === "session.text.ended" ? "text" : "reasoning",
              event.data.assistantMessageID,
              event.data.ordinal,
            );
            yield* completeBlock(ctx, block, event.data.text);
            return;
          }
          case "session.tool.input.started":
            yield* toolStarted(ctx, event.data.sessionID, event.data.id, event.data.name);
            return;
          case "session.tool.called": {
            const tool = ctx.tools.get(event.data.id);
            if (!tool) return;
            tool.input = event.data.input;
            yield* toolUpdated(ctx, tool);
            return;
          }
          case "session.tool.progress": {
            const tool = ctx.tools.get(event.data.id);
            if (!tool) return;
            const metadata = isRecord(event.data.metadata) ? event.data.metadata : {};
            if (tool.identity.kind === "subagent" && typeof metadata.sessionID === "string") {
              yield* linkChild(ctx, tool, metadata.sessionID);
            }
            if (tool.identity.kind === "shell" && typeof metadata.shellID === "string") {
              ctx.shellCalls.set(metadata.shellID, tool.callId);
            }
            return;
          }
          case "session.tool.success": {
            const tool = ctx.tools.get(event.data.id);
            if (!tool) return;
            const metadata = isRecord(event.data.metadata) ? event.data.metadata : {};
            // A shell moved to the background reports success right away and
            // keeps running; it is a background task until its shell exits.
            if (tool.identity.kind === "shell" && metadata.status === "running") {
              const shellId =
                typeof metadata.shellID === "string"
                  ? metadata.shellID
                  : [...ctx.shellCalls].find(([, callId]) => callId === tool.callId)?.[0];
              if (shellId) {
                const description = openCodeToolDetail(tool.identity, tool.input);
                ctx.shellCalls.set(shellId, tool.callId);
                ctx.backgroundShells.set(shellId, {
                  callId: tool.callId,
                  sessionId: tool.sessionId,
                  ...(description ? { description } : {}),
                });
                yield* emit({
                  type: "task.started",
                  ...(yield* eventBase(ctx, ctx.rootSessionId, tool.turnId)),
                  payload: {
                    taskId: RuntimeTaskId.make(shellId),
                    taskType: "local_bash",
                    toolUseId: tool.callId,
                    isBackgrounded: true,
                    pendingCountManagedBySnapshot: true,
                    stoppable: true,
                    ...(description ? { description } : {}),
                  },
                } as ProviderRuntimeEvent);
                yield* publishBackgroundTasks(ctx);
              }
            }
            const preview = ctx.approvalPreviews.get(tool.callId);
            ctx.approvalPreviews.delete(tool.callId);
            yield* toolFinished(ctx, tool, {
              failed: false,
              ...(event.data.content ? { content: event.data.content } : {}),
              metadata:
                tool.identity.kind === "edit" &&
                !(isRecord(event.data.metadata) && Array.isArray(event.data.metadata.files)) &&
                preview !== undefined
                  ? preview
                  : event.data.metadata,
            });
            return;
          }
          case "session.tool.failed": {
            const tool = ctx.tools.get(event.data.id);
            if (!tool) return;
            ctx.approvalPreviews.delete(tool.callId);
            const type = event.data.error?.type;
            yield* toolFinished(ctx, tool, {
              failed: true,
              declined: type === "permission.rejected",
              ...(event.data.content ? { content: event.data.content } : {}),
              metadata: event.data.metadata,
              ...(event.data.error?.message ? { error: event.data.error.message } : {}),
            });
            return;
          }
          case "session.retry.scheduled": {
            if (!ctx.activeTurn) return;
            const attempt = event.data.attempt;
            const reason = event.data.error?.message?.trim();
            yield* emit({
              type: "runtime.warning",
              ...(yield* eventBase(ctx, ctx.rootSessionId, ctx.activeTurn.turnId)),
              payload: {
                message: `OpenCode is retrying the model request${attempt ? ` (attempt ${attempt})` : ""}${reason ? `: ${reason}` : "."}`,
                warningKind: "api-retry",
              },
            } as ProviderRuntimeEvent);
            return;
          }
          case "session.compaction.started": {
            if (!isRoot) return;
            ctx.compactionCount += 1;
            yield* emit({
              type: "item.started",
              ...(yield* eventBase(ctx, ctx.rootSessionId, ctx.activeTurn?.turnId)),
              itemId: RuntimeItemId.make(`compaction:${ctx.rootSessionId}:${ctx.compactionCount}`),
              payload: {
                itemType: "context_compaction" satisfies CanonicalItemType,
                status: "inProgress",
                data: { trigger: event.data.reason ?? "auto" },
              },
            });
            return;
          }
          case "session.compaction.ended":
          case "session.compaction.failed": {
            if (!isRoot) return;
            const failed = event.type === "session.compaction.failed";
            yield* emit({
              type: "item.completed",
              ...(yield* eventBase(ctx, ctx.rootSessionId, ctx.activeTurn?.turnId)),
              itemId: RuntimeItemId.make(`compaction:${ctx.rootSessionId}:${ctx.compactionCount}`),
              payload: {
                itemType: "context_compaction",
                status: failed ? "failed" : "completed",
                ...(failed ? { title: "Context compaction failed" } : {}),
                data: { trigger: event.data.reason ?? "auto" },
              },
            });
            if (!failed) {
              if (event.data.tokens) {
                yield* emitTokenUsage(ctx, event.data.tokens);
              }
              yield* emit({
                type: "thread.state.changed",
                ...(yield* eventBase(ctx, ctx.rootSessionId, ctx.activeTurn?.turnId)),
                payload: { state: "compacted" },
              } as ProviderRuntimeEvent);
            }
            return;
          }
          case "permission.asked":
            yield* openApproval(ctx, event.data);
            return;
          case "permission.replied": {
            ctx.inFlightAutoApprovals.delete(event.data.requestID);
            const requestId = ctx.approvalIds.get(event.data.requestID);
            if (requestId) {
              yield* resolveApproval(
                ctx,
                requestId,
                event.data.reply === "reject" ? "decline" : "accept",
              );
            }
            return;
          }
          case "form.created":
            yield* openQuestion(ctx, event.data.form);
            return;
          case "form.replied":
          case "form.cancelled": {
            ctx.inFlightFormCancels.delete(event.data.id);
            const requestId = ctx.questionIds.get(event.data.id);
            if (requestId) yield* resolveQuestion(ctx, requestId, {});
            return;
          }
          case "shell.created":
          case "shell.exited":
          case "session.usage.updated":
          case "session.revert.staged":
          case "session.revert.committed":
          case "session.revert.cleared":
          case "server.connected":
          case "agent.updated":
          case "command.updated":
          case "config.updated":
          case "credential.updated":
          case "credential.switched":
          case "mcp.status.changed":
          case "model.updated":
          case "provider.updated":
          case "skill.updated":
            return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("OpenCode event handling failed", { type: event.type, cause }),
        ),
      );

    const handleShellExitedForContext = (
      ctx: SessionContext,
      event: OpenCodeEventOf<"shell.exited">,
    ) =>
      Effect.gen(function* () {
        const shell = ctx.backgroundShells.get(event.data.id);
        if (!shell) return;
        ctx.backgroundShells.delete(event.data.id);
        ctx.releasedBackgroundShells.delete(event.data.id);
        ctx.shellCalls.delete(event.data.id);
        yield* emit({
          type: "task.completed",
          ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
          payload: {
            taskId: RuntimeTaskId.make(event.data.id),
            taskType: "local_bash",
            toolUseId: shell.callId,
            pendingCountManagedBySnapshot: true,
            status:
              event.data.exit === 0 || event.data.exit === undefined || event.data.exit === null
                ? "completed"
                : "failed",
          },
        } as ProviderRuntimeEvent);
        yield* publishBackgroundTasks(ctx);
      });

    /** A session's messages created at or after `since` (epoch ms), oldest first, every page. */
    const listMessagesSince = (client: OpenCodeClient, sessionId: string, since: number) =>
      Effect.gen(function* () {
        const newestFirst: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page += 1) {
          const result = yield* runOpenCode("message.list", (signal) =>
            client.message.list(
              cursor
                ? { sessionID: sessionId, limit: 100, cursor }
                : { sessionID: sessionId, limit: 100, order: "desc" },
              { signal },
            ),
          );
          const messages = (result.data as ReadonlyArray<unknown>).filter(isRecord);
          let reachedOlder = false;
          for (const message of messages) {
            if (isRecord(message.time) && Number(message.time.created) < since) {
              reachedOlder = true;
              break;
            }
            newestFirst.push(message);
          }
          const next = result.cursor?.next;
          if (reachedOlder || !next || messages.length === 0) break;
          cursor = next;
        }
        return newestFirst.toReversed();
      });

    /**
     * Replays one session's history since `since` into blocks and tool items.
     * A message still being written keeps its blocks open: its remaining
     * deltas, and its end, are still on their way.
     */
    const backfillHistory = (ctx: SessionContext, sessionId: string, since: number) =>
      Effect.gen(function* () {
        const messages = yield* listMessagesSince(ctx.client, sessionId, since);
        for (const message of messages) {
          if (message.type !== "assistant" || typeof message.id !== "string") continue;
          const finished = isRecord(message.time) && typeof message.time.completed === "number";
          const ordinals = { text: 0, reasoning: 0 };
          for (const part of Array.isArray(message.content)
            ? message.content.filter(isRecord)
            : []) {
            if (
              (part.type === "text" || part.type === "reasoning") &&
              typeof part.text === "string"
            ) {
              const kind = part.type;
              const block = yield* startBlock(ctx, sessionId, kind, message.id, ordinals[kind]++);
              if (finished) {
                yield* completeBlock(ctx, block, part.text);
              } else if (part.text.startsWith(block.text)) {
                yield* appendBlock(ctx, block, part.text.slice(block.text.length));
              }
              continue;
            }
            if (
              part.type !== "tool" ||
              typeof part.id !== "string" ||
              typeof part.name !== "string"
            )
              continue;
            const state = isRecord(part.state) ? part.state : {};
            const tool = yield* toolStarted(ctx, sessionId, part.id, part.name);
            const hadInput = tool.input !== undefined;
            if (
              !tool.done &&
              !hadInput &&
              state.input !== undefined &&
              typeof state.input !== "string"
            ) {
              tool.input = state.input;
            }
            if (
              tool.identity.kind === "subagent" &&
              isRecord(state.metadata) &&
              typeof state.metadata.sessionID === "string"
            ) {
              yield* linkChild(ctx, tool, state.metadata.sessionID);
            }
            if (state.status === "completed" || state.status === "error") {
              if (
                state.status === "completed" &&
                tool.identity.kind === "shell" &&
                isRecord(state.metadata) &&
                state.metadata.status === "running" &&
                typeof state.metadata.shellID === "string"
              ) {
                const shellId = state.metadata.shellID;
                ctx.shellCalls.set(shellId, tool.callId);
                if (!ctx.backgroundShells.has(shellId)) {
                  const description = openCodeToolDetail(tool.identity, tool.input);
                  ctx.backgroundShells.set(shellId, {
                    callId: tool.callId,
                    sessionId: tool.sessionId,
                    ...(description ? { description } : {}),
                  });
                  yield* emit({
                    type: "task.started",
                    ...(yield* eventBase(ctx, ctx.rootSessionId, tool.turnId)),
                    payload: {
                      taskId: RuntimeTaskId.make(shellId),
                      taskType: "local_bash",
                      toolUseId: tool.callId,
                      isBackgrounded: true,
                      pendingCountManagedBySnapshot: true,
                      stoppable: true,
                      ...(description ? { description } : {}),
                    },
                  } as ProviderRuntimeEvent);
                  yield* publishBackgroundTasks(ctx);
                }
              }
              const errorType =
                isRecord(state.error) && typeof state.error.type === "string"
                  ? state.error.type
                  : undefined;
              yield* toolFinished(ctx, tool, {
                failed: state.status === "error",
                declined: errorType === "permission.rejected",
                ...(Array.isArray(state.content) ? { content: state.content } : {}),
                metadata: state.metadata,
                ...(isRecord(state.error) && typeof state.error.message === "string"
                  ? { error: state.error.message }
                  : {}),
              });
            } else if (!tool.done && !hadInput && tool.input !== undefined) {
              yield* toolUpdated(ctx, tool);
            }
          }
        }
        return messages;
      });

    /** How a session's last run ended, from its newest idle marker. */
    const lastOutcome = (client: OpenCodeClient, sessionId: string) =>
      runOpenCode("message.list", (signal) =>
        client.message.list({ sessionID: sessionId, limit: 20, order: "desc" }, { signal }),
      ).pipe(
        Effect.map((result) => {
          const idle = (result.data as ReadonlyArray<unknown>).find(
            (message): message is { readonly type: "idle"; readonly outcome: string } =>
              isRecord(message) && message.type === "idle",
          );
          return idle?.outcome;
        }),
        Effect.orElseSucceed(() => undefined),
      );

    /**
     * After a reconnect: whatever happened while the stream was down has to
     * be read back, or a turn runs forever, output goes missing and an
     * approval is never shown. Nothing here ends a turn on a guess: if the
     * server's view cannot be read, the turn stays open.
     */
    const MAX_RESYNC_DISCOVERED_CHILDREN = 100;
    const MAX_PENDING_UNMATCHED_EVENTS = 512;
    const resyncsInFlightByGeneration = new Map<number, number>();
    const pendingUnmatchedByGeneration = new Map<number, Array<OpenCodeEvent>>();

    const dispatchRoutedEvent = (
      generation: number,
      event: OpenCodeEvent,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (event.type === "session.created" && event.data.parentID) {
          const parent = owners.get(event.data.parentID);
          if (parent && parent.generation === generation && !parent.stopped) {
            // Claim ownership eagerly so child or grandchild frames arriving
            // immediately behind `session.created` enqueue in strict order.
            if (!owners.has(event.data.sessionID)) {
              owners.set(event.data.sessionID, parent);
            }
            yield* Queue.offer(parent.eventQueue, { _tag: "ChildSpawned", event });
            return true;
          }
          return false;
        }
        const sessionId = openCodeEventSessionId(event);
        const ctx = sessionId ? owners.get(sessionId) : undefined;
        if (ctx && ctx.generation === generation && !ctx.stopped) {
          yield* Queue.offer(ctx.eventQueue, { _tag: "Event", event });
          return true;
        }
        return false;
      });

    const completeGenerationResync = (generation: number, count = 1) =>
      Effect.gen(function* () {
        if (count <= 0) return;
        const remaining = (resyncsInFlightByGeneration.get(generation) ?? 0) - count;
        if (remaining <= 0) {
          resyncsInFlightByGeneration.delete(generation);
        } else {
          resyncsInFlightByGeneration.set(generation, remaining);
        }
        const buffered = pendingUnmatchedByGeneration.get(generation);
        if (!buffered || buffered.length === 0) {
          if (remaining <= 0) pendingUnmatchedByGeneration.delete(generation);
          return;
        }
        const stillUnmatched: Array<OpenCodeEvent> = [];
        for (const event of buffered) {
          const routed = yield* dispatchRoutedEvent(generation, event);
          if (!routed && remaining > 0) {
            stillUnmatched.push(event);
          }
        }
        if (remaining <= 0 || stillUnmatched.length === 0) {
          pendingUnmatchedByGeneration.delete(generation);
        } else {
          pendingUnmatchedByGeneration.set(generation, stillUnmatched);
        }
      });

    const resync = (
      ctx: SessionContext,
      activeSessions: Effect.Effect<Option.Option<Record<string, unknown>>>,
      snapshotTurn: ActiveTurn | undefined,
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.serverGone) return;
        // Use the turn that was active when `StreamOpened` fired (before
        // `session.active` ran) so a new turn started after the snapshot is
        // never judged idle and failed against stale snapshot state.
        const turn = snapshotTurn;
        const active = yield* activeSessions;
        if (ctx.stopped || ctx.serverGone || Option.isNone(active)) return;
        const running = active.value;

        const hasActiveChild = Array.from(ctx.children.values()).some(
          (child) => child.status === "running" || child.sessionId in running,
        );
        // Idle sessions with no active turn, running execution, running child,
        // running background shell, or open ask cannot have missed anything
        // while the stream was down.
        if (
          !turn &&
          !(ctx.rootSessionId in running) &&
          !hasActiveChild &&
          ctx.backgroundShells.size === 0 &&
          ctx.approvals.size === 0 &&
          ctx.questions.size === 0
        ) {
          return;
        }

        // Subagents (including nested grandchildren) spawned while we were away.
        const parentsToScan: Array<string> = [
          ctx.rootSessionId,
          ...Array.from(ctx.children.values())
            .filter((child) => child.status === "running" || child.sessionId in running)
            .map((child) => child.sessionId),
        ];
        const scannedParents = new Set<string>();
        let discoveredCount = 0;
        while (parentsToScan.length > 0 && discoveredCount < MAX_RESYNC_DISCOVERED_CHILDREN) {
          if (ctx.stopped || ctx.serverGone) return;
          const parentId = parentsToScan.shift()!;
          if (scannedParents.has(parentId)) continue;
          scannedParents.add(parentId);
          const children = yield* runOpenCode("session.list", (signal) =>
            ctx.client.session.list({ parentID: parentId, limit: 100 }, { signal }),
          ).pipe(
            Effect.map((result) => result.data ?? []),
            Effect.orElseSucceed(() => []),
          );
          if (ctx.stopped || ctx.serverGone) return;
          for (const child of children) {
            if (ctx.children.has(child.id)) continue;
            discoveredCount += 1;
            yield* childSpawned(ctx, {
              type: "session.created",
              data: {
                sessionID: child.id,
                parentID: parentId,
                ...(child.title ? { title: child.title } : {}),
                ...(child.agent ? { agent: child.agent } : {}),
              },
            });
            if (discoveredCount < MAX_RESYNC_DISCOVERED_CHILDREN) {
              parentsToScan.push(child.id);
            }
          }
        }

        const since = turn?.startedAt ?? Date.now();
        // Skip historical completed children when polling pending asks/history.
        const sessionsToCheck = [
          ctx.rootSessionId,
          ...Array.from(ctx.children.values())
            .filter((child) => child.status === "running" || child.sessionId in running)
            .map((child) => child.sessionId),
        ];
        let rootBackfilledMessages: ReadonlyArray<Record<string, unknown>> | undefined;
        for (const sessionId of sessionsToCheck) {
          if (ctx.stopped || ctx.serverGone) return;
          const [backfilled, permissions, forms] = yield* Effect.all(
            [
              turn && ctx.activeTurn === turn
                ? backfillHistory(ctx, sessionId, since).pipe(Effect.option)
                : Effect.succeed(Option.none<ReadonlyArray<Record<string, unknown>>>()),
              runOpenCode("permission.list", (signal) =>
                ctx.client.permission.list({ sessionID: sessionId }, { signal }),
              ).pipe(Effect.orElseSucceed(() => [])),
              runOpenCode("form.list", (signal) =>
                ctx.client.session.form.list({ sessionID: sessionId }, { signal }),
              ).pipe(Effect.orElseSucceed(() => [])),
            ],
            { concurrency: "unbounded" },
          );
          if (ctx.stopped || ctx.serverGone) return;
          if (sessionId === ctx.rootSessionId && Option.isSome(backfilled)) {
            rootBackfilledMessages = backfilled.value;
          }
          for (const permission of permissions) {
            if (Array.isArray(permission.resources)) {
              yield* openApproval(ctx, permission as unknown as OpenCodePermissionRequest);
            }
          }
          for (const form of forms) {
            if (Array.isArray((form as { fields?: unknown }).fields)) {
              yield* openQuestion(ctx, form as unknown as OpenCodeForm);
            }
          }
        }
        const endedChildren = Array.from(ctx.children.values()).filter(
          (child) => child.status === "running" && !(child.sessionId in running),
        );
        if (endedChildren.length > 0) {
          const outcomes = yield* Effect.forEach(
            endedChildren,
            (child) => lastOutcome(ctx.client, child.sessionId),
            { concurrency: "unbounded" },
          );
          if (ctx.stopped || ctx.serverGone) return;
          for (const [index, child] of endedChildren.entries()) {
            const outcome = outcomes[index];
            yield* childEnded(
              ctx,
              child,
              outcome === "succeeded"
                ? { kind: "succeeded" }
                : outcome === "failed"
                  ? { kind: "failed", message: undefined, type: undefined }
                  : { kind: "interrupted", reason: undefined },
            );
          }
        }

        // Reconcile background shells that may have exited while the stream was down.
        const trackedShells = Array.from(ctx.backgroundShells.entries());
        if (trackedShells.length > 0) {
          const shellStatuses = yield* Effect.forEach(
            trackedShells,
            ([shellId]) =>
              runOpenCode("shell.get", (signal) =>
                ctx.client.shell.get(
                  { id: shellId, location: { directory: ctx.directory } },
                  { signal },
                ),
              ).pipe(
                Effect.map((found) =>
                  found.data?.status === "running"
                    ? ("running" as const)
                    : found.data?.exit === 0 || found.data?.exit === undefined
                      ? ("completed" as const)
                      : ("failed" as const),
                ),
                Effect.catch((error) =>
                  Effect.succeed(
                    openCodeErrorStatus(error) === 404 ||
                      openCodeErrorTag(error) === "ShellNotFoundError"
                      ? ("stopped" as const)
                      : ("unknown" as const),
                  ),
                ),
              ),
            { concurrency: "unbounded" },
          );
          if (ctx.stopped || ctx.serverGone) return;
          let shellsChanged = false;
          for (const [index, [shellId, shell]] of trackedShells.entries()) {
            const status = shellStatuses[index];
            if (status === "running" || status === "unknown") continue;
            if (!ctx.backgroundShells.delete(shellId)) continue;
            ctx.releasedBackgroundShells.delete(shellId);
            ctx.shellCalls.delete(shellId);
            shellsChanged = true;
            yield* emit({
              type: "task.completed",
              ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
              payload: {
                taskId: RuntimeTaskId.make(shellId),
                taskType: "local_bash",
                toolUseId: shell.callId,
                pendingCountManagedBySnapshot: true,
                status,
              },
            } as ProviderRuntimeEvent);
          }
          if (shellsChanged) {
            yield* publishBackgroundTasks(ctx);
          }
        }

        if (
          ctx.stopped ||
          ctx.serverGone ||
          !turn ||
          ctx.activeTurn !== turn ||
          ctx.rootSessionId in running
        ) {
          return;
        }
        // The run ended while we were not listening. Its idle marker, written
        // after the turn began, says how; none means it was lost. Reuse the
        // messages already fetched by `backfillHistory` when available.
        let recentMessages: ReadonlyArray<unknown> | undefined;
        if (rootBackfilledMessages !== undefined) {
          recentMessages = rootBackfilledMessages.toReversed();
        } else {
          const recent = yield* runOpenCode("message.list", (signal) =>
            ctx.client.message.list(
              { sessionID: ctx.rootSessionId, limit: 50, order: "desc" },
              { signal },
            ),
          ).pipe(Effect.option);
          if (Option.isNone(recent) || ctx.activeTurn !== turn || ctx.stopped || ctx.serverGone) {
            return;
          }
          recentMessages = recent.value.data as ReadonlyArray<unknown>;
        }
        const idle = recentMessages.find(
          (message): message is { readonly type: "idle"; readonly outcome: string } =>
            isRecord(message) &&
            message.type === "idle" &&
            isRecord(message.time) &&
            Number(message.time.created) >= turn.startedAt,
        );
        const terminal: Terminal =
          idle?.outcome === "succeeded"
            ? { kind: "succeeded" }
            : idle?.outcome === "failed"
              ? { kind: "failed", message: undefined, type: undefined }
              : turn.stopRequested || idle?.outcome === "interrupted"
                ? { kind: "interrupted", reason: "user" }
                : {
                    kind: "failed",
                    message: "The connection to OpenCode dropped and the end of this run was lost.",
                    type: undefined,
                  };
        // Steered input still queued starts another execution for this turn,
        // exactly as when the stream was up.
        if (!turn.stopRequested && terminal.kind !== "interrupted" && turn.undelivered.size > 0) {
          yield* holdTurnEnd(ctx, turn, terminal);
          return;
        }
        yield* finishTurn(ctx, turn, terminal);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("OpenCode resync failed", { cause })));

    const processSessionItem = (
      ctx: SessionContext,
      item: SessionSignalItem,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (ctx.stopped) return Effect.void;
        switch (item._tag) {
          case "Event":
            return handleEvent(ctx, item.event);
          case "ChildSpawned":
            return childSpawned(ctx, item.event);
          case "ShellExited":
            return handleShellExitedForContext(ctx, item.event);
          case "Resync":
            return Effect.gen(function* () {
              if (ctx.serverGone) return;
              const fiber = yield* resync(ctx, item.activeSessions, item.snapshotTurn).pipe(
                Effect.forkIn(ctx.scope, { startImmediately: true }),
              );
              ctx.activeResyncFiber = fiber;
              yield* Fiber.await(fiber).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (ctx.activeResyncFiber === fiber) ctx.activeResyncFiber = undefined;
                  }),
                ),
              );
            }).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  if (ctx.pendingResyncCount <= 0) return Effect.void;
                  ctx.pendingResyncCount -= 1;
                  return completeGenerationResync(ctx.generation, 1);
                }),
              ),
            );
          case "ShowApprovalCard": {
            const stillPending = ctx.inFlightAutoApprovals.delete(item.permission.id);
            if (!stillPending) return Effect.void;
            return showApprovalCard(ctx, item.permission);
          }
          case "FinishTurn":
            return finishTurn(ctx, item.turn, item.terminal);
          case "FinishHeldTurn": {
            if (
              ctx.activeTurn !== item.turn ||
              item.turn.holdToken !== item.holdToken ||
              !item.turn.heldEnd
            ) {
              return Effect.void;
            }
            item.turn.undelivered.clear();
            item.turn.heldEndFiber = undefined;
            return finishTurn(ctx, item.turn, item.terminal);
          }
          case "ServerGone":
            return stopContext(ctx, item.failure).pipe(
              Effect.forkIn(adapterScope, { startImmediately: true }),
              Effect.asVoid,
            );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("OpenCode session event handling failed", {
            threadId: ctx.threadId,
            tag: item._tag,
            cause,
          }),
        ),
      );

    const handleSignal = (signal: OpenCodeServerSignal) =>
      Effect.gen(function* () {
        switch (signal._tag) {
          case "StreamOpened": {
            const matching = Array.from(sessions.values()).filter(
              (ctx) => ctx.generation === signal.generation && !ctx.stopped && !ctx.serverGone,
            );
            if (matching.length === 0) return;
            // Fetch `session.active` once per reconnect and share it across all
            // matching sessions, while enqueueing `Resync` onto each thread's
            // queue immediately so it stays strictly ordered before later SSE frames.
            const activeDeferred = yield* Deferred.make<Option.Option<Record<string, unknown>>>();
            const client = matching[0]!.client;
            yield* runOpenCode("session.active", (abortSignal) =>
              client.session.active({ signal: abortSignal }),
            ).pipe(
              Effect.option,
              Effect.catchCause(() => Effect.succeed(Option.none<Record<string, unknown>>())),
              Effect.flatMap((result) => Deferred.succeed(activeDeferred, result)),
              Effect.forkIn(adapterScope, { startImmediately: true }),
            );
            const activeSessions = Deferred.await(activeDeferred);
            resyncsInFlightByGeneration.set(
              signal.generation,
              (resyncsInFlightByGeneration.get(signal.generation) ?? 0) + matching.length,
            );
            for (const ctx of matching) {
              ctx.pendingResyncCount += 1;
              yield* Queue.offer(ctx.eventQueue, {
                _tag: "Resync",
                activeSessions,
                snapshotTurn: ctx.activeTurn,
              });
            }
            return;
          }
          case "Malformed":
            return;
          case "ServerGone": {
            const failure = signal.unexpected ? signal.detail : undefined;
            resyncsInFlightByGeneration.delete(signal.generation);
            pendingUnmatchedByGeneration.delete(signal.generation);
            // Cancel any in-flight reconnect HTTP work immediately, then queue
            // `ServerGone` behind already-queued SSE frames so final deltas and
            // `session.execution.succeeded` settle cleanly before teardown.
            for (const ctx of Array.from(sessions.values())) {
              if (ctx.generation !== signal.generation || ctx.stopped) continue;
              ctx.serverGone = true;
              const activeResync = ctx.activeResyncFiber;
              if (activeResync !== undefined) {
                yield* Fiber.interrupt(activeResync);
              }
              yield* Queue.offer(ctx.eventQueue, { _tag: "ServerGone", failure });
            }
            for (const [threadId, work] of stoppedWork) {
              if (work.generation === signal.generation) {
                stoppedWork.delete(threadId);
                // Clear `ranHere` too so confirmThreadStopped falls back to
                // asking the server (an external server may keep shells running).
                ranHere.delete(threadId);
              }
            }
            for (const [dir, entry] of agentCache) {
              if (entry.generation <= signal.generation) agentCache.delete(dir);
            }
            for (const [dir, entry] of modelCache) {
              if (entry.generation <= signal.generation) modelCache.delete(dir);
            }
            for (const [dir, entry] of mcpServerCache) {
              if (entry.generation <= signal.generation) mcpServerCache.delete(dir);
            }
            for (const [dir, entry] of commandCache) {
              if (entry.generation <= signal.generation) commandCache.delete(dir);
            }
            mcpCacheVersion += 1;
            commandCacheVersion += 1;
            return;
          }
          case "Event": {
            const event = signal.event;
            const invalidateDirectoryOrAll = <V>(
              cache: Map<string, V>,
              directory: string | undefined,
            ) => {
              if (directory) cache.delete(directory);
              else cache.clear();
            };
            const notifyCatalogChanged = () =>
              options.onCatalogChanged
                ? options.onCatalogChanged.pipe(
                    Effect.ignore,
                    Effect.forkIn(adapterScope),
                    Effect.asVoid,
                  )
                : Effect.void;
            const refreshActiveSessionCommands = (directory: string | undefined) => {
              const matching = Array.from(sessions.values()).filter(
                (ctx) =>
                  ctx.generation === signal.generation &&
                  !ctx.stopped &&
                  (directory === undefined || ctx.directory === directory),
              );
              if (matching.length === 0 || !options.onSessionCommands) return Effect.void;
              return Effect.forEach(matching, (ctx) => publishSessionCommands(ctx), {
                concurrency: "unbounded",
                discard: true,
              }).pipe(Effect.forkIn(adapterScope), Effect.asVoid);
            };
            const reloadActiveMcpServers = (directory: string | undefined) => {
              const dirsToReload = new Map<string, SessionContext>();
              for (const ctx of sessions.values()) {
                if (
                  ctx.generation === signal.generation &&
                  !ctx.stopped &&
                  (directory === undefined || ctx.directory === directory) &&
                  !dirsToReload.has(ctx.directory)
                ) {
                  dirsToReload.set(ctx.directory, ctx);
                }
              }
              if (dirsToReload.size === 0) return Effect.void;
              return Effect.forEach(
                Array.from(dirsToReload.values()),
                (ctx) => loadMcpServers(ctx.client, ctx.directory, ctx.generation),
                { concurrency: "unbounded", discard: true },
              ).pipe(Effect.forkIn(adapterScope), Effect.asVoid);
            };
            switch (event.type) {
              case "agent.updated":
                invalidateDirectoryOrAll(agentCache, event.location?.directory);
                return;
              case "model.updated":
                invalidateDirectoryOrAll(modelCache, event.location?.directory);
                yield* notifyCatalogChanged();
                return;
              case "command.updated":
                commandCacheVersion += 1;
                invalidateDirectoryOrAll(commandCache, event.location?.directory);
                yield* refreshActiveSessionCommands(event.location?.directory);
                yield* notifyCatalogChanged();
                return;
              case "mcp.status.changed": {
                const directory = event.location?.directory;
                mcpCacheVersion += 1;
                invalidateDirectoryOrAll(mcpServerCache, directory);
                yield* reloadActiveMcpServers(directory);
                return;
              }
              case "provider.updated":
              case "credential.updated":
              case "credential.switched":
                invalidateDirectoryOrAll(modelCache, event.location?.directory);
                yield* notifyCatalogChanged();
                return;
              case "skill.updated":
                yield* notifyCatalogChanged();
                return;
              case "config.updated": {
                const directory = event.location?.directory;
                mcpCacheVersion += 1;
                commandCacheVersion += 1;
                invalidateDirectoryOrAll(agentCache, directory);
                invalidateDirectoryOrAll(modelCache, directory);
                invalidateDirectoryOrAll(commandCache, directory);
                invalidateDirectoryOrAll(mcpServerCache, directory);
                yield* refreshActiveSessionCommands(directory);
                yield* reloadActiveMcpServers(directory);
                yield* notifyCatalogChanged();
                return;
              }
              default:
                break;
            }
            if (event.type === "shell.exited") {
              for (const ctx of sessions.values()) {
                if (ctx.generation === signal.generation && !ctx.stopped) {
                  yield* Queue.offer(ctx.eventQueue, { _tag: "ShellExited", event });
                }
              }
              return;
            }
            const routed = yield* dispatchRoutedEvent(signal.generation, event);
            if (!routed && (resyncsInFlightByGeneration.get(signal.generation) ?? 0) > 0) {
              let buffer = pendingUnmatchedByGeneration.get(signal.generation);
              if (!buffer) {
                buffer = [];
                pendingUnmatchedByGeneration.set(signal.generation, buffer);
              }
              if (buffer.length < MAX_PENDING_UNMATCHED_EVENTS) {
                buffer.push(event);
              }
            }
            return;
          }
        }
      });

    yield* manager.signals.pipe(Stream.runForEach(handleSignal), Effect.forkIn(adapterScope));

    // ── Session lifecycle ────────────────────────────────────────────────

    /**
     * Ends a context: pending requests settle, its tool servers and
     * credential go, and the thread hears `session.exited`. `failure` is set
     * when the session ended on its own (server died, session deleted).
     */
    const stopContext = (ctx: SessionContext, failure: string | undefined) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* Deferred.succeed(ctx.stoppedDeferred, undefined);
        const leftoverResyncs = ctx.pendingResyncCount;
        ctx.pendingResyncCount = 0;
        if (leftoverResyncs > 0) {
          yield* completeGenerationResync(ctx.generation, leftoverResyncs);
        }
        sessions.delete(ctx.threadId);
        if (options.onSessionCommands) {
          yield* options.onSessionCommands(ctx.threadId, undefined).pipe(Effect.ignore);
        }
        for (const [sessionId, owner] of owners) {
          if (owner === ctx) owners.delete(sessionId);
        }
        yield* dropPendingRequests(ctx, undefined);
        const turn = ctx.activeTurn;
        if (turn) {
          ctx.activeTurn = undefined;
          yield* emit({
            type: "turn.completed",
            ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
            payload: failure
              ? { state: "failed", errorMessage: failure }
              : { state: "interrupted", stopReason: "session-stopped" },
          });
          yield* Deferred.succeed(turn.done, undefined);
        }
        yield* Scope.close(ctx.scope, Exit.void);
        if (failure) {
          yield* emit({
            type: "runtime.error",
            ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
            payload: { message: failure, class: "provider_error" },
          });
        }
        yield* emit({
          type: "session.exited",
          ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
          payload: failure ? { exitKind: "error", reason: failure } : { exitKind: "graceful" },
        } as ProviderRuntimeEvent);
      });

    /** Registers this thread's tool servers in the session's directory. */
    const registerToolServers = (ctx: SessionContext, credential: { readonly token: string }) =>
      Effect.gen(function* () {
        const headers = { Authorization: `Bearer ${credential.token}` };
        const servers = [
          { name: openCodeBrowserServerName(ctx.toolKey), url: mcpEndpointUrl(serverConfig.port) },
          ...(ctx.roomEndpoint
            ? [
                {
                  name: openCodeRoomServerName(ctx.toolKey),
                  url: mcpRoomEndpointUrl(serverConfig.port),
                },
              ]
            : []),
          ...(ctx.agentPageAssetsDir !== undefined
            ? [
                {
                  name: openCodePagesServerName(ctx.toolKey),
                  url: mcpPagesEndpointUrl(serverConfig.port),
                },
              ]
            : []),
          ...(ctx.commandRequests
            ? [
                {
                  name: openCodeCommandsServerName(ctx.toolKey),
                  url: mcpCommandsEndpointUrl(serverConfig.port),
                },
              ]
            : []),
          ...(ctx.deviceTools
            ? [
                {
                  name: openCodeDeviceServerName(ctx.toolKey),
                  url: mcpDeviceEndpointUrl(serverConfig.port),
                },
              ]
            : []),
        ];
        yield* Effect.forEach(
          servers,
          (server) =>
            Effect.gen(function* () {
              // Claim ownership and install the removal finalizer before the
              // RPC starts so a sibling failure or interruption never leaves an
              // accepted registration stranded on OpenCode.
              toolServerOwners.set(server.name, ctx);
              yield* Scope.addFinalizer(
                ctx.scope,
                Effect.suspend(() =>
                  toolServerOwners.get(server.name) === ctx
                    ? runOpenCode("mcp.remove", (signal) =>
                        ctx.client.experimental.mcp.remove(
                          { server: server.name, location: { directory: ctx.directory } },
                          { signal },
                        ),
                      ).pipe(
                        Effect.ignore,
                        Effect.ensuring(
                          Effect.sync(() => {
                            toolServerOwners.delete(server.name);
                            const cached = mcpServerCache.get(ctx.directory);
                            if (cached && cached.generation === ctx.generation) {
                              mcpServerCache.set(ctx.directory, {
                                ...cached,
                                value: cached.value.filter((name) => name !== server.name),
                              });
                            }
                          }),
                        ),
                      )
                    : Effect.void,
                ),
              );
              yield* runOpenCode("mcp.add", (signal) =>
                ctx.client.experimental.mcp.add(
                  {
                    server: server.name,
                    location: { directory: ctx.directory },
                    config: {
                      type: "remote",
                      url: server.url,
                      headers,
                      oauth: false,
                      codemode: false,
                    },
                  },
                  { signal },
                ),
              );
            }),
          { concurrency: "unbounded", discard: true },
        );
        const existingMcp = mcpServerCache.get(ctx.directory);
        if (
          existingMcp &&
          existingMcp.generation === ctx.generation &&
          Date.now() - existingMcp.loadedAtMs < MCP_SERVER_CACHE_TTL_MS
        ) {
          mcpServerCache.set(ctx.directory, {
            ...existingMcp,
            value: [...new Set([...existingMcp.value, ...servers.map((server) => server.name)])],
          });
        } else {
          yield* loadMcpServers(ctx.client, ctx.directory, ctx.generation);
        }
      });

    const instructionsFor = (ctx: SessionContext, managedWorktree: boolean) =>
      [
        ...(ctx.localToolServers
          ? [
              buildPreviewPanelInstructions(
                "opencode",
                `${openCodeBrowserServerName(ctx.toolKey)}_`,
              ),
              ...(ctx.agentPageAssetsDir !== undefined
                ? [
                    buildAgentPageInstructions({
                      assetsDir: ctx.agentPageAssetsDir,
                      toolPrefix: `${openCodePagesServerName(ctx.toolKey)}_`,
                    }),
                  ]
                : []),
              ...(ctx.commandRequests
                ? [
                    buildCommandRequestInstructions({
                      toolPrefix: `${openCodeCommandsServerName(ctx.toolKey)}_`,
                    }),
                  ]
                : []),
              ...(ctx.deviceTools
                ? [buildDeviceInstructions(`${openCodeDeviceServerName(ctx.toolKey)}_`)]
                : []),
              ...(ctx.scheduleTools
                ? [
                    buildScheduleInstructions({
                      toolPrefix: `${openCodeRoomServerName(ctx.toolKey)}_`,
                    }),
                  ]
                : []),
              ...(ctx.roomEndpoint
                ? [
                    buildGuideInstructions({
                      toolPrefix: `${openCodeRoomServerName(ctx.toolKey)}_`,
                    }),
                  ]
                : []),
            ]
          : []),
        FILE_LINK_INSTRUCTIONS,
        ...(managedWorktree ? [MANAGED_WORKTREE_INSTRUCTION] : []),
        ...(ctx.projectInstructions !== undefined ? [ctx.projectInstructions] : []),
      ].join("\n\n");

    const resolveModel = (
      selection: { readonly model: string; readonly options?: unknown } | undefined,
    ): OpenCodeModelRef | undefined => {
      if (!selection) return undefined;
      const ref = parseOpenCodeModelSlug(selection.model);
      if (!ref) return undefined;
      const variant = getModelSelectionStringOptionValue(selection as never, "variant");
      return { ...ref, ...(variant ? { variant } : {}) };
    };

    /** A session's whole history, oldest first, a page at a time. */
    const listAllMessages = (client: OpenCodeClient, sessionId: string) =>
      Effect.gen(function* () {
        const messages: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        // A generous cap: forks and transcripts never need more.
        for (let page = 0; page < 50; page += 1) {
          const result = yield* runOpenCode("message.list", (signal) =>
            client.message.list(
              cursor
                ? { sessionID: sessionId, limit: 200, cursor }
                : { sessionID: sessionId, limit: 200, order: "asc" },
              { signal },
            ),
          );
          messages.push(...(result.data as ReadonlyArray<unknown>).filter(isRecord));
          const next = result.cursor?.next;
          if (!next || (result.data as ReadonlyArray<unknown>).length === 0) break;
          cursor = next;
        }
        return messages;
      });

    /**
     * A fork boundary from Threadlines turn ids, which are our prompt ids.
     * "Through this turn" ends at the turn's idle marker: steered messages
     * inside the turn are user messages too, so the next user message is not
     * necessarily the next turn.
     */
    const forkBoundary = (
      client: OpenCodeClient,
      sourceSessionId: string,
      input: {
        readonly beforeTurnId?: string | undefined;
        readonly lastTurnId?: string | undefined;
      },
    ) =>
      Effect.gen(function* () {
        if (input.beforeTurnId) {
          if (!input.beforeTurnId.startsWith("msg_")) return { unsupported: true as const };
          return { before: input.beforeTurnId };
        }
        if (!input.lastTurnId) return {};
        if (!input.lastTurnId.startsWith("msg_")) return { unsupported: true as const };
        // Scan newest-first so forks near the end of long sessions read one
        // page instead of walking the whole history from message #1.
        const newestFirst: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        let foundStart = false;
        for (let page = 0; page < 500; page += 1) {
          const result = yield* runOpenCode("message.list", (signal) =>
            client.message.list(
              cursor
                ? { sessionID: sourceSessionId, limit: 200, cursor }
                : { sessionID: sourceSessionId, limit: 200, order: "desc" },
              { signal },
            ),
          );
          const batch = (result.data as ReadonlyArray<unknown>).filter(isRecord);
          newestFirst.push(...batch);
          if (batch.some((message) => message.id === input.lastTurnId)) {
            foundStart = true;
            break;
          }
          const next = result.cursor?.next;
          if (!next || batch.length === 0) break;
          cursor = next;
        }
        if (!foundStart) return { unsupported: true as const };
        const messages = newestFirst.toReversed();
        const start = messages.findIndex((message) => message.id === input.lastTurnId);
        if (start < 0) return { unsupported: true as const };
        const idle = messages.findIndex(
          (message, index) => index > start && message.type === "idle",
        );
        if (idle < 0) return {};
        const next = messages.find(
          (message, index) =>
            index > idle && message.type === "user" && typeof message.id === "string",
        );
        return next ? { before: String(next.id) } : {};
      });

    const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        // OpenCode loads the user's plugins and MCP servers whatever we ask,
        // so a read-only side answer cannot be promised.
        if (input.lockdown !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "OpenCode cannot answer on the side while another agent works.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopContext(existing, undefined);

        // OpenCode compares paths as strings; a symlinked directory (macOS
        // /tmp) silently breaks its snapshots, so diffs and reverts. For an
        // external server the path may only exist on that remote host.
        const rawCwd = input.cwd.trim();
        const externalConfigured = options.settings.serverUrl.trim().length > 0;
        const directory = externalConfigured
          ? yield* fileSystem.realPath(rawCwd).pipe(Effect.orElseSucceed(() => rawCwd))
          : yield* fileSystem.realPath(rawCwd).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: `Working directory not found: ${input.cwd}`,
                    cause,
                  }),
              ),
            );

        const scope = yield* Scope.make("sequential");
        return yield* Effect.gen(function* () {
          yield* manager.lease.pipe(Effect.provideService(Scope.Scope, scope));
          const roomTools = input.roomTools === true;
          const roomGrant = roomEndpointGrant(input, undefined);
          // Overlap local filesystem prep with starting/connecting to OpenCode
          // and waiting for its event stream.
          const { active, agentPageAssetsDir, managedWorktree } = yield* Effect.all(
            {
              active: manager.server.pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: error.detail,
                      cause: error,
                    }),
                ),
                Effect.tap((server) =>
                  server.streamReady.pipe(Effect.timeout(Duration.seconds(15)), Effect.ignore),
                ),
              ),
              // The page tools, with their image folder (OpenCode refuses side runtimes).
              agentPageAssetsDir:
                input.agentPages === true
                  ? ensurePageAssetsDir(parseSessionKey(input.threadId).threadId).pipe(
                      Effect.map((dir): string | undefined => dir),
                      Effect.orElseSucceed(() => undefined),
                    )
                  : Effect.succeed<string | undefined>(undefined),
              managedWorktree: isLinkedWorktreeCheckout(directory).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              ),
            },
            { concurrency: "unbounded" },
          );
          const client = active.server.client;
          const boundSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = resolveModel(boundSelection);

          const hasResumeCursor = input.resumeCursor !== undefined && input.resumeCursor !== null;
          const resumeId = parseOpenCodeResumeCursor(input.resumeCursor)?.sessionId;
          let rootSessionId: string | undefined;
          let resumed = false;
          let resumeFailed = false;
          let initialSessionInfo:
            | {
                readonly agent?: string | undefined;
                readonly model?:
                  | {
                      readonly providerID: string;
                      readonly id: string;
                      readonly variant?: string | undefined;
                    }
                  | undefined;
              }
            | undefined;
          if (hasResumeCursor && !resumeId) {
            if (input.resumePolicy === "required") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.get",
                detail: "OpenCode cannot resume that saved session.",
              });
            }
            resumeFailed = true;
          } else if (resumeId) {
            const found = yield* runOpenCode("session.get", (signal) =>
              client.session.get({ sessionID: resumeId }, { signal }),
            ).pipe(Effect.result);
            if (found._tag === "Success") {
              rootSessionId = found.success.id;
              initialSessionInfo = found.success;
              resumed = true;
              // A checkout switch resumes the same conversation somewhere
              // else; OpenCode keeps working wherever the session is.
              if (found.success.location?.directory !== directory) {
                yield* runOpenCode("session.move", (signal) =>
                  client.session.move({ sessionID: rootSessionId!, directory }, { signal }),
                ).pipe(Effect.mapError(toRequestError("session.move")));
              }
            } else if (isOpenCodeSessionNotFound(found.failure)) {
              if (input.resumePolicy === "required") {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.get",
                  detail: `OpenCode no longer has session ${resumeId}.`,
                });
              }
              resumeFailed = true;
            } else {
              // Preserve the saved session cursor on transient or server errors
              // instead of silently replacing the conversation with a blank one.
              return yield* toRequestError("session.get")(found.failure);
            }
          }
          if (!rootSessionId && input.forkFrom) {
            // A fork keeps its source's directory, and OpenCode would keep
            // editing there; a fork into another checkout starts fresh from
            // the transcript instead (the caller falls back to the seed).
            const source = yield* runOpenCode("session.get", (signal) =>
              client.session.get({ sessionID: input.forkFrom!.providerThreadId }, { signal }),
            ).pipe(Effect.mapError(toRequestError("session.get")));
            if (source.location?.directory !== directory) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "OpenCode can only fork a session within its own directory.",
              });
            }
            const boundary = yield* forkBoundary(
              client,
              input.forkFrom.providerThreadId,
              input.forkFrom,
            ).pipe(Effect.mapError(toRequestError("session.fork")));
            if ("unsupported" in boundary) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "That turn cannot be a fork point in OpenCode.",
              });
            }
            const forked = yield* runOpenCode("session.fork", (signal) =>
              client.session.fork(
                { sessionID: input.forkFrom!.providerThreadId, ...boundary },
                { signal },
              ),
            ).pipe(Effect.mapError(toRequestError("session.fork")));
            rootSessionId = forked.id;
            initialSessionInfo = forked;
          }
          if (!rootSessionId) {
            const created = yield* runOpenCode("session.create", (signal) =>
              client.session.create(
                {
                  location: { directory },
                  agent: BUILD_AGENT,
                  ...(model ? { model } : {}),
                },
                { signal },
              ),
            ).pipe(Effect.mapError(toRequestError("session.create")));
            rootSessionId = created.id;
            initialSessionInfo = created;
          }

          const canAttachLocalToolServers =
            !active.server.external || isLoopbackServerUrl(active.server.url);
          const ctx: SessionContext = {
            threadId: input.threadId,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: directory,
              ...(model ? { model: openCodeModelSlug(model) } : {}),
              threadId: input.threadId,
              resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: rootSessionId },
              providerThreadId: rootSessionId,
              ...(roomTools ? { roomTools: canAttachLocalToolServers } : {}),
              ...(resumeFailed ? { resumeFailed: true } : {}),
              createdAt: yield* nowIso,
              updatedAt: yield* nowIso,
            },
            rootSessionId,
            directory,
            external: active.server.external,
            generation: active.generation,
            client,
            scope,
            eventQueue: yield* Queue.unbounded<SessionSignalItem>(),
            toolKey: openCodeThreadToolKey(input.threadId),
            localToolServers: canAttachLocalToolServers,
            roomEndpoint: roomGrant.attach,
            scheduleTools: roomTools && input.scheduleTools === true,
            agentPageAssetsDir,
            commandRequests: input.commandRequests === true,
            deviceTools: input.deviceTools === true,
            projectInstructions: input.projectInstructions,
            runtimeMode: input.runtimeMode,
            agent: BUILD_AGENT,
            defaultAgent: BUILD_AGENT,
            model,
            contextLimit: undefined,
            pendingSeed:
              !resumed && input.contextSeed !== undefined && input.forkFrom === undefined
                ? renderThreadContextSeed(input.contextSeed)
                : undefined,
            activeTurn: undefined,
            silenceNextWake: false,
            quietUntilTurn: input.quietResume === true,
            silencedExecution: false,
            withdrawnReports: new Set(),
            turns: [],
            rules: new Map(),
            childRulesReady: new Map(),
            children: new Map(),
            stoppedChildren: new Set(),
            tools: new Map(),
            blocks: new Map(),
            approvals: new Map(),
            approvalIds: new Map(),
            inFlightAutoApprovals: new Map(),
            questions: new Map(),
            questionIds: new Map(),
            inFlightFormCancels: new Map(),
            backgroundShells: new Map(),
            releasedBackgroundShells: new Set(),
            approvalPreviews: new Map(),
            shellCalls: new Map(),
            compactionCount: 0,
            turnStartLock: yield* Semaphore.make(1),
            steerLock: yield* Semaphore.make(1),
            activeResyncFiber: undefined,
            pendingResyncCount: 0,
            serverGone: false,
            stopped: false,
            stoppedDeferred: yield* Deferred.make<void>(),
          };

          if (resumed || input.forkFrom) {
            const info =
              initialSessionInfo ??
              Option.getOrUndefined(
                yield* runOpenCode("session.get", (signal) =>
                  client.session.get({ sessionID: rootSessionId! }, { signal }),
                ).pipe(Effect.option),
              );
            if (info) {
              ctx.agent = info.agent ?? BUILD_AGENT;
              if (info.agent && info.agent !== PLAN_AGENT) {
                ctx.defaultAgent = info.agent;
              }
              if (!model && info.model) {
                ctx.model = {
                  providerID: info.model.providerID,
                  id: info.model.id,
                  ...(info.model.variant ? { variant: info.model.variant } : {}),
                };
              }
            }
          }

          let localToolWarning: string | undefined;
          let credential: { readonly token: string; readonly generation: number } | undefined;
          if (canAttachLocalToolServers) {
            // The browser panel (and, in a room, the room tools), on a
            // credential that names this thread and dies with this context.
            credential = yield* mcpSessionRegistry.credentialFor({
              sessionKey: input.threadId,
              browser: true,
              room: roomGrant.attach,
              pages: agentPageAssetsDir !== undefined,
              commands: input.commandRequests === true,
              device: input.deviceTools === true,
              scheduledRun: input.scheduledRunTools === true,
              guideOnly: roomGrant.guideOnly,
              // OpenCode registers tool servers per folder: every session in
              // `directory` can call these, so a limit on one limits all.
              toolDirectory: directory,
            });
            yield* Scope.addFinalizer(
              scope,
              mcpSessionRegistry.revoke(input.threadId, credential.generation),
            );
          } else {
            localToolWarning =
              "Threadlines' local tools (browser, room, pages, commands, devices) are not attached because this OpenCode server is remote.";
          }

          // For an external loopback server (e.g. a container that cannot reach
          // host loopback), register tools first so a refusal degrades cleanly
          // instead of failing session startup or advertising missing tools.
          if (active.server.external && credential !== undefined) {
            const attached = yield* registerToolServers(ctx, credential).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not register Threadlines tool servers on external OpenCode server",
                  { error },
                ).pipe(Effect.as(false)),
              ),
            );
            if (!attached) {
              ctx.localToolServers = false;
              if (roomTools) {
                ctx.session = { ...ctx.session, roomTools: false };
              }
              localToolWarning =
                "Threadlines could not attach its local tools to the configured OpenCode server; continuing without them.";
            }
          }

          // Run independent post-create setup in parallel while keeping
          // session-mutating RPCs (`interrupt` -> `update` -> `switchModel`)
          // serialized so OpenCode never races updates to the same session.
          const sessionSetup = Effect.gen(function* () {
            // The native session outlives the runtime: end anything it was
            // still running for the one before (outside work's fresh start).
            // A start that can't is no fresh start: it fails, and the agent
            // stays marked.
            if (ctx.quietUntilTurn && resumed) {
              yield* runOpenCode("session.interrupt", (signal) =>
                ctx.client.session.interrupt({ sessionID: ctx.rootSessionId }, { signal }),
              ).pipe(Effect.mapError(toRequestError("session.interrupt")));
            }
            yield* rulesFor(ctx, ctx.agent).pipe(
              Effect.flatMap((rules) => applyRules(ctx, rootSessionId!, rules)),
              Effect.mapError(toRequestError("session.update")),
            );
            if ((resumed || input.forkFrom) && model) {
              yield* runOpenCode("session.switchModel", (signal) =>
                client.session.switchModel({ sessionID: rootSessionId!, model }, { signal }),
              ).pipe(Effect.mapError(toRequestError("session.switchModel")));
            }
          });
          const [, , contextLimit, , loadedCommands] = yield* Effect.all(
            [
              !active.server.external && credential !== undefined
                ? registerToolServers(ctx, credential).pipe(
                    Effect.mapError(toRequestError("mcp.add")),
                  )
                : Effect.void,
              sessionSetup,
              contextLimitFor(ctx, ctx.model),
              runOpenCode("instructions.put", (signal) =>
                client.experimental.session.instructions.entry.put(
                  {
                    sessionID: rootSessionId!,
                    key: "threadlines",
                    value: instructionsFor(ctx, managedWorktree),
                  },
                  { signal },
                ),
              ).pipe(Effect.mapError(toRequestError("instructions.put"))),
              options.onSessionCommands
                ? loadCommands(client, directory, active.generation)
                : Effect.succeed(undefined),
            ],
            { concurrency: "unbounded" },
          );
          ctx.contextLimit = contextLimit;
          if (ctx.model && !ctx.session.model) {
            ctx.session = { ...ctx.session, model: openCodeModelSlug(ctx.model) };
          }

          // Subagents from before a restart: known again, so their
          // transcripts open and their reports route to this thread.
          if (resumed) {
            const children = yield* runOpenCode("session.list", (signal) =>
              client.session.list({ parentID: rootSessionId!, limit: 100 }, { signal }),
            ).pipe(
              Effect.map((result) => result.data ?? []),
              Effect.orElseSucceed(() => []),
            );
            for (const child of children) {
              ctx.children.set(child.id, {
                sessionId: child.id,
                parentSessionId: rootSessionId!,
                turnId: undefined,
                agent: child.agent,
                title: child.title,
                callId: undefined,
                background: false,
                status: "completed",
                lastText: "",
              });
              owners.set(child.id, ctx);
            }
          }

          sessions.set(input.threadId, ctx);
          ranHere.add(input.threadId);
          owners.set(rootSessionId, ctx);
          if (
            options.onSessionCommands &&
            loadedCommands !== undefined &&
            loadedCommands.version === commandCacheVersion
          ) {
            yield* options
              .onSessionCommands(input.threadId, loadedCommands.commands)
              .pipe(Effect.ignore);
          }
          yield* Queue.take(ctx.eventQueue).pipe(
            Effect.flatMap((item) => processSessionItem(ctx, item)),
            Effect.forever,
            Effect.forkIn(scope, { startImmediately: true }),
          );

          yield* emit({
            type: "session.started",
            ...(yield* eventBase(ctx, rootSessionId, undefined)),
            payload: {},
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* eventBase(ctx, rootSessionId, undefined)),
            payload: { state: "ready", reason: "OpenCode session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* eventBase(ctx, rootSessionId, undefined)),
            payload: { providerThreadId: rootSessionId },
          });
          if (localToolWarning !== undefined) {
            yield* emit({
              type: "runtime.warning",
              ...(yield* eventBase(ctx, rootSessionId, undefined)),
              payload: { message: localToolWarning },
            } as ProviderRuntimeEvent);
          }
          return ctx.session;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    /**
     * Text and attachments as an OpenCode prompt. Pictures, PDFs and text
     * travel inline (text as plain text, the one text type every model
     * provider takes); any other file, and text too big to go inline, is a
     * note naming its staged path, which the agent opens with its own tools.
     */
    const promptContent = (
      threadId: ThreadId,
      input: {
        readonly input?: string | undefined;
        readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const resolvedAttachments = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              const path = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!path) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              if (
                (attachment.type === "file" && attachment.kind === "other") ||
                isLargeTextAttachment(attachment)
              ) {
                return { kind: "note" as const, text: buildFileAttachmentNote(attachment, path) };
              }
              const bytes = yield* fileSystem.readFile(path).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session.prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              const mimeType =
                attachment.type === "file" && attachment.kind === "text"
                  ? "text/plain"
                  : attachment.mimeType;
              return {
                kind: "file" as const,
                file: {
                  uri: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
                  name: attachment.name,
                },
              };
            }),
          { concurrency: 8 },
        );
        const files: Array<{ uri: string; name?: string }> = [];
        const notes: Array<string> = [];
        for (const entry of resolvedAttachments) {
          if (entry.kind === "note") notes.push(entry.text);
          else files.push(entry.file);
        }
        const text = [input.input?.trim() ?? "", ...notes].filter(Boolean).join("\n\n");
        if (!text && files.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Turn for ${threadId} requires text or attachments.`,
          });
        }
        return { text, files, notes };
      });

    const resolveDefaultAgent = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const agents = yield* loadAgents(ctx.client, ctx.directory, ctx.generation).pipe(
          Effect.orElseSucceed(() => []),
        );
        if (agents.length === 0) return ctx.defaultAgent;
        if (agents.some((candidate) => candidate.id === ctx.defaultAgent)) return ctx.defaultAgent;
        if (agents.some((candidate) => candidate.id === BUILD_AGENT)) return BUILD_AGENT;
        return (
          agents.find((candidate) => candidate.mode === "primary" && candidate.id !== PLAN_AGENT)
            ?.id ??
          agents.find((candidate) => candidate.id !== PLAN_AGENT)?.id ??
          ctx.defaultAgent
        );
      });

    const switchAgent = (ctx: SessionContext, agent: string) =>
      Effect.gen(function* () {
        if (ctx.agent === agent) return;
        const agents = yield* loadAgents(ctx.client, ctx.directory, ctx.generation).pipe(
          Effect.orElseSucceed(() => []),
        );
        // OpenCode accepts an unknown agent and then fails every run.
        if (agents.length > 0 && !agents.some((candidate) => candidate.id === agent)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `OpenCode has no '${agent}' agent in this project.`,
          });
        }
        yield* runOpenCode("session.switchAgent", (signal) =>
          ctx.client.session.switchAgent({ sessionID: ctx.rootSessionId, agent }, { signal }),
        ).pipe(Effect.mapError(toRequestError("session.switchAgent")));
        ctx.agent = agent;
        yield* rulesFor(ctx, agent).pipe(
          Effect.flatMap((rules) => applyRules(ctx, ctx.rootSessionId, rules)),
          Effect.mapError(toRequestError("session.update")),
        );
      });

    const finishTurnSerialized = (ctx: SessionContext, turn: ActiveTurn, terminal: Terminal) =>
      Effect.suspend(() => {
        if (ctx.stopped) return Effect.void;
        return Queue.offer(ctx.eventQueue, { _tag: "FinishTurn", turn, terminal }).pipe(
          Effect.andThen(
            Effect.raceFirst(Deferred.await(turn.done), Deferred.await(ctx.stoppedDeferred)),
          ),
        );
      });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (ctx) =>
        ctx.turnStartLock.withPermit(
          Effect.gen(function* () {
            // One turn at a time: a send while the agent works (its own wake,
            // say) starts once that turn ends.
            if (ctx.activeTurn) yield* Deferred.await(ctx.activeTurn.done);
            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            const content = yield* promptContent(input.threadId, input);
            const targetAgent =
              input.interactionMode === "plan" ? PLAN_AGENT : yield* resolveDefaultAgent(ctx);
            yield* switchAgent(ctx, targetAgent);
            const selection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const model = resolveModel(selection);
            if (
              model &&
              (model.providerID !== ctx.model?.providerID ||
                model.id !== ctx.model?.id ||
                model.variant !== ctx.model?.variant)
            ) {
              yield* runOpenCode("session.switchModel", (signal) =>
                ctx.client.session.switchModel({ sessionID: ctx.rootSessionId, model }, { signal }),
              ).pipe(Effect.mapError(toRequestError("session.switchModel")));
              ctx.model = model;
              ctx.contextLimit = yield* contextLimitFor(ctx, model);
              ctx.session = { ...ctx.session, model: openCodeModelSlug(model) };
            }

            const skills = (input.skills ?? []).map((skill) => ({ id: skill.name }));
            // `/name args` runs one of the project's commands. OpenCode gives
            // a command no prompt id, so its turn has no fork or rollback point.
            // Check `typed.text` when present so server-prepended context does
            // not hide a typed command; if it runs, context stays deferred.
            const commandSource =
              input.typed !== undefined ? input.typed.text.trim() : content.text;
            const command = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(commandSource);
            const commands = command
              ? yield* loadCommands(ctx.client, ctx.directory, ctx.generation)
              : undefined;
            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            if (command && commands?.names.has(command[1]!)) {
              const contextDeferred =
                input.typed?.context !== undefined || ctx.pendingSeed !== undefined;
              const commandText = [command[2]?.trim() ?? "", ...content.notes]
                .filter(Boolean)
                .join("\n\n");
              const turn = yield* beginTurn(ctx, {
                turnId: TurnId.make(`cmd_${(yield* randomUUIDv4).replaceAll("-", "")}`),
                origin: "user",
                plan: ctx.agent === PLAN_AGENT,
              });
              const sent = yield* runOpenCode("session.command", (signal) =>
                ctx.client.session.command(
                  {
                    sessionID: ctx.rootSessionId,
                    name: command[1]!,
                    text: commandText,
                    ...(content.files.length > 0 ? { files: content.files } : {}),
                    ...(skills.length > 0 ? { skills } : {}),
                    delivery: "steer",
                  },
                  { signal },
                ),
              ).pipe(Effect.exit);
              if (Exit.isFailure(sent)) {
                yield* finishTurnSerialized(ctx, turn, {
                  kind: "failed",
                  message: `OpenCode could not run /${command[1]}: ${openCodeErrorDetail(Cause.squash(sent.cause))}`,
                  type: undefined,
                });
                return {
                  threadId: input.threadId,
                  turnId: turn.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                  undelivered: true as const,
                };
              }
              return {
                threadId: input.threadId,
                turnId: turn.turnId,
                resumeCursor: ctx.session.resumeCursor,
                ...(contextDeferred ? { contextDeferred: true as const } : {}),
              };
            }

            const promptId = openCodePromptId(input.messageId, yield* randomUUIDv4);
            const turn = yield* beginTurn(ctx, {
              turnId: TurnId.make(promptId),
              origin: "user",
              promptId,
              plan: ctx.agent === PLAN_AGENT,
            });
            const text = ctx.pendingSeed
              ? withContextSeedPreamble(ctx.pendingSeed, content.text)
              : content.text;
            const sent = yield* runOpenCode("session.prompt", (signal) =>
              ctx.client.session.prompt(
                {
                  sessionID: ctx.rootSessionId,
                  id: promptId,
                  text,
                  ...(content.files.length > 0 ? { files: content.files } : {}),
                  ...(skills.length > 0 ? { skills } : {}),
                  delivery: "steer",
                },
                { signal },
              ),
            ).pipe(Effect.exit);
            if (Exit.isFailure(sent)) {
              yield* finishTurnSerialized(ctx, turn, {
                kind: "failed",
                message: `OpenCode did not accept the message: ${openCodeErrorDetail(Cause.squash(sent.cause))}`,
                type: undefined,
              });
              return {
                threadId: input.threadId,
                turnId: turn.turnId,
                resumeCursor: ctx.session.resumeCursor,
                undelivered: true as const,
              };
            }
            ctx.pendingSeed = undefined;
            return {
              threadId: input.threadId,
              turnId: turn.turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        ),
      );

    const steerTurn: NonNullable<OpenCodeAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turn = ctx.activeTurn;
        if (!turn || turn.turnId !== input.expectedTurnId) {
          return yield* steerRejectedError(PROVIDER, "OpenCode", "no-active-turn");
        }
        if (turn.stopRequested) {
          return yield* steerRejectedError(PROVIDER, "OpenCode", "turn-finishing");
        }
        const content = yield* promptContent(input.threadId, input);
        const skills = (input.skills ?? []).map((skill) => ({ id: skill.name }));
        const promptId = openCodePromptId(input.messageId, yield* randomUUIDv4);
        return yield* ctx.steerLock.withPermit(
          Effect.gen(function* () {
            // The turn may have ended or been stopped while the attachments
            // were read; a steer must never start work after either.
            if (ctx.activeTurn !== turn) {
              return yield* steerRejectedError(PROVIDER, "OpenCode", "no-active-turn");
            }
            if (turn.stopRequested) {
              return yield* steerRejectedError(PROVIDER, "OpenCode", "turn-finishing");
            }
            turn.undelivered.add(promptId);
            yield* runOpenCode("session.prompt", (signal) =>
              ctx.client.session.prompt(
                {
                  sessionID: ctx.rootSessionId,
                  id: promptId,
                  text: content.text,
                  ...(content.files.length > 0 ? { files: content.files } : {}),
                  ...(skills.length > 0 ? { skills } : {}),
                  delivery: "steer",
                },
                { signal },
              ),
            ).pipe(
              Effect.tapError(() => Effect.sync(() => turn.undelivered.delete(promptId))),
              Effect.mapError(toRequestError("session.prompt")),
            );
            return {
              threadId: input.threadId,
              turnId: turn.turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        );
      });

    /**
     * Stop means everything stops: input steered in but not yet read is
     * withdrawn, running subagents are interrupted (OpenCode stops only
     * foreground ones with their parent), and the reports they would send back
     * do not wake the agent again. If OpenCode is still running after the
     * grace period, the turn stays open rather than claiming it stopped.
     */
    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turn = ctx.activeTurn;
        // A stop that arrives late, for a turn that already ended, must not
        // stop the next one.
        if (turnId !== undefined && turn?.turnId !== turnId) return;
        if (turn) turn.stopRequested = true;
        yield* ctx.steerLock.withPermit(
          Effect.forEach(
            turn ? [...turn.undelivered] : [],
            (inboxId) =>
              runOpenCode("session.inbox.cancel", (signal) =>
                ctx.client.session.inbox.cancel(
                  { sessionID: ctx.rootSessionId, inboxID: inboxId },
                  { signal },
                ),
              ).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          ),
        );
        // Withdrawing the last queued steer can end a held turn, and a send
        // waiting on it then starts the next one: that one is not ours to stop.
        if (turn && ctx.activeTurn !== turn) return;
        // Loop until no newly started running children remain so a child
        // registered while earlier interrupts were in flight is also stopped.
        for (;;) {
          const runningChildren = [...ctx.children.values()].filter(
            (child) => child.status === "running" && !ctx.stoppedChildren.has(child.sessionId),
          );
          if (runningChildren.length === 0) break;
          for (const child of runningChildren) {
            ctx.stoppedChildren.add(child.sessionId);
          }
          yield* Effect.forEach(
            runningChildren,
            (child) =>
              runOpenCode("session.interrupt", (signal) =>
                ctx.client.session.interrupt({ sessionID: child.sessionId }, { signal }),
              ).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          );
        }
        yield* dropPendingRequests(ctx, undefined);
        const result = yield* runOpenCode("session.interrupt", (signal) =>
          ctx.client.session.interrupt({ sessionID: ctx.rootSessionId, resume: false }, { signal }),
        ).pipe(Effect.mapError(toRequestError("session.interrupt")));
        if (!turn || ctx.activeTurn !== turn) return;
        if (!result.interrupted) {
          // Nothing was running: the prompt was still queued, or the end
          // event is on its way. Either way the turn is over; serialize through
          // the session queue so any final SSE deltas land first.
          yield* finishTurnSerialized(ctx, turn, { kind: "interrupted", reason: "user" });
          return;
        }
        if (turn.stopCheckFiber) {
          const previous = turn.stopCheckFiber;
          turn.stopCheckFiber = undefined;
          yield* Fiber.interrupt(previous);
        }
        turn.stopCheckFiber = yield* Effect.gen(function* () {
          for (let attempt = 1; attempt <= STOP_SETTLE_MAX_CHECKS + 1; attempt += 1) {
            yield* Effect.sleep(STOP_SETTLE_TIMEOUT);
            if (ctx.stopped || ctx.activeTurn !== turn) return;
            const active = yield* runOpenCode("session.active", (signal) =>
              ctx.client.session.active({ signal }),
            ).pipe(Effect.option);
            // The turn may have ended (and the next begun) while we asked.
            if (ctx.stopped || ctx.activeTurn !== turn) return;
            // Only OpenCode saying it is idle ends the turn; a failed check
            // proves nothing, so the turn stays open and the stop is repeated.
            if (active._tag === "Some" && !(ctx.rootSessionId in active.value)) {
              turn.stopCheckFiber = undefined;
              yield* Queue.offer(ctx.eventQueue, {
                _tag: "FinishTurn",
                turn,
                terminal: { kind: "interrupted", reason: "user" },
              });
              return;
            }
            if (attempt > STOP_SETTLE_MAX_CHECKS) return;
            if (attempt === 1) {
              yield* emit({
                type: "runtime.warning",
                ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
                payload: { message: "OpenCode has not stopped yet; asking it again." },
              } as ProviderRuntimeEvent);
            }
            yield* runOpenCode("session.interrupt", (signal) =>
              ctx.client.session.interrupt(
                { sessionID: ctx.rootSessionId, resume: false },
                { signal },
              ),
            ).pipe(Effect.ignore);
          }
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.approvals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        const { permission } = pending;
        switch (decision) {
          case "cancel":
            yield* interruptTurn(threadId);
            return;
          case "decline":
            // A reject with a message lets the model carry on; without one
            // OpenCode ends the whole run.
            yield* replyPermission(ctx, permission, "reject", DECLINE_MESSAGE).pipe(
              Effect.mapError(toRequestError("permission.reply")),
            );
            break;
          case "acceptForSession": {
            // OpenCode's own "always" is saved for the whole project; this
            // grant lives on this session only. Wait for initial child rule
            // installation so we never overwrite a subagent's base restrictions.
            const pendingRules = ctx.childRulesReady.get(permission.sessionID);
            if (pendingRules !== undefined) {
              yield* Deferred.await(pendingRules);
            }
            const current = ctx.rules.get(permission.sessionID);
            if (current === undefined) {
              yield* replyPermission(ctx, permission, "once").pipe(
                Effect.mapError(toRequestError("permission.reply")),
              );
              break;
            }
            yield* applyRules(ctx, permission.sessionID, [
              ...current,
              ...openCodeSessionGrantRules(permission),
            ]).pipe(Effect.mapError(toRequestError("session.update")));
            yield* replyPermission(ctx, permission, "once").pipe(
              Effect.mapError(toRequestError("permission.reply")),
            );
            break;
          }
          case "accept":
            yield* replyPermission(ctx, permission, "once").pipe(
              Effect.mapError(toRequestError("permission.reply")),
            );
            break;
        }
        yield* resolveApproval(ctx, requestId, decision);
      });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.questions.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "form.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        const { form } = pending;
        const answer = openCodeFormAnswer(form, answers);
        const cancel = (message: string) =>
          runOpenCode("form.cancel", (signal) =>
            ctx.client.session.form.cancel(
              { sessionID: form.sessionID, formID: form.id, message },
              { signal },
            ),
          );
        if (!answer) {
          yield* cancel(QUESTION_DISMISSED_MESSAGE).pipe(
            Effect.mapError(toRequestError("form.cancel")),
          );
        } else {
          yield* runOpenCode("form.reply", (signal) =>
            ctx.client.session.form.reply(
              { sessionID: form.sessionID, formID: form.id, answer },
              { signal },
            ),
          ).pipe(
            // An answer the form refuses (free text where it wants a choice)
            // still reaches the model, as the dismissal note.
            Effect.catch((error) =>
              openCodeErrorTag(error) === "FormInvalidAnswerError"
                ? cancel(`The user answered: ${JSON.stringify(answer)}`)
                : Effect.fail(error),
            ),
            Effect.mapError(toRequestError("form.reply")),
          );
        }
        yield* resolveQuestion(ctx, requestId, answers);
      });

    const compactContext: NonNullable<OpenCodeAdapterShape["compactContext"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* runOpenCode(
          "session.compact",
          (signal) => ctx.client.session.compact({ sessionID: ctx.rootSessionId }, { signal }),
          { timeoutMs: null },
        ).pipe(Effect.mapError(toRequestError("session.compact")));
      });

    /**
     * Rolls OpenCode's history back to before a turn's prompt. Our checkpoints
     * own the files, so only history is reverted (`files: false`). A stage
     * left behind would be committed by OpenCode on the next prompt, so a
     * failed commit clears it again.
     */
    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (
      threadId,
      numTurns,
      rollbackOptions,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        if (ctx.activeTurn) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Stop the running turn before rolling back.",
          });
        }
        if (
          [...ctx.children.values()].some((child) => child.status === "running" && child.background)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue:
              "A background agent is still running and would report into the rolled-back history.",
          });
        }
        const target =
          rollbackOptions?.targetUserMessageId !== undefined
            ? openCodePromptId(rollbackOptions.targetUserMessageId, "")
            : ctx.turns[ctx.turns.length - numTurns]?.promptId;
        const exists = target
          ? yield* runOpenCode("message.get", (signal) =>
              ctx.client.session.message.get(
                { sessionID: ctx.rootSessionId, messageID: target },
                { signal },
              ),
            ).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : false;
        if (!target || !exists) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "revert.stage",
            detail: "OpenCode has no message to roll back to for that turn.",
          });
        }
        yield* runOpenCode("revert.stage", (signal) =>
          ctx.client.session.revert.stage(
            { sessionID: ctx.rootSessionId, messageID: target, files: false },
            { signal },
          ),
        ).pipe(Effect.mapError(toRequestError("revert.stage")));
        yield* runOpenCode("revert.commit", (signal) =>
          ctx.client.session.revert.commit({ sessionID: ctx.rootSessionId }, { signal }),
        ).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              // Clearing wakes the session with an empty run; it is not a turn.
              ctx.silenceNextWake = true;
              yield* runOpenCode("revert.clear", (signal) =>
                ctx.client.session.revert.clear({ sessionID: ctx.rootSessionId }, { signal }),
              ).pipe(Effect.ignore);
            }),
          ),
          Effect.mapError(toRequestError("revert.commit")),
        );
        const index = ctx.turns.findIndex((turn) => turn.promptId === target);
        ctx.turns.splice(index >= 0 ? index : Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns.map((turn) => ({ id: turn.id, items: [] })) };
      });

    const readSubagentTranscript: NonNullable<OpenCodeAdapterShape["readSubagentTranscript"]> = (
      threadId,
      input,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const child = ctx.children.get(input.agentId);
        if (!child) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readSubagentTranscript",
            detail: `Agent ${input.agentId} does not belong to this thread.`,
          });
        }
        const listed = yield* listAllMessages(ctx.client, child.sessionId).pipe(
          Effect.mapError(toRequestError("message.list")),
        );
        const entries: Array<ProviderSubagentTranscriptEntry> = [];
        for (const message of listed) {
          if (!isRecord(message)) continue;
          const at =
            isRecord(message.time) && typeof message.time.created === "number"
              ? new Date(message.time.created).toISOString()
              : undefined;
          if (message.type === "user" && typeof message.text === "string") {
            entries.push({
              id: String(message.id),
              role: "user",
              text: message.text,
              toolUses: [],
              ...(at ? { at } : {}),
            });
            continue;
          }
          if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
          const parts = message.content.filter(isRecord);
          const thinking = parts.filter(
            (part) => part.type === "reasoning" && typeof part.text === "string",
          );
          if (thinking.length > 0) {
            entries.push({
              role: "thinking",
              text: thinking.map((part) => String(part.text)).join("\n"),
              toolUses: [],
              ...(at ? { at } : {}),
            });
          }
          const tools = parts.filter(
            (part) => part.type === "tool" && typeof part.name === "string",
          );
          const outputs = tools.flatMap((part) =>
            isRecord(part.state) && Array.isArray(part.state.content)
              ? [openCodeToolOutputText(part.state.content)]
              : [],
          );
          entries.push({
            id: String(message.id),
            role: "assistant",
            text: parts
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => String(part.text))
              .join("\n"),
            toolUses: tools.map((part) => {
              const identity = identifyOpenCodeTool(
                String(part.name),
                mcpServerCache.get(ctx.directory)?.value ?? [],
              );
              const toolInput = isRecord(part.state) ? part.state.input : undefined;
              return {
                name: String(part.name),
                summary: openCodeToolDetail(identity, toolInput) ?? String(part.name),
              };
            }),
            ...(outputs.some(Boolean)
              ? { outputPreview: outputs.filter(Boolean).join("\n").slice(0, 2_000) }
              : {}),
            ...(tools.some((part) => isRecord(part.state) && part.state.status === "error")
              ? { outputIsError: true }
              : {}),
            ...(at ? { at } : {}),
          });
        }
        const total = entries.length;
        const limit = input.limit && input.limit > 0 ? input.limit : total;
        const offset = input.fromEnd
          ? Math.max(0, total - limit)
          : Math.min(input.offset ?? 0, total);
        return {
          entries: entries.slice(offset, offset + limit),
          truncated: offset + limit < total || offset > 0,
          offset,
          totalEntries: total,
          agent: {
            id: child.sessionId,
            ...(child.agent ? { agentType: child.agent } : {}),
            ...(child.title ? { description: child.title } : {}),
            directInput: "parentOnly",
          },
        };
      });

    const deleteThread: NonNullable<OpenCodeAdapterShape["deleteThread"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const client = ctx.client;
        const sessionId = ctx.rootSessionId;
        yield* stopContext(ctx, undefined);
        yield* runOpenCode("session.remove", (signal) =>
          client.session.remove({ sessionID: sessionId }, { signal }),
        ).pipe(Effect.mapError(toRequestError("session.remove")));
      });

    const stopSessionContext = (ctx: SessionContext) =>
      Effect.gen(function* () {
        // Release OpenCode's claim on running executions, so the user's own
        // OpenCode service never resumes them later, and stop background work
        // nobody would be listening to: it would wake an agent no one sees.
        const running = [
          ...(ctx.activeTurn ? [ctx.rootSessionId] : []),
          ...[...ctx.children.values()]
            .filter((child) => child.status === "running")
            .map((child) => child.sessionId),
        ];
        if (running.length > 0 || ctx.backgroundShells.size > 0) {
          const prev = stoppedWork.get(ctx.threadId);
          const sameGen = prev !== undefined && prev.generation === ctx.generation;
          stoppedWork.set(ctx.threadId, {
            generation: ctx.generation,
            client: ctx.client,
            directory: ctx.directory,
            sessionIds: sameGen ? [...new Set([...prev.sessionIds, ...running])] : running,
            shellIds: sameGen
              ? [...new Set([...prev.shellIds, ...ctx.backgroundShells.keys()])]
              : [...ctx.backgroundShells.keys()],
          });
        }
        yield* Effect.forEach(
          running,
          (sessionId) =>
            runOpenCode("session.interrupt", (signal) =>
              ctx.client.session.interrupt({ sessionID: sessionId }, { signal }),
            ).pipe(Effect.ignore),
          { discard: true, concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          [...ctx.backgroundShells.keys()],
          (shellId) =>
            runOpenCode("shell.remove", (signal) =>
              ctx.client.shell.remove(
                { id: shellId, location: { directory: ctx.directory } },
                { signal },
              ),
            ).pipe(Effect.ignore),
          { discard: true, concurrency: "unbounded" },
        );
        yield* stopContext(ctx, undefined);
      });

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        yield* stopSessionContext(ctx);
      });

    // One background task: a shell left running (its id is the shell's) or a
    // subagent working on in the background (its id is the child session's).
    // The agent itself is not stopped, so a report the stop causes still
    // reaches it, as it would for any task that ended.
    const stopBackgroundTask: NonNullable<OpenCodeAdapterShape["stopBackgroundTask"]> = (
      threadId,
      taskId,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return false;
        const shell = ctx.backgroundShells.get(taskId);
        if (shell) {
          const location = { directory: ctx.directory };
          const status = yield* runOpenCode("shell.remove", (signal) =>
            ctx.client.shell.remove({ id: taskId, location }, { signal }),
          ).pipe(
            Effect.as<"completed" | "failed" | "stopped">("stopped"),
            // A shell whose exit never reached us (a dropped stream) can't be
            // removed: it is already over, and saying so ends its row.
            Effect.catch((error) =>
              runOpenCode("shell.get", (signal) =>
                ctx.client.shell.get({ id: taskId, location }, { signal }),
              ).pipe(
                Effect.map((found) =>
                  found.data.status === "running"
                    ? null
                    : found.data.exit === 0 || found.data.exit === undefined
                      ? ("completed" as const)
                      : ("failed" as const),
                ),
                Effect.catch((lookup) =>
                  Effect.succeed(
                    openCodeErrorTag(lookup) === "ShellNotFoundError" ? ("stopped" as const) : null,
                  ),
                ),
                Effect.flatMap((ended) =>
                  ended === null
                    ? Effect.fail(toRequestError("shell.remove")(error))
                    : Effect.succeed(ended),
                ),
              ),
            ),
          );
          // Nothing promises a shell.exited after a removal: whichever of the
          // two takes the shell out of the map first ends the task, once.
          if (ctx.backgroundShells.delete(taskId)) {
            ctx.releasedBackgroundShells.delete(taskId);
            ctx.shellCalls.delete(taskId);
            yield* emit({
              type: "task.completed",
              ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
              payload: {
                taskId: RuntimeTaskId.make(taskId),
                taskType: "local_bash",
                toolUseId: shell.callId,
                pendingCountManagedBySnapshot: true,
                status,
              },
            } as ProviderRuntimeEvent);
            yield* publishBackgroundTasks(ctx);
          }
          return true;
        }
        const child = ctx.children.get(taskId);
        if (!child || !child.background || child.status !== "running") return false;
        const invocation = child.callId;
        const result = yield* runOpenCode("session.interrupt", (signal) =>
          ctx.client.session.interrupt({ sessionID: child.sessionId }, { signal }),
        ).pipe(Effect.mapError(toRequestError("session.interrupt")));
        // Nothing was executing, so no interrupted event will end it. Not when
        // a later call took the child over meanwhile: that run is not stopped.
        if (!result.interrupted && child.callId === invocation) {
          yield* childEnded(ctx, child, { kind: "interrupted", reason: "user" });
        }
        return true;
      });

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const exits = yield* Effect.forEach(
          Array.from(sessions.values()),
          (ctx) => Effect.exit(stopSessionContext(ctx)),
          { concurrency: "unbounded" },
        );
        const firstFailure = exits.find(Exit.isFailure);
        if (firstFailure) {
          return yield* Effect.failCause(firstFailure.cause);
        }
      });

    /** What OpenCode still runs of the work a stop interrupted: problems, in words. */
    const workLeft = (work: NonNullable<ReturnType<typeof stoppedWork.get>>) =>
      Effect.gen(function* () {
        const active = yield* runOpenCode("session.active", (signal) =>
          work.client.session.active({ signal }),
        ).pipe(Effect.timeout(OPENCODE_CONFIRM_CALL_TIMEOUT));
        const runningShells = yield* Effect.forEach(
          work.shellIds,
          (id) =>
            runOpenCode("shell.get", (signal) =>
              work.client.shell.get({ id, location: { directory: work.directory } }, { signal }),
            ).pipe(
              Effect.map((shell) => (shell.data.status === "running" ? [id] : [])),
              // Removed: gone.
              Effect.catchIf(
                (error) => openCodeErrorStatus(error) === 404,
                () => Effect.succeed([]),
              ),
              Effect.timeout(OPENCODE_CONFIRM_CALL_TIMEOUT),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((ids) => ids.flat()));
        const busy = work.sessionIds.filter((id) => Object.hasOwn(active, id));
        return [
          ...(busy.length > 0 ? ["OpenCode still runs its work"] : []),
          ...(runningShells.length > 0
            ? [
                `OpenCode still runs ${runningShells.length} shell${runningShells.length === 1 ? "" : "s"} it started`,
              ]
            : []),
        ];
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed([`OpenCode's server didn't answer (${openCodeErrorDetail(error)})`]),
        ),
      );

    /**
     * Asks OpenCode whether the work a thread's stops interrupted has ended,
     * waiting a little for interrupts still settling. A thread that was idle
     * when it stopped left nothing to ask about.
     */
    /**
     * What OpenCode may still run for a session this process never ran (a
     * restart lost what its stop knew): its root session and their children,
     * and any shell running in its folder. Problems, in words.
     */
    const workLeftOnServer = (rootSessionId: string, directory: string | undefined) =>
      manager
        .withServer(({ server }) =>
          Effect.gen(function* () {
            const client = server.client;
            const call = <A>(method: string, run: (signal: AbortSignal) => Promise<A>) =>
              runOpenCode(method, run).pipe(Effect.timeout(OPENCODE_CONFIRM_CALL_TIMEOUT));
            const sessionIds = [rootSessionId];
            for (let index = 0; index < sessionIds.length && sessionIds.length < 200; index++) {
              const parentID = sessionIds[index]!;
              const children = yield* call("session.list", (signal) =>
                client.session.list({ parentID, limit: 100 }, { signal }),
              );
              sessionIds.push(...(children.data ?? []).map((child) => child.id));
            }
            const active = yield* call("session.active", (signal) =>
              client.session.active({ signal }),
            );
            const problems: string[] = [];
            if (sessionIds.some((id) => Object.hasOwn(active, id))) {
              problems.push("OpenCode still runs its work");
            }
            if (directory === undefined) {
              problems.push("its folder isn't known, so OpenCode's shells there can't be checked");
            } else {
              const shells = yield* call("shell.list", (signal) =>
                client.shell.list({ location: { directory } }, { signal }),
              );
              const running = shells.data.filter((shell) => shell.status === "running").length;
              if (running > 0) {
                problems.push(
                  `OpenCode still runs ${running} shell${running === 1 ? "" : "s"} in its folder`,
                );
              }
            }
            return problems;
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.succeed([`OpenCode's server didn't answer (${openCodeErrorDetail(error)})`]),
          ),
        );

    const confirmThreadStopped: NonNullable<OpenCodeAdapterShape["confirmThreadStopped"]> = (
      threadId,
      known,
    ) =>
      Effect.gen(function* () {
        const keys = [...stoppedWork.keys()].filter(
          (key) => parseSessionKey(key).threadId === threadId,
        );
        const problems: string[] = [];
        // Never confirmed on evidence a restart emptied: ask the server.
        for (const hint of known) {
          if (ranHere.has(hint.sessionKey) || stoppedWork.has(hint.sessionKey)) continue;
          const rootSessionId = parseOpenCodeResumeCursor(hint.resumeCursor)?.sessionId;
          if (rootSessionId === undefined) continue;
          problems.push(...(yield* workLeftOnServer(rootSessionId, hint.cwd)));
        }
        for (const key of keys) {
          const work = stoppedWork.get(key);
          if (work === undefined) continue;
          let left = yield* workLeft(work);
          for (let attempt = 1; left.length > 0 && attempt < OPENCODE_CONFIRM_ATTEMPTS; attempt++) {
            yield* Effect.sleep(OPENCODE_CONFIRM_RETRY);
            left = yield* workLeft(work);
          }
          if (left.length === 0) stoppedWork.delete(key);
          problems.push(...left);
        }
        return problems.length === 0
          ? ({ confirmed: true } as const)
          : ({ confirmed: false, reason: problems.join("; ") } as const);
      });

    const releaseBackgroundCommands: NonNullable<
      OpenCodeAdapterShape["releaseBackgroundCommands"]
    > = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        let released = false;
        for (const shellId of ctx.backgroundShells.keys()) {
          if (!ctx.releasedBackgroundShells.has(shellId)) {
            ctx.releasedBackgroundShells.add(shellId);
            released = true;
          }
        }
        if (released) {
          yield* publishBackgroundTasks(ctx);
        }
      });

    const readCommandOutput: NonNullable<OpenCodeAdapterShape["readCommandOutput"]> = (
      threadId,
      toolCallId,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return { status: "unavailable" } as const;
        const tool = ctx.tools.get(toolCallId);
        let shellId: string | undefined;
        for (const [id, shell] of ctx.backgroundShells) {
          if (shell.callId === toolCallId) {
            shellId = id;
            break;
          }
        }
        if (shellId === undefined && tool && !tool.done && tool.identity.kind === "shell") {
          for (const [id, callId] of ctx.shellCalls) {
            if (callId === toolCallId) {
              shellId = id;
              break;
            }
          }
        }
        if (shellId === undefined) {
          return {
            status:
              tool && !tool.done && tool.identity.kind === "shell" ? "pending" : "unavailable",
          } as const;
        }
        if (typeof ctx.client.shell?.output !== "function") {
          return { status: "unavailable" } as const;
        }
        const result = yield* runOpenCode(
          "shell.output",
          (signal) =>
            ctx.client.shell.output(
              { id: shellId, location: { directory: ctx.directory } },
              { signal },
            ),
          { timeoutMs: COMMAND_OUTPUT_TIMEOUT_MS },
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          const status = openCodeErrorStatus(result.failure);
          const tag = openCodeErrorTag(result.failure);
          return {
            status: status === 404 || tag === "ShellNotFoundError" ? "unavailable" : "pending",
          } as const;
        }
        const data = result.success.data;
        const output = typeof data?.output === "string" ? data.output : "";
        const totalBytes =
          typeof data?.size === "number" && Number.isSafeInteger(data.size) && data.size >= 0
            ? data.size
            : Buffer.byteLength(output, "utf8");
        return { status: "running", output, totalBytes } as const;
      });

    const noteExtensionsChanged: NonNullable<OpenCodeAdapterShape["noteExtensionsChanged"]> = () =>
      Effect.gen(function* () {
        mcpCacheVersion += 1;
        commandCacheVersion += 1;
        agentCache.clear();
        modelCache.clear();
        commandCache.clear();
        mcpServerCache.clear();
        const server = yield* manager.running;
        if (!server) return;
        if (typeof server.client.location?.reload === "function") {
          yield* runOpenCode("location.reload", (signal) =>
            server.client.location.reload({ signal }),
          ).pipe(Effect.ignore);
        }
        const activeSessions = Array.from(sessions.values()).filter((ctx) => !ctx.stopped);
        const dirsToReload = new Map<string, SessionContext>();
        for (const ctx of activeSessions) {
          if (!dirsToReload.has(ctx.directory)) dirsToReload.set(ctx.directory, ctx);
        }
        yield* Effect.all(
          [
            Effect.forEach(activeSessions, (ctx) => publishSessionCommands(ctx), {
              concurrency: "unbounded",
              discard: true,
            }),
            Effect.forEach(
              Array.from(dirsToReload.values()),
              (ctx) => loadMcpServers(ctx.client, ctx.directory, ctx.generation),
              { concurrency: "unbounded", discard: true },
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(runtimeEvents))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        manualContextCompaction: "supported",
        activeTurnSteering: "supported",
        nativeThreadFork: "supported",
        sessionOutlivesRuntime: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      compactContext,
      releaseBackgroundCommands,
      noteExtensionsChanged,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopBackgroundTask,
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()].map((ctx) => ({
            ...ctx.session,
            pendingBackgroundTaskCount:
              ctx.backgroundShells.size +
              [...ctx.children.values()].filter(
                (child) => child.background && child.status === "running",
              ).length,
          })),
        ),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.map(requireSession(threadId), (ctx) => ({
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: [] })),
        })),
      rollbackThread,
      deleteThread,
      readSubagentTranscript,
      readCommandOutput,
      stopAll,
      confirmThreadStopped,
      // One server runs every thread's agent, so its work can't be split.
      listProcesses: () =>
        manager.running.pipe(
          Effect.map((server) =>
            server?.pid ? [{ kind: "shared" as const, pid: server.pid }] : [],
          ),
        ),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies OpenCodeAdapterShape;
  });
}
