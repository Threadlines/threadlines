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
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ChatAttachment,
  EventId,
  type OpenCodeSettings,
  type ProviderApprovalDecision,
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
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  MANAGED_WORKTREE_INSTRUCTION,
  renderThreadContextSeed,
  withContextSeedPreamble,
} from "@threadlines/shared/contextSeed";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  mcpEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import { buildAgentPageInstructions } from "../../mcp/pageTools.ts";
import { ensurePageAssetsDir } from "../../pages/PageStore.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { isLinkedWorktreeCheckout } from "../../vcs/CheckoutPresence.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { FILE_LINK_INSTRUCTIONS } from "../fileLinkInstructions.ts";
import {
  type OpenCodeClient,
  type OpenCodeError,
  type OpenCodeModelRef,
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
  openCodePagesServerName,
  openCodeSessionGrantRules,
  openCodeSessionRules,
  openCodeThreadToolKey,
} from "../opencode/OpenCodeRules.ts";
import type {
  OpenCodeActiveServer,
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
/** How long a turn waits for the execution OpenCode starts to deliver steered input. */
const HELD_END_GRACE = Duration.seconds(5);
/** Lists (models, agents) are empty for a moment in a directory the server has not loaded yet. */
const CATALOG_RETRY_DEADLINE = Duration.seconds(5);
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
  /** The prompt that opened a user turn; also its fork and rollback boundary. */
  readonly promptId: string | undefined;
  /** Prompts and steers of ours OpenCode has not delivered yet. */
  readonly undelivered: Set<string>;
  /** When the turn began (epoch ms); history after it belongs to the turn. */
  readonly startedAt: number;
  executionStarted: boolean;
  stopRequested: boolean;
  heldEnd: Terminal | undefined;
  heldEndFiber: Fiber.Fiber<void> | undefined;
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

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly rootSessionId: string;
  readonly directory: string;
  readonly generation: number;
  readonly client: OpenCodeClient;
  readonly scope: Scope.Closeable;
  readonly toolKey: string;
  readonly roomTools: boolean;
  /** The page tools' image folder, when the session has them. */
  readonly agentPageAssetsDir: string | undefined;
  readonly runtimeMode: RuntimeMode;
  agent: string;
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
  silencedExecution: boolean;
  /** Reports from subagents the user stopped, withdrawn before they wake the agent. */
  readonly withdrawnReports: Set<string>;
  readonly turns: Array<{ readonly id: TurnId; readonly promptId: string | undefined }>;
  /** Rules currently on each owned OpenCode session (root and children). */
  readonly rules: Map<string, ReadonlyArray<OpenCodeRule>>;
  readonly children: Map<string, ChildAgent>;
  readonly stoppedChildren: Set<string>;
  readonly tools: Map<string, ToolCall>;
  readonly blocks: Map<string, Block>;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly approvalIds: Map<string, ApprovalRequestId>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly questionIds: Map<string, ApprovalRequestId>;
  readonly backgroundShells: Map<string, { readonly callId: string; readonly sessionId: string }>;
  /** Diff previews from approval requests, by tool call: `write` reports none when it succeeds. */
  readonly approvalPreviews: Map<string, unknown>;
  readonly shellCalls: Map<string, string>;
  compactionCount: number;
  readonly turnStartLock: Semaphore.Semaphore;
  /** Held while a steer is sent, so Stop withdraws it rather than racing it. */
  readonly steerLock: Semaphore.Semaphore;
  stopped: boolean;
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
    /** Every OpenCode session we own, root or child, to the thread it belongs to. */
    const owners = new Map<string, SessionContext>();
    /** Which session registered each Threadlines tool server, so a stale stop never removes a newer one. */
    const toolServerOwners = new Map<string, SessionContext>();
    const agentCache = new Map<string, ReadonlyArray<AgentInfo>>();
    const modelCache = new Map<string, ReadonlyArray<ModelInfo>>();
    const mcpServerCache = new Map<string, ReadonlyArray<string>>();
    const commandCache = new Map<string, ReadonlySet<string>>();

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

    const logNative = (ctx: SessionContext, event: OpenCodeEvent) =>
      nativeEventLogger
        ? Effect.flatMap(nowIso, (observedAt) =>
            nativeEventLogger.write(
              { observedAt, event: { provider: PROVIDER, method: event.type, payload: event } },
              ctx.threadId,
            ),
          ).pipe(Effect.ignore)
        : Effect.void;

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
        Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)), times: 20 }),
        Effect.timeoutOption(CATALOG_RETRY_DEADLINE),
        Effect.map((found) => (found._tag === "Some" ? found.value : [])),
        Effect.catch((error) => (error === "empty" ? Effect.succeed([]) : Effect.fail(error))),
      );

    const loadAgents = (client: OpenCodeClient, directory: string) =>
      Effect.gen(function* () {
        const cached = agentCache.get(directory);
        if (cached && cached.length > 0) return cached;
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
        if (agents.length > 0) agentCache.set(directory, agents);
        return agents;
      });

    const loadModels = (client: OpenCodeClient, directory: string) =>
      Effect.gen(function* () {
        const cached = modelCache.get(directory);
        if (cached && cached.length > 0) return cached;
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
        if (models.length > 0) modelCache.set(directory, models);
        return models;
      });

    const loadMcpServers = (client: OpenCodeClient, directory: string) =>
      runOpenCode("mcp.list", (signal) =>
        client.mcp.list({ location: { directory } }, { signal }),
      ).pipe(
        Effect.map((result) => (result.data ?? []).map((server) => server.name)),
        Effect.tap((names) => Effect.sync(() => mcpServerCache.set(directory, names))),
        Effect.orElseSucceed(() => mcpServerCache.get(directory) ?? []),
      );

    /** The project's slash commands (`/init`, `/review`, the user's own). */
    const loadCommands = (client: OpenCodeClient, directory: string) =>
      Effect.gen(function* () {
        const cached = commandCache.get(directory);
        if (cached) return cached;
        const names = yield* runOpenCode("command.list", (signal) =>
          client.command.list({ location: { directory } }, { signal }),
        ).pipe(
          Effect.map((result) => new Set((result.data ?? []).map((command) => command.name))),
          Effect.orElseSucceed(() => new Set<string>()),
        );
        if (names.size > 0) commandCache.set(directory, names);
        return names;
      });

    const contextLimitFor = (ctx: SessionContext, model: OpenCodeModelRef | undefined) =>
      Effect.gen(function* () {
        if (!model) return undefined;
        const models = yield* loadModels(ctx.client, ctx.directory).pipe(
          Effect.orElseSucceed(() => []),
        );
        return models.find(
          (candidate) =>
            candidate.ref.providerID === model.providerID && candidate.ref.id === model.id,
        )?.contextLimit;
      });

    const rulesFor = (ctx: SessionContext, agentId: string) =>
      Effect.gen(function* () {
        const agents = yield* loadAgents(ctx.client, ctx.directory).pipe(
          Effect.orElseSucceed(() => []),
        );
        return openCodeSessionRules({
          runtimeMode: ctx.runtimeMode,
          agentRules: agents.find((agent) => agent.id === agentId)?.rules ?? [],
          toolKey: ctx.toolKey,
          roomTools: ctx.roomTools,
          agentPages: ctx.agentPageAssetsDir !== undefined,
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
        if (block.kind === "text" && block.sessionId !== ctx.rootSessionId) {
          const child = ctx.children.get(block.sessionId);
          if (child && block.text.trim()) child.lastText = block.text.trim();
        }
        const summary = block.text.trim();
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
        const identity = identifyOpenCodeTool(name, mcpServerCache.get(ctx.directory) ?? []);
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

    const openApproval = (ctx: SessionContext, permission: OpenCodePermissionRequest) =>
      Effect.gen(function* () {
        if (ctx.approvalIds.has(permission.id)) return;
        const callId = permission.source?.id;
        if (callId && isRecord(permission.metadata) && Array.isArray(permission.metadata.files)) {
          ctx.approvalPreviews.set(callId, permission.metadata);
        }
        // Full access approves whatever OpenCode would ask; the user's own
        // denies never reach here, so they still hold.
        if (ctx.runtimeMode === "full-access") {
          const approved = yield* replyPermission(ctx, permission, "once").pipe(
            Effect.retry({ times: 1 }),
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("OpenCode auto-approval failed; asking the user", { error }).pipe(
                Effect.as(false),
              ),
            ),
          );
          // OpenCode waits on an unanswered request forever, so one we could
          // not answer is shown instead.
          if (approved) return;
        }
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

    const openQuestion = (ctx: SessionContext, form: OpenCodeForm) =>
      Effect.gen(function* () {
        if (ctx.questionIds.has(form.id)) return;
        if (!isOpenCodeQuestionForm(form)) {
          yield* runOpenCode("form.cancel", (signal) =>
            ctx.client.session.form.cancel(
              { sessionID: form.sessionID, formID: form.id, message: UNSUPPORTED_FORM_MESSAGE },
              { signal },
            ),
          ).pipe(
            Effect.retry({ times: 1 }),
            // A form nobody can answer or dismiss would hold the run forever.
            Effect.catch(() =>
              runOpenCode("session.interrupt", (signal) =>
                ctx.client.session.interrupt({ sessionID: form.sessionID }, { signal }),
              ).pipe(Effect.ignore),
            ),
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

    // ── Turns ────────────────────────────────────────────────────────────

    const finishTurn = (ctx: SessionContext, turn: ActiveTurn, terminal: Terminal) =>
      Effect.gen(function* () {
        if (ctx.activeTurn !== turn) return;
        if (turn.heldEndFiber) yield* Fiber.interrupt(turn.heldEndFiber);
        yield* closeBlocks(ctx, ctx.rootSessionId);
        yield* closeTools(ctx, ctx.rootSessionId, terminal.kind !== "succeeded");
        yield* dropPendingRequests(ctx, ctx.rootSessionId);
        ctx.activeTurn = undefined;
        ctx.turns.push({ id: turn.turnId, promptId: turn.promptId });
        const { activeTurnId: _active, ...session } = ctx.session;
        ctx.session = { ...session, status: "ready", updatedAt: yield* nowIso };
        const stopped =
          turn.stopRequested || (terminal.kind === "interrupted" && terminal.reason === "user");
        yield* emit({
          type: "turn.completed",
          ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
          payload:
            terminal.kind === "succeeded"
              ? { state: "completed" }
              : terminal.kind === "failed"
                ? { state: "failed", errorMessage: failureMessage(terminal) }
                : stopped || terminal.reason === "superseded"
                  ? { state: "interrupted", stopReason: terminal.reason ?? "user" }
                  : {
                      state: "failed",
                      stopReason: terminal.reason ?? null,
                      errorMessage:
                        terminal.reason === "inactivity"
                          ? "OpenCode stopped the run after an hour without activity."
                          : "OpenCode stopped the run before it finished.",
                    },
        });
        yield* Deferred.succeed(turn.done, undefined);
      });

    const beginTurn = (
      ctx: SessionContext,
      input: {
        readonly turnId: TurnId;
        readonly origin: ActiveTurn["origin"];
        readonly promptId?: string;
      },
    ) =>
      Effect.gen(function* () {
        const turn: ActiveTurn = {
          turnId: input.turnId,
          origin: input.origin,
          promptId: input.promptId,
          undelivered: new Set(input.promptId ? [input.promptId] : []),
          startedAt: Date.now(),
          executionStarted: false,
          stopRequested: false,
          heldEnd: undefined,
          heldEndFiber: undefined,
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
     * with the execution that did.
     */
    const holdTurnEnd = (ctx: SessionContext, turn: ActiveTurn, terminal: Terminal) =>
      Effect.gen(function* () {
        turn.heldEnd = terminal;
        turn.heldEndFiber = yield* Effect.gen(function* () {
          yield* Effect.sleep(HELD_END_GRACE);
          if (ctx.activeTurn !== turn || !turn.heldEnd) return;
          const inbox = yield* runOpenCode("session.inbox.list", (signal) =>
            ctx.client.session.inbox.list({ sessionID: ctx.rootSessionId }, { signal }),
          ).pipe(Effect.orElseSucceed(() => []));
          const stillQueued = inbox.some((item) => turn.undelivered.has(item.id));
          if (!stillQueued) {
            turn.undelivered.clear();
            // This fiber is the timer; finishTurn must not interrupt it.
            turn.heldEndFiber = undefined;
            yield* finishTurn(ctx, turn, turn.heldEnd);
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
            if (turn.heldEndFiber) yield* Fiber.interrupt(turn.heldEndFiber);
            turn.heldEndFiber = undefined;
          }
          return;
        }
        if (ctx.silenceNextWake || ctx.withdrawnReports.size > 0) {
          ctx.silenceNextWake = false;
          ctx.silencedExecution = true;
          yield* runOpenCode("session.interrupt", (signal) =>
            ctx.client.session.interrupt({ sessionID: ctx.rootSessionId }, { signal }),
          ).pipe(Effect.ignore);
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
        yield* rulesFor(ctx, event.data.agent ?? BUILD_AGENT).pipe(
          Effect.flatMap((rules) => applyRules(ctx, sessionId, rules)),
          Effect.catch((error) =>
            Effect.logWarning("Could not apply rules to an OpenCode subagent; stopping it", {
              error,
            }).pipe(
              Effect.andThen(
                runOpenCode("session.interrupt", (signal) =>
                  ctx.client.session.interrupt({ sessionID: sessionId }, { signal }),
                ).pipe(Effect.ignore),
              ),
            ),
          ),
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
              ...(child.agent ? { subagentType: child.agent } : {}),
              ...(typeof input.description === "string" ? { description: input.description } : {}),
            },
          } as ProviderRuntimeEvent);
        }
      });

    const childEnded = (ctx: SessionContext, child: ChildAgent, terminal: Terminal) =>
      Effect.gen(function* () {
        yield* closeBlocks(ctx, child.sessionId);
        yield* closeTools(ctx, child.sessionId, terminal.kind !== "succeeded");
        yield* dropPendingRequests(ctx, child.sessionId);
        const status: ChildAgent["status"] =
          terminal.kind === "succeeded"
            ? "completed"
            : terminal.kind === "failed"
              ? "failed"
              : "interrupted";
        if (child.status === status) return;
        child.status = status;
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
              status:
                status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
            },
          } as ProviderRuntimeEvent);
        }
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
            if (isRoot) yield* stopContext(ctx, "OpenCode deleted the session.");
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
              ).pipe(Effect.ignore);
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
                ctx.model = {
                  providerID: model.providerID,
                  id: model.id,
                  ...(model.variant ? { variant: model.variant } : {}),
                };
                ctx.contextLimit = yield* contextLimitFor(ctx, ctx.model);
              }
            }
            return;
          case "session.step.ended":
          case "session.step.failed": {
            const tokens = event.data.tokens;
            if (!isRoot || !tokens) return;
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
                  ...(ctx.contextLimit && ctx.contextLimit > 0
                    ? { maxTokens: ctx.contextLimit }
                    : {}),
                  compactsAutomatically: true,
                },
              },
            });
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
                ctx.backgroundShells.set(shellId, {
                  callId: tool.callId,
                  sessionId: tool.sessionId,
                });
                yield* emit({
                  type: "task.started",
                  ...(yield* eventBase(ctx, ctx.rootSessionId, tool.turnId)),
                  payload: {
                    taskId: RuntimeTaskId.make(shellId),
                    taskType: "local_bash",
                    toolUseId: tool.callId,
                    isBackgrounded: true,
                    ...(openCodeToolDetail(tool.identity, tool.input)
                      ? { description: openCodeToolDetail(tool.identity, tool.input)! }
                      : {}),
                  },
                } as ProviderRuntimeEvent);
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
            return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("OpenCode event handling failed", { type: event.type, cause }),
        ),
      );

    const handleShellExited = (event: OpenCodeEventOf<"shell.exited">) =>
      Effect.gen(function* () {
        for (const ctx of sessions.values()) {
          const shell = ctx.backgroundShells.get(event.data.id);
          if (!shell) continue;
          ctx.backgroundShells.delete(event.data.id);
          yield* emit({
            type: "task.completed",
            ...(yield* eventBase(ctx, ctx.rootSessionId, undefined)),
            payload: {
              taskId: RuntimeTaskId.make(event.data.id),
              taskType: "local_bash",
              toolUseId: shell.callId,
              status:
                event.data.exit === 0 || event.data.exit === undefined || event.data.exit === null
                  ? "completed"
                  : "failed",
            },
          } as ProviderRuntimeEvent);
        }
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
            if (
              tool.input === undefined &&
              state.input !== undefined &&
              typeof state.input !== "string"
            ) {
              tool.input = state.input;
            }
            if (state.status === "completed" || state.status === "error") {
              yield* toolFinished(ctx, tool, {
                failed: state.status === "error",
                ...(Array.isArray(state.content) ? { content: state.content } : {}),
                metadata: state.metadata,
                ...(isRecord(state.error) && typeof state.error.message === "string"
                  ? { error: state.error.message }
                  : {}),
              });
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
    const resync = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        const active = yield* runOpenCode("session.active", (signal) =>
          ctx.client.session.active({ signal }),
        ).pipe(Effect.option);
        if (active._tag === "None") return;
        const running = active.value;

        // Subagents spawned while we were away.
        const children = yield* runOpenCode("session.list", (signal) =>
          ctx.client.session.list({ parentID: ctx.rootSessionId, limit: 100 }, { signal }),
        ).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        );
        for (const child of children) {
          if (ctx.children.has(child.id)) continue;
          yield* childSpawned(ctx, {
            type: "session.created",
            data: {
              sessionID: child.id,
              parentID: ctx.rootSessionId,
              ...(child.title ? { title: child.title } : {}),
              ...(child.agent ? { agent: child.agent } : {}),
            },
          });
        }

        const since = turn?.startedAt ?? Date.now();
        for (const sessionId of [ctx.rootSessionId, ...ctx.children.keys()]) {
          if (turn) yield* backfillHistory(ctx, sessionId, since).pipe(Effect.ignore);
          const permissions = yield* runOpenCode("permission.list", (signal) =>
            ctx.client.permission.list({ sessionID: sessionId }, { signal }),
          ).pipe(Effect.orElseSucceed(() => []));
          for (const permission of permissions) {
            if (Array.isArray(permission.resources)) {
              yield* openApproval(ctx, permission as unknown as OpenCodePermissionRequest);
            }
          }
          const forms = yield* runOpenCode("form.list", (signal) =>
            ctx.client.session.form.list({ sessionID: sessionId }, { signal }),
          ).pipe(Effect.orElseSucceed(() => []));
          for (const form of forms) {
            if (Array.isArray((form as { fields?: unknown }).fields)) {
              yield* openQuestion(ctx, form as unknown as OpenCodeForm);
            }
          }
        }
        for (const child of ctx.children.values()) {
          if (child.status === "running" && !(child.sessionId in running)) {
            const outcome = yield* lastOutcome(ctx.client, child.sessionId);
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

        if (!turn || ctx.activeTurn !== turn || ctx.rootSessionId in running) return;
        // The run ended while we were not listening. Its idle marker, written
        // after the turn began, says how; none means it was lost.
        const recent = yield* runOpenCode("message.list", (signal) =>
          ctx.client.message.list(
            { sessionID: ctx.rootSessionId, limit: 50, order: "desc" },
            { signal },
          ),
        ).pipe(Effect.option);
        if (recent._tag === "None" || ctx.activeTurn !== turn) return;
        const idle = (recent.value.data as ReadonlyArray<unknown>).find(
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

    const handleSignal = (signal: OpenCodeServerSignal) =>
      Effect.gen(function* () {
        switch (signal._tag) {
          case "StreamOpened":
            for (const ctx of Array.from(sessions.values())) {
              if (ctx.generation === signal.generation && !ctx.stopped) yield* resync(ctx);
            }
            return;
          case "Malformed":
            return;
          case "ServerGone":
            // Stopping a context removes it from `sessions`; walk a copy.
            for (const ctx of Array.from(sessions.values())) {
              if (ctx.generation !== signal.generation) continue;
              yield* stopContext(ctx, signal.unexpected ? signal.detail : undefined);
            }
            return;
          case "Event": {
            const event = signal.event;
            if (event.type === "shell.exited") {
              yield* handleShellExited(event);
              return;
            }
            if (event.type === "session.created" && event.data.parentID) {
              const parent = owners.get(event.data.parentID);
              if (parent && parent.generation === signal.generation)
                yield* childSpawned(parent, event);
              return;
            }
            const sessionId = openCodeEventSessionId(event);
            const ctx = sessionId ? owners.get(sessionId) : undefined;
            if (ctx && ctx.generation === signal.generation && !ctx.stopped) {
              yield* handleEvent(ctx, event);
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
        sessions.delete(ctx.threadId);
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
          ...(ctx.roomTools
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
        ];
        for (const server of servers) {
          yield* runOpenCode("mcp.add", (signal) =>
            ctx.client.mcp.add(
              {
                server: server.name,
                location: { directory: ctx.directory },
                config: { type: "remote", url: server.url, headers, oauth: false, codemode: false },
              },
              { signal },
            ),
          );
          toolServerOwners.set(server.name, ctx);
          yield* Scope.addFinalizer(
            ctx.scope,
            Effect.suspend(() =>
              toolServerOwners.get(server.name) === ctx
                ? runOpenCode("mcp.remove", (signal) =>
                    ctx.client.mcp.remove(
                      { server: server.name, location: { directory: ctx.directory } },
                      { signal },
                    ),
                  ).pipe(
                    Effect.ignore,
                    Effect.ensuring(Effect.sync(() => toolServerOwners.delete(server.name))),
                  )
                : Effect.void,
            ),
          );
        }
        yield* loadMcpServers(ctx.client, ctx.directory);
      });

    const instructionsFor = (ctx: SessionContext, managedWorktree: boolean) =>
      [
        buildPreviewPanelInstructions("opencode", `${openCodeBrowserServerName(ctx.toolKey)}_`),
        ...(ctx.agentPageAssetsDir !== undefined
          ? [
              buildAgentPageInstructions({
                assetsDir: ctx.agentPageAssetsDir,
                toolPrefix: `${openCodePagesServerName(ctx.toolKey)}_`,
              }),
            ]
          : []),
        FILE_LINK_INSTRUCTIONS,
        ...(managedWorktree ? [MANAGED_WORKTREE_INSTRUCTION] : []),
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
        const messages = yield* listAllMessages(client, sourceSessionId);
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
        // /tmp) silently breaks its snapshots, so diffs and reverts.
        const directory = yield* fileSystem.realPath(input.cwd.trim()).pipe(
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
          const active: OpenCodeActiveServer = yield* manager.server.pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
          yield* active.streamReady.pipe(Effect.timeout(Duration.seconds(15)), Effect.ignore);
          const client = active.server.client;
          const roomTools = input.roomTools === true;
          // The page tools, with their image folder (OpenCode refuses side runtimes).
          const agentPageAssetsDir =
            input.agentPages === true
              ? yield* ensurePageAssetsDir(parseSessionKey(input.threadId).threadId).pipe(
                  Effect.map((dir): string | undefined => dir),
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
          const boundSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = resolveModel(boundSelection);

          const resumeId = parseOpenCodeResumeCursor(input.resumeCursor)?.sessionId;
          let rootSessionId: string | undefined;
          let resumed = false;
          if (resumeId) {
            const found = yield* runOpenCode("session.get", (signal) =>
              client.session.get({ sessionID: resumeId }, { signal }),
            ).pipe(Effect.option);
            if (found._tag === "Some") {
              rootSessionId = found.value.id;
              resumed = true;
              // A checkout switch resumes the same conversation somewhere
              // else; OpenCode keeps working wherever the session is.
              if (found.value.location?.directory !== directory) {
                yield* runOpenCode("session.move", (signal) =>
                  client.session.move({ sessionID: rootSessionId!, directory }, { signal }),
                ).pipe(Effect.mapError(toRequestError("session.move")));
              }
            } else if (input.resumePolicy === "required") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.get",
                detail: `OpenCode no longer has session ${resumeId}.`,
              });
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
          }

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
              ...(roomTools ? { roomTools: true } : {}),
              createdAt: yield* nowIso,
              updatedAt: yield* nowIso,
            },
            rootSessionId,
            directory,
            generation: active.generation,
            client,
            scope,
            toolKey: openCodeThreadToolKey(input.threadId),
            roomTools,
            agentPageAssetsDir,
            runtimeMode: input.runtimeMode,
            agent: BUILD_AGENT,
            model,
            contextLimit: undefined,
            pendingSeed:
              !resumed && input.contextSeed !== undefined && input.forkFrom === undefined
                ? renderThreadContextSeed(input.contextSeed)
                : undefined,
            activeTurn: undefined,
            silenceNextWake: false,
            silencedExecution: false,
            withdrawnReports: new Set(),
            turns: [],
            rules: new Map(),
            children: new Map(),
            stoppedChildren: new Set(),
            tools: new Map(),
            blocks: new Map(),
            approvals: new Map(),
            approvalIds: new Map(),
            questions: new Map(),
            questionIds: new Map(),
            backgroundShells: new Map(),
            approvalPreviews: new Map(),
            shellCalls: new Map(),
            compactionCount: 0,
            turnStartLock: yield* Semaphore.make(1),
            steerLock: yield* Semaphore.make(1),
            stopped: false,
          };

          // The browser panel (and, in a room, the room tools), on a
          // credential that names this thread and dies with this context.
          const credential = yield* mcpSessionRegistry.credentialFor({
            sessionKey: input.threadId,
            browser: true,
            room: roomTools,
            pages: agentPageAssetsDir !== undefined,
          });
          yield* Scope.addFinalizer(
            scope,
            mcpSessionRegistry.revoke(input.threadId, credential.generation),
          );
          yield* registerToolServers(ctx, credential).pipe(
            Effect.mapError(toRequestError("mcp.add")),
          );

          yield* applyRules(ctx, rootSessionId, yield* rulesFor(ctx, BUILD_AGENT)).pipe(
            Effect.mapError(toRequestError("session.update")),
          );
          if (resumed || input.forkFrom) {
            const info = yield* runOpenCode("session.get", (signal) =>
              client.session.get({ sessionID: rootSessionId! }, { signal }),
            ).pipe(Effect.option);
            if (info._tag === "Some") {
              ctx.agent = info.value.agent ?? BUILD_AGENT;
              if (!model && info.value.model) {
                ctx.model = {
                  providerID: info.value.model.providerID,
                  id: info.value.model.id,
                  ...(info.value.model.variant ? { variant: info.value.model.variant } : {}),
                };
              }
            }
            if (model) {
              yield* runOpenCode("session.switchModel", (signal) =>
                client.session.switchModel({ sessionID: rootSessionId!, model }, { signal }),
              ).pipe(Effect.mapError(toRequestError("session.switchModel")));
            }
          }
          ctx.contextLimit = yield* contextLimitFor(ctx, ctx.model);
          const managedWorktree = yield* isLinkedWorktreeCheckout(directory).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          yield* runOpenCode("instructions.put", (signal) =>
            client.session.instructions.entry.put(
              {
                sessionID: rootSessionId!,
                key: "threadlines",
                value: instructionsFor(ctx, managedWorktree),
              },
              { signal },
            ),
          ).pipe(Effect.mapError(toRequestError("instructions.put")));
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
          owners.set(rootSessionId, ctx);

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
          return ctx.session;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    /** Text and attachments as an OpenCode prompt; images and files travel inline. */
    const promptContent = (
      threadId: ThreadId,
      input: {
        readonly input?: string | undefined;
        readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const files: Array<{ uri: string; name?: string }> = [];
        for (const attachment of input.attachments ?? []) {
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
          files.push({
            uri: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            name: attachment.name,
          });
        }
        const text = input.input?.trim() ?? "";
        if (!text && files.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Turn for ${threadId} requires text or attachments.`,
          });
        }
        return { text, files };
      });

    const switchAgent = (ctx: SessionContext, agent: string) =>
      Effect.gen(function* () {
        if (ctx.agent === agent) return;
        const agents = yield* loadAgents(ctx.client, ctx.directory).pipe(
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
        yield* applyRules(ctx, ctx.rootSessionId, yield* rulesFor(ctx, agent)).pipe(
          Effect.mapError(toRequestError("session.update")),
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
            yield* switchAgent(ctx, input.interactionMode === "plan" ? PLAN_AGENT : BUILD_AGENT);
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
            const command = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(content.text);
            const commands = command ? yield* loadCommands(ctx.client, ctx.directory) : undefined;
            if (command && commands?.has(command[1]!)) {
              const turn = yield* beginTurn(ctx, {
                turnId: TurnId.make(`cmd_${(yield* randomUUIDv4).replaceAll("-", "")}`),
                origin: "user",
              });
              const sent = yield* runOpenCode("session.command", (signal) =>
                ctx.client.session.command(
                  {
                    sessionID: ctx.rootSessionId,
                    name: command[1]!,
                    text: command[2]?.trim() ?? "",
                    ...(content.files.length > 0 ? { files: content.files } : {}),
                    ...(skills.length > 0 ? { skills } : {}),
                    delivery: "steer",
                  },
                  { signal },
                ),
              ).pipe(Effect.exit);
              if (Exit.isFailure(sent)) {
                yield* finishTurn(ctx, turn, {
                  kind: "failed",
                  message: `OpenCode could not run /${command[1]}: ${String(sent.cause)}`,
                  type: undefined,
                });
              }
              return {
                threadId: input.threadId,
                turnId: turn.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }

            const promptId = openCodePromptId(input.messageId, yield* randomUUIDv4);
            const turn = yield* beginTurn(ctx, {
              turnId: TurnId.make(promptId),
              origin: "user",
              promptId,
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
              yield* finishTurn(ctx, turn, {
                kind: "failed",
                message: `OpenCode did not accept the message: ${String(sent.cause)}`,
                type: undefined,
              });
            } else {
              ctx.pendingSeed = undefined;
            }
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
        const notRunning = new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "steerTurn",
          issue: "No running turn to add this message to.",
        });
        const turn = ctx.activeTurn;
        if (!turn || turn.turnId !== input.expectedTurnId || turn.stopRequested) {
          return yield* notRunning;
        }
        const content = yield* promptContent(input.threadId, input);
        const promptId = openCodePromptId(input.messageId, yield* randomUUIDv4);
        return yield* ctx.steerLock.withPermit(
          Effect.gen(function* () {
            // The turn may have ended or been stopped while the attachments
            // were read; a steer must never start work after either.
            if (ctx.activeTurn !== turn || turn.stopRequested) return yield* notRunning;
            turn.undelivered.add(promptId);
            yield* runOpenCode("session.prompt", (signal) =>
              ctx.client.session.prompt(
                {
                  sessionID: ctx.rootSessionId,
                  id: promptId,
                  text: content.text,
                  ...(content.files.length > 0 ? { files: content.files } : {}),
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
            { discard: true },
          ),
        );
        // Withdrawing the last queued steer can end a held turn, and a send
        // waiting on it then starts the next one: that one is not ours to stop.
        if (turn && ctx.activeTurn !== turn) return;
        for (const child of ctx.children.values()) {
          if (child.status !== "running") continue;
          ctx.stoppedChildren.add(child.sessionId);
          yield* runOpenCode("session.interrupt", (signal) =>
            ctx.client.session.interrupt({ sessionID: child.sessionId }, { signal }),
          ).pipe(Effect.ignore);
        }
        yield* dropPendingRequests(ctx, undefined);
        const result = yield* runOpenCode("session.interrupt", (signal) =>
          ctx.client.session.interrupt({ sessionID: ctx.rootSessionId, resume: false }, { signal }),
        ).pipe(Effect.mapError(toRequestError("session.interrupt")));
        if (!turn || ctx.activeTurn !== turn) return;
        if (!result.interrupted) {
          // Nothing was running: the prompt was still queued, or the end
          // event is on its way. Either way the turn is over.
          yield* finishTurn(ctx, turn, { kind: "interrupted", reason: "user" });
          return;
        }
        yield* Effect.gen(function* () {
          yield* Effect.sleep(STOP_SETTLE_TIMEOUT);
          if (ctx.activeTurn !== turn) return;
          const active = yield* runOpenCode("session.active", (signal) =>
            ctx.client.session.active({ signal }),
          ).pipe(Effect.option);
          // The turn may have ended (and the next begun) while we asked.
          if (ctx.activeTurn !== turn) return;
          // Only OpenCode saying it is idle ends the turn; a failed check
          // proves nothing, so the turn stays open and the stop is repeated.
          if (active._tag === "Some" && !(ctx.rootSessionId in active.value)) {
            yield* finishTurn(ctx, turn, { kind: "interrupted", reason: "user" });
            return;
          }
          yield* emit({
            type: "runtime.warning",
            ...(yield* eventBase(ctx, ctx.rootSessionId, turn.turnId)),
            payload: { message: "OpenCode has not stopped yet; asking it again." },
          } as ProviderRuntimeEvent);
          yield* runOpenCode("session.interrupt", (signal) =>
            ctx.client.session.interrupt({ sessionID: ctx.rootSessionId }, { signal }),
          ).pipe(Effect.ignore);
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
            // grant lives on this session only.
            const current = ctx.rules.get(permission.sessionID) ?? [];
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
        yield* runOpenCode("session.compact", (signal) =>
          ctx.client.session.compact({ sessionID: ctx.rootSessionId }, { signal }),
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
              const identity = identifyOpenCodeTool(String(part.name));
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

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        // Release OpenCode's claim on running executions, so the user's own
        // OpenCode service never resumes them later, and stop background work
        // nobody would be listening to: it would wake an agent no one sees.
        const running = [
          ...(ctx.activeTurn ? [ctx.rootSessionId] : []),
          ...[...ctx.children.values()]
            .filter((child) => child.status === "running")
            .map((child) => child.sessionId),
        ];
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

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.forEach([...sessions.keys()], stopSession, { discard: true });

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
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      compactContext,
      respondToRequest,
      respondToUserInput,
      stopSession,
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
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies OpenCodeAdapterShape;
  });
}
