/**
 * PiAdapter — `ProviderAdapterShape` for Pi over `pi --mode rpc` (JSONL over
 * stdio). Design: docs/providers/pi-plan.md.
 *
 * One Pi process per thread, with the Threadlines extension loaded. The
 * extension gates tool calls by access level and plan mode, bridges
 * Threadlines' tool servers, and takes two commands from the adapter:
 * `/threadlines-mode` (live access and plan changes) and `/threadlines-turn`
 * (a marker before each user turn, which revert and fork cut at).
 *
 * How Pi's model maps onto Threadlines turns:
 *
 * - A turn is sent as `prompt` with `streamingBehavior: "steer"`; a steer is
 *   the same command while the turn runs. Pi folds a steer into the running
 *   run.
 * - A turn ends only when Pi is idle: its prompt was acknowledged, none of
 *   its dialogs is open, and `get_state` reports nothing streaming,
 *   compacting or queued. That is checked on every `agent_settled` and after
 *   every ack (an extension command can start work and still ack `handled`).
 * - An `agent_start` with no turn open is a turn Pi started itself.
 * - Pi's session can be replaced in-process (fork, clone), which re-runs
 *   extensions without the settings the extension removed from its
 *   environment. So every session change restarts the process with
 *   `--session` on the new file.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  type ChatAttachment,
  type ChatSkillReference,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  type ProviderFailureCategory,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ServerProviderModel,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  MANAGED_WORKTREE_INSTRUCTION,
  renderThreadContextSeed,
  withContextSeedPreamble,
} from "@threadlines/shared/contextSeed";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- hashing instruction text for a file name.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path arithmetic.
import * as NodePath from "node:path";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  mcpCommandsEndpointUrl,
  mcpEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import {
  buildCommandRequestInstructions,
  COMMANDS_MCP_SERVER_NAME,
} from "../../mcp/commandTools.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { buildAgentPageInstructions, PAGES_MCP_SERVER_NAME } from "../../mcp/pageTools.ts";
import { ROOM_MCP_SERVER_NAME } from "../../mcp/roomToolAccess.ts";
import { buildScheduleInstructions } from "../../mcp/scheduleTools.ts";
import { ensurePageAssetsDir } from "../../pages/PageStore.ts";
import { isLinkedWorktreeCheckout } from "../../vcs/CheckoutPresence.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  steerRejectedError,
} from "../Errors.ts";
import { buildFileAttachmentNote } from "../fileAttachmentPrompt.ts";
import { FILE_LINK_INSTRUCTIONS } from "../fileLinkInstructions.ts";
import {
  makePiResumeCursor,
  parsePiResumeCursor,
  piTurnBoundaries,
  planPiFork,
  planPiRevert,
} from "../pi/PiCursor.ts";
import {
  parsePiApprovalTitle,
  PI_APPROVAL_OPTIONS,
  PI_EXTENSION_SOURCE,
  PI_MODE_COMMAND,
  PI_PLAN_MODE_REASON,
  PI_TURN_COMMAND,
  type PiApprovalRequest,
  piExtensionFileName,
  piModeCommandText,
  piTurnCommandText,
  type PiTurnMark,
} from "../pi/PiExtensionSource.ts";
import {
  type PiAccessLevel,
  piAccessLevel,
  type PiLaunch,
  parsePiLaunchArgs,
  piProcessArgs,
  piProcessEnvironment,
  type PiSessionTarget,
  type PiToolServer,
} from "../pi/PiLaunch.ts";
import { PI_PROMPT_REFUSED_PREFIX, piTurnFailure } from "../pi/PiFailure.ts";
import { removePiSecretsFile, writePiSecretsFile } from "../pi/PiSecrets.ts";
import {
  decodePi,
  parsePiModelSlug,
  piModelSlug,
  PI_DIALOG_METHODS,
  PiAgentSettled,
  PiAutoRetryEnd,
  PiAutoRetryStart,
  PiCommands,
  PiCompactionEnd,
  PiCompactionStart,
  PiEntries,
  PiExtensionError,
  PiExtensionUiRequest,
  type PiExtensionUiRequest as PiDialog,
  PiForkResult,
  PiMessageEvent,
  PiMessageUpdate,
  PiModel,
  PiSessionStats,
  PiState,
  PiToolExecution,
  type PiUsage,
  piContentText,
} from "../pi/PiProtocol.ts";
import {
  describePiExit,
  type PiRecord,
  type PiRpc,
  type PiRpcError,
  startPiRpc,
} from "../pi/PiRpc.ts";
import {
  identifyPiTool,
  piCommandOutput,
  piToolData,
  piToolDetail,
  type PiToolIdentity,
} from "../pi/PiToolItems.ts";
import { buildPreviewPanelInstructions } from "../previewPanelInstructions.ts";
import { withFailureCategory } from "../providerFailureCategory.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");
/** Pieces of a message or a tool's output; `message_end` and `tool_execution_end` carry them whole. */
const PI_STREAM_FRAGMENT_TYPES: ReadonlySet<string> = new Set([
  "message_update",
  "tool_execution_update",
]);
/** How long each Stop step waits before the next, harder one. */
const STOP_STEP_TIMEOUT = Duration.seconds(5);
/** Pi's own terminal commands make no sense in Threadlines; ours are internal. */
const HIDDEN_COMMAND_SOURCES = new Set(["builtin"]);

interface PiModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  /** How to run Pi, looked up for each process and held for as long as it runs. */
  readonly launch: PiLaunch;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  /** The server's environment; tests pass their own. */
  readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
  /** Where the extension and instruction files are written (Threadlines' data folder). */
  readonly extensionDir: string;
  /** The provider's current model list, for effort validation. */
  readonly models: () => ReadonlyArray<ServerProviderModel>;
  /**
   * The model Pi's own settings name, from the last status check: what "Pi
   * default" means for a thread that doesn't know its own (one forked from
   * another, or opened from an older cursor).
   */
  readonly defaultModel?: (() => PiModelRef | undefined) | undefined;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  /** Starts a Pi process; tests pass a scripted one. */
  readonly startRpc?: typeof startPiRpc | undefined;
}

type Terminal =
  | { readonly kind: "completed" }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly category?: ProviderFailureCategory | undefined;
    }
  | { readonly kind: "interrupted"; readonly reason: string };

interface ProcessState {
  readonly generation: number;
  readonly rpc: PiRpc;
  readonly scope: Scope.Closeable;
  readonly nonce: string;
  /** What the extension currently enforces. */
  access: PiAccessLevel;
  plan: boolean;
  /** Pi's model at launch: what "Pi default" means when no check has said. */
  readonly baselineModel: PiModelRef | undefined;
  /** Closed on purpose: its exit is not a failure. */
  closing: boolean;
  /**
   * Prompts whose ack hasn't come back: an extension command holds its ack
   * until its handler is done, and a turn isn't over while one runs.
   */
  pendingPrompts: number;
  /** Records the consumer has finished handling (see `PiRpc.recordCount`). */
  processedRecords: number;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly origin: "user" | "provider";
  readonly plan: boolean;
  readonly done: Deferred.Deferred<void>;
  stopRequested: boolean;
  /** The prompt's ack has not come back yet (an extension command can hold it). */
  promptPending: boolean;
  /** The last model error, cleared when a retry succeeds. */
  failure: string | undefined;
  /** The latest assistant text, for a plan turn's proposed plan. */
  finalText: string | undefined;
  messageCount: number;
  /** An idle check found events still unhandled: check again once they are. */
  recheck: boolean;
}

interface MessageState {
  readonly itemId: RuntimeItemId;
  readonly reasoningItemId: RuntimeItemId;
  readonly turnId: TurnId;
  text: string;
  textStarted: boolean;
  reasoning: string;
  reasoningStarted: boolean;
}

interface ToolState {
  readonly itemId: RuntimeItemId;
  readonly turnId: TurnId | undefined;
  readonly name: string;
  readonly identity: PiToolIdentity;
  args: unknown;
  streamed: string;
  completed: boolean;
  /** `write`: whether its file was there when the call started; unknown counts as there. */
  existedBefore: boolean | undefined;
}

interface PendingDialog {
  readonly requestId: ApprovalRequestId;
  readonly dialog: PiDialog;
  readonly turnId: TurnId | undefined;
  /** Set for a Threadlines approval; otherwise a question from an extension. */
  readonly approval: PiApprovalRequest | undefined;
  readonly requestType: CanonicalRequestType;
  readonly itemId: RuntimeItemId | undefined;
}

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly runtimeMode: RuntimeMode;
  readonly roomTools: boolean;
  readonly agentPageAssetsDir: string | undefined;
  readonly commandRequests: boolean;
  readonly managedWorktree: boolean;
  readonly mcpToken: string;
  readonly launchArgs: ReadonlyArray<string>;
  readonly instructionsPath: string;
  sessionFile: string;
  proc: ProcessState | undefined;
  nextGeneration: number;
  /** The model in effect (`provider/id`). */
  model: string | undefined;
  /** What "Pi default" means for this thread (see `PiResumeCursor.defaultModel`). */
  defaultModel: PiModelRef | undefined;
  thinkingLevel: string | undefined;
  contextWindow: number | undefined;
  pendingSeed: string | undefined;
  activeTurn: ActiveTurn | undefined;
  /** The latest turn, running or finishing: its `done` resolves after its end marker. */
  lastTurn: ActiveTurn | undefined;
  /** Turns whose "reverted" marker couldn't be written yet; retried before the next turn. */
  readonly pendingTombstones: Array<TurnId>;
  message: MessageState | undefined;
  readonly tools: Map<string, ToolState>;
  readonly dialogs: Map<ApprovalRequestId, PendingDialog>;
  readonly dialogIds: Map<string, ApprovalRequestId>;
  readonly turns: Array<{ readonly id: TurnId }>;
  readonly lifecycle: Semaphore.Semaphore;
  stopped: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A record as logs and events keep it. Approval titles carry the process's
 * nonce, which must stay between Threadlines and Pi: logs are files the agent
 * can read.
 */
function withoutNonce<T extends Readonly<Record<string, unknown>>>(record: T, nonce: string): T {
  return typeof record.title === "string" && record.title.includes(nonce)
    ? { ...record, title: record.title.replaceAll(nonce, "[nonce]") }
    : record;
}

const errorText = (error: unknown) =>
  error instanceof Error && error.message ? error.message : String(error);

/** The approval type a gated tool call shows as. */
function requestTypeForTool(toolName: string): CanonicalRequestType {
  switch (identifyPiTool(toolName).kind) {
    case "shell":
      return "command_execution_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

/** Skills the user picked, as Pi skill blocks after the message. */
const skillBlock = (skill: ChatSkillReference, body: string) =>
  `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${NodePath.dirname(skill.path)}.\n\n${body.trim()}\n</skill>`;

const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");

export function makePiAdapter(options: PiAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const boundInstanceId = options.instanceId;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();
    const startRpc = options.startRpc ?? startPiRpc;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const stamp = Effect.all({
      eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
      createdAt: nowIso,
    });
    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const eventBase = (ctx: SessionContext, turnId: TurnId | undefined) =>
      Effect.map(stamp, (s) => ({
        ...s,
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
      }));

    const logNative = (ctx: SessionContext, proc: ProcessState, record: PiRecord) =>
      options.nativeEventLogger
        ? Effect.flatMap(nowIso, (observedAt) =>
            options.nativeEventLogger!.write(
              {
                observedAt,
                event: {
                  provider: PROVIDER,
                  method: record.type,
                  payload: withoutNonce(record, proc.nonce),
                },
              },
              ctx.threadId,
              { streamFragment: PI_STREAM_FRAGMENT_TYPES.has(record.type) },
            ),
          ).pipe(Effect.ignore)
        : Effect.void;

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const requestError = (method: string) => (error: PiRpcError) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: error.detail,
        code: error.kind,
        cause: error,
      });

    const requireProcess = (ctx: SessionContext, method: string) =>
      ctx.proc && !ctx.proc.closing
        ? Effect.succeed(ctx.proc)
        : Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Pi is not running for this thread.",
            }),
          );

    const piRequest = (
      ctx: SessionContext,
      command: { readonly type: string; readonly [key: string]: unknown },
      requestOptions?: { readonly timeout?: Duration.Input | null },
    ) =>
      Effect.flatMap(requireProcess(ctx, command.type), (proc) =>
        proc.rpc.request(command, requestOptions).pipe(Effect.mapError(requestError(command.type))),
      );

    // ── Files ────────────────────────────────────────────────────────────

    const writePrivateFile = (path: string, content: string) =>
      Effect.gen(function* () {
        if (yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false))) return;
        yield* fileSystem.makeDirectory(NodePath.dirname(path), { recursive: true });
        // Unique per write: two sessions starting at once may both write the file.
        const staging = `${path}.${yield* randomUUIDv4}.tmp`;
        yield* fileSystem.writeFileString(staging, content, { mode: 0o600 });
        yield* fileSystem.rename(staging, path);
      });

    const extensionPath = NodePath.join(options.extensionDir, piExtensionFileName());
    const ensureExtension = (threadId: ThreadId) =>
      writePrivateFile(extensionPath, PI_EXTENSION_SOURCE).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Could not write the Threadlines extension for Pi: ${cause.message}`,
              cause,
            }),
        ),
      );

    const instructionsFor = (input: {
      readonly agentPageAssetsDir: string | undefined;
      readonly commandRequests: boolean;
      readonly scheduleTools: boolean;
      readonly managedWorktree: boolean;
    }) =>
      [
        buildPreviewPanelInstructions("pi", `mcp__${BROWSER_MCP_SERVER_NAME}__`),
        ...(input.agentPageAssetsDir !== undefined
          ? [buildAgentPageInstructions({ assetsDir: input.agentPageAssetsDir })]
          : []),
        ...(input.commandRequests
          ? [buildCommandRequestInstructions({ toolPrefix: `mcp__${COMMANDS_MCP_SERVER_NAME}__` })]
          : []),
        ...(input.scheduleTools
          ? [buildScheduleInstructions({ toolPrefix: `mcp__${ROOM_MCP_SERVER_NAME}__` })]
          : []),
        FILE_LINK_INSTRUCTIONS,
        ...(input.managedWorktree ? [MANAGED_WORKTREE_INSTRUCTION] : []),
      ].join("\n\n");

    const toolServers = (ctx: {
      readonly roomTools: boolean;
      readonly agentPageAssetsDir: string | undefined;
      readonly commandRequests: boolean;
    }): ReadonlyArray<PiToolServer> => [
      { name: BROWSER_MCP_SERVER_NAME, url: mcpEndpointUrl(serverConfig.port) },
      ...(ctx.roomTools
        ? [{ name: ROOM_MCP_SERVER_NAME, url: mcpRoomEndpointUrl(serverConfig.port) }]
        : []),
      ...(ctx.agentPageAssetsDir !== undefined
        ? [{ name: PAGES_MCP_SERVER_NAME, url: mcpPagesEndpointUrl(serverConfig.port) }]
        : []),
      ...(ctx.commandRequests
        ? [{ name: COMMANDS_MCP_SERVER_NAME, url: mcpCommandsEndpointUrl(serverConfig.port) }]
        : []),
    ];

    // ── Turns ────────────────────────────────────────────────────────────

    const beginTurn = (
      ctx: SessionContext,
      input: {
        readonly turnId: TurnId;
        readonly origin: ActiveTurn["origin"];
        readonly plan: boolean;
        readonly promptPending: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const turn: ActiveTurn = {
          turnId: input.turnId,
          origin: input.origin,
          plan: input.plan,
          done: yield* Deferred.make<void>(),
          stopRequested: false,
          promptPending: input.promptPending,
          failure: undefined,
          finalText: undefined,
          messageCount: 0,
          recheck: false,
        };
        ctx.activeTurn = turn;
        ctx.lastTurn = turn;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turn.turnId,
          updatedAt: yield* nowIso,
        };
        yield* emit({
          type: "turn.started",
          ...(yield* eventBase(ctx, turn.turnId)),
          payload: ctx.model ? { model: ctx.model } : {},
        });
        return turn;
      });

    const closeMessage = (ctx: SessionContext, failed: boolean) =>
      Effect.gen(function* () {
        const message = ctx.message;
        if (!message) return;
        ctx.message = undefined;
        const base = yield* eventBase(ctx, message.turnId);
        if (message.reasoningStarted) {
          yield* emit({
            type: "item.completed",
            ...base,
            itemId: message.reasoningItemId,
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Thinking",
              ...(message.reasoning.trim() ? { data: { summary: message.reasoning.trim() } } : {}),
            },
          });
        }
        if (message.textStarted) {
          const text = message.text.trim();
          yield* emit({
            type: "item.completed",
            ...base,
            itemId: message.itemId,
            payload: {
              itemType: "assistant_message",
              status: failed && !text ? "failed" : "completed",
              ...(text ? { detail: text.slice(0, 4_000) } : {}),
            },
          });
        }
      });

    /** Ends a tool row a turn left open, so no row spins forever. */
    const closeOpenTools = (ctx: SessionContext, turnId: TurnId, failed: boolean) =>
      Effect.forEach(
        [...ctx.tools.values()].filter((state) => state.turnId === turnId && !state.completed),
        (state) =>
          Effect.gen(function* () {
            state.completed = true;
            yield* emit({
              type: "item.completed",
              ...(yield* eventBase(ctx, turnId)),
              itemId: state.itemId,
              payload: {
                itemType: state.identity.itemType,
                status: failed ? "failed" : "completed",
                title: state.identity.title,
              },
            });
          }),
        { discard: true },
      );

    const dropPendingDialogs = (ctx: SessionContext, onlyTurn?: TurnId): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [requestId, pending] of Array.from(ctx.dialogs)) {
          if (onlyTurn !== undefined && pending.turnId !== onlyTurn) continue;
          // Pi gets a cancel, so a blocked hook or command never waits forever.
          if (ctx.proc && !ctx.proc.closing) {
            yield* ctx.proc.rpc.send({
              type: "extension_ui_response",
              id: pending.dialog.id,
              cancelled: true,
            });
          }
          yield* resolveDialog(ctx, requestId, pending.approval ? "cancel" : undefined);
        }
      });

    const finishTurn = (
      ctx: SessionContext,
      turn: ActiveTurn,
      terminal: Terminal,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (ctx.activeTurn !== turn) return;
        yield* closeMessage(ctx, terminal.kind !== "completed");
        yield* closeOpenTools(ctx, turn.turnId, terminal.kind !== "completed");
        yield* dropPendingDialogs(ctx, turn.turnId);
        // Once the turn stops being active its completion is published, even
        // if the process closes meanwhile (a revert restarting Pi).
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            ctx.activeTurn = undefined;
            ctx.turns.push({ id: turn.turnId });
            const { activeTurnId: _active, ...session } = ctx.session;
            ctx.session = { ...session, status: "ready", updatedAt: yield* nowIso };
            if (turn.plan && terminal.kind === "completed" && turn.finalText?.trim()) {
              yield* emit({
                type: "turn.proposed.completed",
                ...(yield* eventBase(ctx, turn.turnId)),
                payload: { planMarkdown: turn.finalText.trim() },
              });
            }
            yield* emit({
              type: "turn.completed",
              ...(yield* eventBase(ctx, turn.turnId)),
              payload:
                terminal.kind === "completed"
                  ? { state: "completed" }
                  : terminal.kind === "failed"
                    ? {
                        state: "failed",
                        errorMessage: terminal.message,
                        ...withFailureCategory(terminal.category),
                      }
                    : { state: "interrupted", stopReason: terminal.reason },
            });
            // Said as a runtime error too, the way other agents say theirs: the
            // chat reads the error it shows for whether signing in fixes it, so a
            // refused key offers Sign in and a later, different failure doesn't.
            // After the turn's end and outside it, so the end is seen as a turn
            // ending (requests tied to the turn close) and the session keeps no
            // active turn.
            if (terminal.kind === "failed") {
              yield* emit({
                type: "runtime.error",
                ...(yield* eventBase(ctx, undefined)),
                payload: {
                  message: terminal.message,
                  class: terminal.category === "auth" ? "authentication_error" : "provider_error",
                  ...withFailureCategory(terminal.category),
                },
              });
            }
          }),
        );
        // Where the turn ended, before the next turn can start (it waits for
        // `done`): a fork "through this turn" copies exactly up to here. `done`
        // resolves however this ends, or the next send would wait forever.
        yield* Effect.suspend(() => {
          const proc = ctx.proc;
          return proc && !proc.closing
            ? markTurn(ctx, proc, turn.turnId, "end").pipe(Effect.asVoid)
            : Effect.void;
        }).pipe(Effect.ensuring(Deferred.succeed(turn.done, undefined)));
        yield* reportContextUsage(ctx);
      });

    const terminalFor = (ctx: SessionContext, turn: ActiveTurn): Terminal =>
      turn.stopRequested
        ? { kind: "interrupted", reason: "user" }
        : turn.failure !== undefined
          ? {
              kind: "failed",
              ...piTurnFailure(
                turn.failure,
                ctx.model ? parsePiModelSlug(ctx.model)?.provider : undefined,
              ),
            }
          : { kind: "completed" };

    /**
     * Ends the turn if Pi is truly idle: every prompt was acknowledged, no
     * dialog of the turn is open, nothing streams, compacts or waits in the
     * queue, and every event Pi sent before saying so has been handled (its
     * replies arrive apart from its events, so "idle" can overtake a turn's
     * last message). Otherwise the next `agent_settled`, ack, or the consumer
     * catching up checks again. `inRecord`: called while the consumer handles
     * a record, which counts as handled.
     */
    const finishIfIdle = (
      ctx: SessionContext,
      turn: ActiveTurn,
      inRecord = false,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (ctx.activeTurn !== turn || turn.promptPending) return;
        if ([...ctx.dialogs.values()].some((pending) => pending.turnId === turn.turnId)) return;
        const proc = ctx.proc;
        if (!proc || proc.closing || proc.pendingPrompts > 0) return;
        const state = decodePi(PiState)(
          yield* proc.rpc
            .request({ type: "get_state" })
            .pipe(Effect.orElseSucceed(() => undefined)),
        );
        if (Option.isNone(state)) return;
        if (proc.processedRecords + (inRecord ? 1 : 0) < proc.rpc.recordCount()) {
          turn.recheck = true;
          return;
        }
        // A steer or dialog may have arrived while Pi answered.
        if (ctx.activeTurn !== turn || ctx.proc !== proc || proc.pendingPrompts > 0) return;
        if ([...ctx.dialogs.values()].some((pending) => pending.turnId === turn.turnId)) return;
        const { isStreaming, isCompacting, pendingMessageCount } = state.value;
        if (isStreaming || isCompacting === true || (pendingMessageCount ?? 0) > 0) return;
        yield* finishTurn(ctx, turn, terminalFor(ctx, turn));
      });

    const reportContextUsage = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const proc = ctx.proc;
        if (!proc || proc.closing) return;
        const stats = decodePi(PiSessionStats)(
          yield* proc.rpc
            .request({ type: "get_session_stats" })
            .pipe(Effect.orElseSucceed(() => undefined)),
        );
        if (Option.isNone(stats)) return;
        const usage = stats.value.contextUsage;
        const window = usage?.contextWindow ?? ctx.contextWindow;
        // Right after a compaction Pi has no count yet; the next turn reports one.
        if (!usage || usage.tokens === null) return;
        yield* emit({
          type: "thread.token-usage.updated",
          ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
          payload: {
            usage: {
              usedTokens: Math.round(usage.tokens),
              ...(window && window > 0 ? { maxTokens: Math.round(window) } : {}),
              compactsAutomatically: true,
            },
          },
        });
      });

    const reportMessageUsage = (ctx: SessionContext, usage: PiUsage | undefined) =>
      Effect.gen(function* () {
        const input = Math.round(usage?.input ?? 0);
        const cached = Math.round(usage?.cacheRead ?? 0);
        const output = Math.round(usage?.output ?? 0);
        const used = Math.round(usage?.totalTokens ?? input + cached + output);
        if (used <= 0) return;
        yield* emit({
          type: "thread.token-usage.updated",
          ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
          payload: {
            usage: {
              usedTokens: used,
              lastUsedTokens: used,
              lastInputTokens: input + cached,
              lastCachedInputTokens: cached,
              lastOutputTokens: output,
              ...(usage?.reasoning
                ? { lastReasoningOutputTokens: Math.round(usage.reasoning) }
                : {}),
              ...(ctx.contextWindow ? { maxTokens: ctx.contextWindow } : {}),
              compactsAutomatically: true,
            },
          },
        });
      });

    // ── Messages and tools ───────────────────────────────────────────────

    const openMessage = (ctx: SessionContext, turn: ActiveTurn) => {
      turn.messageCount += 1;
      const prefix = `${turn.turnId}:m${turn.messageCount}`;
      const message: MessageState = {
        itemId: RuntimeItemId.make(prefix),
        reasoningItemId: RuntimeItemId.make(`${prefix}:thinking`),
        turnId: turn.turnId,
        text: "",
        textStarted: false,
        reasoning: "",
        reasoningStarted: false,
      };
      ctx.message = message;
      return message;
    };

    const applyMessageUpdate = (ctx: SessionContext, update: typeof PiMessageUpdate.Type) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        if (!turn) return;
        const message = ctx.message ?? openMessage(ctx, turn);
        const event = update.assistantMessageEvent;
        const base = yield* eventBase(ctx, message.turnId);
        if (event.type === "text_delta" && event.delta) {
          if (!message.textStarted) {
            message.textStarted = true;
            yield* emit({
              type: "item.started",
              ...base,
              itemId: message.itemId,
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
          }
          message.text += event.delta;
          yield* emit({
            type: "content.delta",
            ...base,
            itemId: message.itemId,
            payload: { streamKind: "assistant_text", delta: event.delta },
          });
          return;
        }
        if (event.type === "thinking_delta" && event.delta) {
          if (!message.reasoningStarted) {
            message.reasoningStarted = true;
            yield* emit({
              type: "item.started",
              ...base,
              itemId: message.reasoningItemId,
              payload: { itemType: "reasoning", status: "inProgress", title: "Thinking" },
            });
          }
          message.reasoning += event.delta;
          yield* emit({
            type: "content.delta",
            ...base,
            itemId: message.reasoningItemId,
            payload: { streamKind: "reasoning_text", delta: event.delta },
          });
        }
      });

    const applyMessageEnd = (ctx: SessionContext, event: typeof PiMessageEvent.Type) =>
      Effect.gen(function* () {
        const message = event.message;
        if (message.role !== "assistant") return;
        const turn = ctx.activeTurn;
        const state = ctx.message;
        // A final text the deltas missed is made up here.
        const text = piContentText(message.content);
        if (turn && state && text.startsWith(state.text) && text.length > state.text.length) {
          yield* applyMessageUpdate(ctx, {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: text.slice(state.text.length) },
          });
        }
        if (turn && text.trim()) turn.finalText = text;
        if (turn && message.stopReason === "error") {
          turn.failure = message.errorMessage ?? "The model request failed.";
        }
        yield* closeMessage(ctx, message.stopReason === "error");
        yield* reportMessageUsage(ctx, message.usage);
      });

    const toolKey = (turnId: TurnId | undefined, toolCallId: string) =>
      `${turnId ?? "none"}:${toolCallId}`;

    const applyTool = (ctx: SessionContext, event: typeof PiToolExecution.Type) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurn?.turnId;
        const key = toolKey(turnId, event.toolCallId);
        let state = ctx.tools.get(key);
        if (!state) {
          if (event.type === "tool_execution_end" && event.args === undefined) return;
          state = {
            itemId: RuntimeItemId.make(key),
            turnId,
            name: event.toolName,
            identity: identifyPiTool(event.toolName),
            args: event.args,
            streamed: "",
            completed: false,
            existedBefore: undefined,
          };
          ctx.tools.set(key, state);
          // Looked at as early as Threadlines can; a write that already
          // happened reads as "there", which only leaves its counts out.
          const writePath =
            event.toolName === "write" &&
            isRecord(event.args) &&
            typeof event.args.path === "string"
              ? NodePath.resolve(ctx.directory, event.args.path)
              : undefined;
          if (writePath) {
            state.existedBefore = yield* fileSystem
              .exists(writePath)
              .pipe(Effect.orElseSucceed(() => true));
          }
          // A message's text before its tool calls is its own row.
          yield* closeMessage(ctx, false);
          const detail = piToolDetail(state.identity, state.args);
          yield* emit({
            type: "item.started",
            ...(yield* eventBase(ctx, turnId)),
            itemId: state.itemId,
            payload: {
              itemType: state.identity.itemType,
              status: "inProgress",
              title: state.identity.title,
              ...(detail ? { detail } : {}),
              data: piToolData({
                name: state.name,
                identity: state.identity,
                directory: ctx.directory,
                args: state.args,
              }),
            },
          });
        }
        if (state.completed) return;
        if (event.args !== undefined) state.args = event.args;
        const base = yield* eventBase(ctx, state.turnId);
        if (event.type === "tool_execution_update" && state.identity.kind === "shell") {
          const output = piCommandOutput(event.partialResult);
          if (output.startsWith(state.streamed) && output.length > state.streamed.length) {
            const delta = output.slice(state.streamed.length);
            state.streamed = output;
            yield* emit({
              type: "content.delta",
              ...base,
              itemId: state.itemId,
              payload: { streamKind: "command_output", delta },
            });
          }
          return;
        }
        if (event.type !== "tool_execution_end") return;
        state.completed = true;
        const resultText = JSON.stringify(event.result?.content ?? "");
        const declined =
          event.isError === true &&
          (resultText.includes("was not approved in Threadlines") ||
            resultText.includes(PI_PLAN_MODE_REASON.slice(0, 30)));
        const failed = event.isError === true;
        if (state.identity.kind === "shell") {
          const output = piCommandOutput(event.result);
          if (output.startsWith(state.streamed) && output.length > state.streamed.length) {
            yield* emit({
              type: "content.delta",
              ...base,
              itemId: state.itemId,
              payload: { streamKind: "command_output", delta: output.slice(state.streamed.length) },
            });
            state.streamed = output;
          }
        }
        const detail = piToolDetail(state.identity, state.args);
        yield* emit({
          type: "item.completed",
          ...base,
          itemId: state.itemId,
          payload: {
            itemType: state.identity.itemType,
            status: declined ? "declined" : failed ? "failed" : "completed",
            title: state.identity.title,
            ...(detail ? { detail } : {}),
            data: piToolData({
              name: state.name,
              identity: state.identity,
              directory: ctx.directory,
              args: state.args,
              result: event.result,
              failed,
              final: true,
              existedBefore: state.existedBefore,
            }),
          },
        });
      });

    // ── Dialogs: approvals and questions ─────────────────────────────────

    const resolveDialog = (
      ctx: SessionContext,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision | undefined,
      answers: ProviderUserInputAnswers = {},
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending = ctx.dialogs.get(requestId);
        if (!pending) return;
        ctx.dialogs.delete(requestId);
        ctx.dialogIds.delete(pending.dialog.id);
        const base = yield* eventBase(ctx, pending.turnId);
        if (pending.approval) {
          yield* emit({
            type: "request.resolved",
            ...base,
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision: decision ?? "cancel" },
          });
        } else {
          yield* emit({
            type: "user-input.resolved",
            ...base,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers },
          });
        }
        // A dialog the turn waited on may have been the last thing keeping it open.
        const turn = ctx.activeTurn;
        if (turn && pending.turnId === turn.turnId) {
          yield* finishIfIdle(ctx, turn).pipe(Effect.forkIn(ctx.scope));
        }
      });

    const openDialog = (ctx: SessionContext, proc: ProcessState, dialog: PiDialog) =>
      Effect.gen(function* () {
        if (ctx.dialogIds.has(dialog.id)) return;
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = ctx.activeTurn?.turnId;
        const approval =
          dialog.method === "select" && dialog.title
            ? parsePiApprovalTitle(dialog.title, proc.nonce)
            : undefined;
        const tool = approval ? ctx.tools.get(toolKey(turnId, approval.toolCallId)) : undefined;
        const requestType = approval ? requestTypeForTool(approval.toolName) : "tool_user_input";
        const pending: PendingDialog = {
          requestId,
          dialog,
          turnId,
          approval,
          requestType,
          itemId: tool?.itemId,
        };
        ctx.dialogs.set(requestId, pending);
        ctx.dialogIds.set(dialog.id, requestId);
        const base = yield* eventBase(ctx, turnId);
        if (approval) {
          const identity = identifyPiTool(approval.toolName);
          let input: unknown;
          try {
            input = JSON.parse(approval.input);
          } catch {
            input = undefined;
          }
          const detail = piToolDetail(identity, input) ?? approval.input;
          yield* emit({
            type: "request.opened",
            ...base,
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType,
              ...(detail ? { detail: detail.slice(0, 2_000) } : {}),
              availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
              args: {
                toolName: approval.toolName,
                ...(identity.kind === "shell" &&
                isRecord(input) &&
                typeof input.command === "string"
                  ? { command: input.command }
                  : {}),
                ...(identity.kind === "edit" && isRecord(input) && typeof input.path === "string"
                  ? { path: input.path }
                  : {}),
              },
            },
            raw: {
              source: "pi.rpc.extension_ui",
              method: dialog.method,
              payload: withoutNonce(dialog, proc.nonce),
            },
          });
        } else {
          const header = dialog.title?.trim() || "Pi";
          const options =
            dialog.method === "select"
              ? (dialog.options ?? []).filter((option) => option.trim())
              : dialog.method === "confirm"
                ? ["Yes", "No"]
                : [];
          yield* emit({
            type: "user-input.requested",
            ...base,
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              questions: [
                {
                  id: "answer",
                  header: header.slice(0, 120),
                  question: (dialog.message?.trim() || dialog.placeholder?.trim() || header).slice(
                    0,
                    2_000,
                  ),
                  options: options.map((option) => ({ label: option, description: option })),
                  multiSelect: false,
                },
              ],
            },
            raw: {
              source: "pi.rpc.extension_ui",
              method: dialog.method,
              payload: withoutNonce(dialog, proc.nonce),
            },
          });
        }
        // Pi answers a dialog with a timeout itself; the request expires with it.
        if (dialog.timeout !== undefined && dialog.timeout > 0) {
          yield* Effect.sleep(Duration.millis(dialog.timeout)).pipe(
            Effect.andThen(resolveDialog(ctx, requestId, approval ? "cancel" : undefined)),
            Effect.forkIn(ctx.scope),
          );
        }
      });

    // ── Records ──────────────────────────────────────────────────────────

    const handleRecord = (ctx: SessionContext, proc: ProcessState, record: PiRecord) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.proc !== proc) return;
        yield* logNative(ctx, proc, record);
        switch (record.type) {
          case "agent_start": {
            if (ctx.activeTurn) return;
            // Pi started a run on its own: an extension woke it.
            const turnId = TurnId.make(yield* randomUUIDv4);
            yield* beginTurn(ctx, {
              turnId,
              origin: "provider",
              plan: proc.plan,
              promptPending: false,
            });
            // Marked once running, so it counts in Pi's tree; never a place to cut.
            yield* markTurn(ctx, proc, turnId, "late").pipe(Effect.forkIn(proc.scope));
            return;
          }
          case "message_start": {
            const event = decodePi(PiMessageEvent)(record);
            if (
              Option.isSome(event) &&
              event.value.message.role === "assistant" &&
              ctx.activeTurn
            ) {
              yield* closeMessage(ctx, false);
              openMessage(ctx, ctx.activeTurn);
            }
            return;
          }
          case "message_update": {
            const update = decodePi(PiMessageUpdate)(record);
            if (Option.isSome(update)) yield* applyMessageUpdate(ctx, update.value);
            return;
          }
          case "message_end": {
            const event = decodePi(PiMessageEvent)(record);
            if (Option.isSome(event)) yield* applyMessageEnd(ctx, event.value);
            return;
          }
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end": {
            const event = decodePi(PiToolExecution)(record);
            if (Option.isSome(event)) yield* applyTool(ctx, event.value);
            return;
          }
          case "extension_ui_request": {
            const dialog = decodePi(PiExtensionUiRequest)(record);
            if (Option.isNone(dialog)) return;
            if (PI_DIALOG_METHODS.has(dialog.value.method)) {
              yield* openDialog(ctx, proc, dialog.value);
            } else if (
              dialog.value.method === "notify" &&
              (dialog.value.notifyType === "warning" || dialog.value.notifyType === "error") &&
              dialog.value.message
            ) {
              yield* emit({
                type: "runtime.warning",
                ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
                payload: { message: dialog.value.message.slice(0, 2_000) },
              } as ProviderRuntimeEvent);
            }
            return;
          }
          case "compaction_start": {
            const event = decodePi(PiCompactionStart)(record);
            if (Option.isNone(event)) return;
            yield* emit({
              type: "item.started",
              ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
              itemId: RuntimeItemId.make(`${ctx.activeTurn?.turnId ?? "idle"}:compaction`),
              payload: {
                itemType: "context_compaction",
                status: "inProgress",
                data: { trigger: event.value.reason === "manual" ? "manual" : "auto" },
              },
            });
            return;
          }
          case "compaction_end": {
            const event = decodePi(PiCompactionEnd)(record);
            if (Option.isNone(event)) return;
            const value = event.value;
            const failed = value.errorMessage !== undefined || value.aborted === true;
            const turn = ctx.activeTurn;
            if (turn && value.willRetry) turn.failure = undefined;
            const base = yield* eventBase(ctx, turn?.turnId);
            yield* emit({
              type: "item.completed",
              ...base,
              itemId: RuntimeItemId.make(`${turn?.turnId ?? "idle"}:compaction`),
              payload: {
                itemType: "context_compaction",
                status: failed ? "failed" : "completed",
                ...(failed
                  ? { title: value.errorMessage?.slice(0, 200) ?? "Context compaction failed" }
                  : {}),
                data: { trigger: value.reason === "manual" ? "manual" : "auto" },
              },
            });
            if (!failed) {
              yield* emit({
                type: "thread.state.changed",
                ...base,
                payload: { state: "compacted" },
              } as ProviderRuntimeEvent);
            }
            return;
          }
          case "auto_retry_start": {
            const event = decodePi(PiAutoRetryStart)(record);
            if (Option.isNone(event) || !ctx.activeTurn) return;
            const { attempt, maxAttempts, errorMessage } = event.value;
            yield* emit({
              type: "runtime.warning",
              ...(yield* eventBase(ctx, ctx.activeTurn.turnId)),
              payload: {
                message: `Pi is retrying the model request${attempt ? ` (attempt ${attempt}${maxAttempts ? ` of ${maxAttempts}` : ""})` : ""}${errorMessage ? `: ${errorMessage}` : "."}`,
                warningKind: "api-retry",
              },
            } as ProviderRuntimeEvent);
            return;
          }
          case "auto_retry_end": {
            const event = decodePi(PiAutoRetryEnd)(record);
            if (Option.isSome(event) && event.value.success && ctx.activeTurn) {
              ctx.activeTurn.failure = undefined;
            }
            return;
          }
          case "agent_settled": {
            const event = decodePi(PiAgentSettled)(record);
            const turn = ctx.activeTurn;
            if (!turn) return;
            if (Option.isSome(event) && event.value.aborted === true) turn.stopRequested = true;
            yield* finishIfIdle(ctx, turn, true);
            return;
          }
          case "extension_error": {
            const event = decodePi(PiExtensionError)(record);
            if (Option.isNone(event)) return;
            yield* emit({
              type: "runtime.warning",
              ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
              payload: {
                message:
                  `A Pi extension failed${event.value.extensionPath ? ` (${NodePath.basename(event.value.extensionPath)})` : ""}: ${event.value.error ?? "unknown error"}`.slice(
                    0,
                    2_000,
                  ),
              },
            } as ProviderRuntimeEvent);
            return;
          }
          default:
            return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Pi record handling failed", { type: record.type, cause }),
        ),
      );

    // ── Processes ────────────────────────────────────────────────────────

    const closeProcess = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const proc = ctx.proc;
        if (!proc) return;
        proc.closing = true;
        ctx.proc = undefined;
        yield* Scope.close(proc.scope, Exit.void);
      });

    const onProcessLost = (ctx: SessionContext, proc: ProcessState, reason: string) =>
      Effect.gen(function* () {
        if (ctx.proc !== proc || proc.closing || ctx.stopped) return;
        yield* stopContext(ctx, reason);
      });

    /** Starts the thread's Pi process on `target` and checks the extension loaded. */
    const launchProcess = (
      ctx: SessionContext,
      target: Exclude<PiSessionTarget, { kind: "none" }>,
    ) =>
      Effect.gen(function* () {
        yield* ensureExtension(ctx.threadId);
        const scope = yield* Scope.make("sequential");
        const generation = ctx.nextGeneration++;
        return yield* Effect.gen(function* () {
          const nonce = (yield* randomUUIDv4).replaceAll("-", "");
          const access = piAccessLevel(ctx.runtimeMode);
          // The extension reads and deletes it at load; whatever is left goes with the process.
          const secretsFile = yield* Effect.tryPromise(() =>
            writePiSecretsFile(NodePath.join(options.extensionDir, "run"), {
              token: ctx.mcpToken,
              nonce,
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  detail: `Could not hand Pi its Threadlines settings: ${errorText(cause)}`,
                  cause,
                }),
            ),
          );
          yield* Scope.addFinalizer(
            scope,
            Effect.promise(() => removePiSecretsFile(secretsFile)),
          );
          const launcher = yield* options.launch.pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  detail: error.message,
                  cause: error,
                }),
            ),
          );
          const rpc = yield* startRpc({
            command: launcher.command,
            args: piProcessArgs(launcher, {
              purpose: "chat",
              session: target,
              launchArgs: ctx.launchArgs,
              extensionPath,
              instructionsPath: ctx.instructionsPath,
            }),
            cwd: ctx.directory,
            environment: piProcessEnvironment({
              instanceEnvironment: options.instanceEnvironment,
              ...(options.baseEnvironment ? { baseEnv: options.baseEnvironment } : {}),
              extension: {
                access,
                plan: false,
                toolServers: toolServers(ctx),
                secretsFile,
              },
            }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
          // Without its commands a marker would reach the model as text.
          const commands = decodePi(PiCommands)(
            yield* rpc
              .request({ type: "get_commands" })
              .pipe(Effect.orElseSucceed(() => undefined)),
          );
          const names = new Set(
            Option.isSome(commands) ? commands.value.commands.map((command) => command.name) : [],
          );
          yield* Effect.promise(() => removePiSecretsFile(secretsFile));
          if (!names.has(PI_TURN_COMMAND) || !names.has(PI_MODE_COMMAND)) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ctx.threadId,
              detail:
                "The Threadlines extension did not load in Pi, so Threadlines can't run it safely.",
            });
          }
          const state = decodePi(PiState)(rpc.initialState);
          const model = Option.isSome(state) ? state.value.model : undefined;
          const proc: ProcessState = {
            generation,
            rpc,
            scope,
            nonce,
            access,
            plan: false,
            baselineModel: model ? { provider: model.provider, modelId: model.id } : undefined,
            closing: false,
            pendingPrompts: 0,
            processedRecords: 0,
          };
          if (Option.isSome(state)) {
            if (state.value.sessionFile) ctx.sessionFile = state.value.sessionFile;
            if (state.value.thinkingLevel) ctx.thinkingLevel = state.value.thinkingLevel;
            if (model?.contextWindow) ctx.contextWindow = model.contextWindow;
          }
          // What the session runs on now: a resumed one keeps its last model.
          ctx.model = model ? piModelSlug(model) : undefined;
          ctx.proc = proc;
          yield* rpc.records.pipe(
            Stream.runForEach((record) =>
              handleRecord(ctx, proc, record).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    proc.processedRecords += 1;
                    const turn = ctx.activeTurn;
                    // Caught up with what an earlier idle check saw: check again.
                    if (!turn?.recheck || proc.processedRecords < proc.rpc.recordCount()) {
                      return Effect.void;
                    }
                    turn.recheck = false;
                    return finishIfIdle(ctx, turn);
                  }),
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
          yield* rpc.exited.pipe(
            Effect.flatMap((exit) =>
              onProcessLost(ctx, proc, describePiExit(exit, rpc.stderrTail())),
            ),
            Effect.forkIn(scope),
          );
          return proc;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    /** The turns the session's history already holds, in order, from their markers. */
    const seedTurns = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const entries = decodePi(PiEntries)(
          yield* piRequest(ctx, { type: "get_entries" }).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
        );
        if (Option.isNone(entries)) return;
        const boundaries = piTurnBoundaries(entries.value.entries, entries.value.leafId);
        ctx.turns.splice(
          0,
          ctx.turns.length,
          ...boundaries.map((boundary) => ({ id: TurnId.make(boundary.turnId) })),
        );
      });

    /**
     * Has the extension append one of a turn's markers. A turn without one
     * only loses precision: revert and fork say Pi's memory wasn't matched.
     */
    const markTurn = (
      ctx: SessionContext,
      proc: ProcessState,
      turnId: TurnId,
      mark: PiTurnMark | undefined,
    ) =>
      proc.rpc
        .request(
          {
            type: "prompt",
            message: piTurnCommandText({ nonce: proc.nonce, turnId, mark }),
            streamingBehavior: "steer",
          },
          { timeout: STOP_STEP_TIMEOUT },
        )
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Pi turn marker failed", {
              threadId: ctx.threadId,
              mark,
              error,
            }).pipe(Effect.as(false)),
          ),
        );

    /**
     * Marks a turn a revert or fork dropped, whose start marker is still on
     * the branch, so a restart doesn't count it. Kept for a retry when Pi
     * can't take it now.
     */
    const markDropped = (ctx: SessionContext, proc: ProcessState, turnId: TurnId) =>
      Effect.gen(function* () {
        if (!(yield* markTurn(ctx, proc, turnId, "reverted"))) {
          ctx.pendingTombstones.push(turnId);
          return;
        }
        // A list seeded while the marker was missing still counts the turn.
        const index = ctx.turns.findIndex((turn) => turn.id === turnId);
        if (index >= 0) ctx.turns.splice(index, 1);
      });

    const retryDropped = (ctx: SessionContext, proc: ProcessState) =>
      Effect.gen(function* () {
        for (const turnId of ctx.pendingTombstones.splice(0)) yield* markDropped(ctx, proc, turnId);
      });

    /** Restarts the thread's process on its current session file. */
    const relaunch = (ctx: SessionContext) =>
      closeProcess(ctx).pipe(
        Effect.andThen(launchProcess(ctx, { kind: "resume", sessionFile: ctx.sessionFile })),
      );

    const updateCursor = (ctx: SessionContext) => {
      const resumeCursor = makePiResumeCursor({
        sessionFile: ctx.sessionFile,
        cwd: ctx.directory,
        defaultModel: ctx.defaultModel
          ? piModelSlug({ provider: ctx.defaultModel.provider, id: ctx.defaultModel.modelId })
          : undefined,
      });
      ctx.session = {
        ...ctx.session,
        resumeCursor,
        providerThreadId: ctx.sessionFile,
        ...(ctx.model ? { model: ctx.model } : {}),
      };
    };

    // ── Session lifecycle ────────────────────────────────────────────────

    const stopContext = (ctx: SessionContext, failure: string | undefined) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        for (const requestId of Array.from(ctx.dialogs.keys())) {
          yield* resolveDialog(ctx, requestId, "cancel");
        }
        const turn = ctx.activeTurn;
        if (turn) {
          ctx.activeTurn = undefined;
          yield* emit({
            type: "turn.completed",
            ...(yield* eventBase(ctx, turn.turnId)),
            payload: failure
              ? { state: "failed", errorMessage: failure }
              : { state: "interrupted", stopReason: "session-stopped" },
          });
          yield* Deferred.succeed(turn.done, undefined);
        }
        if (ctx.proc) ctx.proc.closing = true;
        yield* Scope.close(ctx.scope, Exit.void);
        if (failure) {
          yield* emit({
            type: "runtime.error",
            ...(yield* eventBase(ctx, undefined)),
            payload: { message: failure, class: "provider_error" },
          });
        }
        yield* emit({
          type: "session.exited",
          ...(yield* eventBase(ctx, undefined)),
          payload: failure ? { exitKind: "error", reason: failure } : { exitKind: "graceful" },
        } as ProviderRuntimeEvent);
      });

    /**
     * Copies another thread's Pi session into this thread's folder, cut at the
     * fork boundary, with a short-lived helper process (no extensions, no
     * tools). Returns the new session file, or fails when there is no exact
     * boundary (the caller then starts fresh with Threadlines' recap).
     */
    const forkInto = (
      directory: string,
      forkFrom: {
        readonly providerThreadId: string;
        readonly beforeTurnId?: string | undefined;
        readonly lastTurnId?: string | undefined;
      },
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const launcher = yield* options.launch;
          const rpc = yield* startRpc({
            command: launcher.command,
            args: piProcessArgs(launcher, {
              purpose: "fork",
              sessionFile: forkFrom.providerThreadId,
            }),
            cwd: directory,
            environment: piProcessEnvironment({
              instanceEnvironment: options.instanceEnvironment,
              ...(options.baseEnvironment ? { baseEnv: options.baseEnvironment } : {}),
            }),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          const entries = decodePi(PiEntries)(yield* rpc.request({ type: "get_entries" }));
          if (Option.isNone(entries)) return undefined;
          const plan = planPiFork(entries.value.entries, entries.value.leafId, {
            beforeTurnId: forkFrom.beforeTurnId,
            lastTurnId: forkFrom.lastTurnId,
          });
          if (plan.kind === "contextSeed") return undefined;
          if (plan.kind === "fork") {
            const result = decodePi(PiForkResult)(
              yield* rpc.request(
                { type: "fork", entryId: plan.entryId },
                { timeout: Duration.seconds(60) },
              ),
            );
            if (Option.isNone(result) || result.value.cancelled) return undefined;
          }
          const state = decodePi(PiState)(yield* rpc.request({ type: "get_state" }));
          const sessionFile = Option.isSome(state) ? state.value.sessionFile : undefined;
          return sessionFile
            ? {
                sessionFile,
                droppedTurnId: plan.kind === "fork" ? TurnId.make(plan.droppedTurnId) : undefined,
              }
            : undefined;
        }),
      );

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        // Pi loads the user's extensions and MCP servers in every process, so
        // a locked-down side answer cannot be promised.
        if (input.lockdown !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Pi cannot answer on the side while another agent works.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (!options.settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Pi is turned off in Settings.",
          });
        }
        const launchArgs = parsePiLaunchArgs(options.settings.launchArgs);
        if ("error" in launchArgs) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: launchArgs.error,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* existing.lifecycle.withPermit(stopContext(existing, undefined));

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
          const roomTools = input.roomTools === true;
          const commandRequests = input.commandRequests === true;
          const agentPageAssetsDir =
            input.agentPages === true
              ? yield* ensurePageAssetsDir(parseSessionKey(input.threadId).threadId).pipe(
                  Effect.map((dir): string | undefined => dir),
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
          const credential = yield* mcpSessionRegistry.credentialFor({
            sessionKey: input.threadId,
            browser: true,
            room: roomTools,
            pages: agentPageAssetsDir !== undefined,
            commands: commandRequests,
            scheduledRun: input.scheduledRunTools === true,
          });
          yield* Scope.addFinalizer(
            scope,
            mcpSessionRegistry.revoke(input.threadId, credential.generation),
          );
          const managedWorktree = yield* isLinkedWorktreeCheckout(directory).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          const instructions = instructionsFor({
            agentPageAssetsDir,
            commandRequests,
            scheduleTools: roomTools && input.scheduleTools === true,
            managedWorktree,
          });
          const instructionsPath = NodePath.join(
            options.extensionDir,
            "instructions",
            `${createHash("sha256").update(instructions).digest("hex").slice(0, 16)}.md`,
          );
          yield* writePrivateFile(instructionsPath, instructions).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `Could not write Threadlines' instructions for Pi: ${cause.message}`,
                  cause,
                }),
            ),
          );
          const boundSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const now = yield* nowIso;
          const ctx: SessionContext = {
            threadId: input.threadId,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: directory,
              ...(boundSelection ? { model: boundSelection.model } : {}),
              threadId: input.threadId,
              ...(roomTools ? { roomTools: true } : {}),
              createdAt: now,
              updatedAt: now,
            },
            directory,
            scope,
            runtimeMode: input.runtimeMode,
            roomTools,
            agentPageAssetsDir,
            commandRequests,
            managedWorktree,
            mcpToken: credential.token,
            launchArgs: launchArgs.args,
            instructionsPath,
            sessionFile: "",
            proc: undefined,
            nextGeneration: 1,
            model: undefined,
            thinkingLevel: undefined,
            contextWindow: undefined,
            pendingSeed: undefined,
            activeTurn: undefined,
            lastTurn: undefined,
            pendingTombstones: [],
            message: undefined,
            tools: new Map(),
            dialogs: new Map(),
            dialogIds: new Map(),
            turns: [],
            defaultModel: undefined,
            lifecycle: yield* Semaphore.make(1),
            stopped: false,
          };
          yield* Scope.addFinalizer(scope, closeProcess(ctx));

          const cursor = parsePiResumeCursor(input.resumeCursor);
          ctx.defaultModel = cursor?.defaultModel
            ? parsePiModelSlug(cursor.defaultModel)
            : undefined;
          let opened = false;
          if (cursor) {
            // Pi runs a resumed session in the folder its file names; a thread
            // that moved to another checkout continues in a copy made there.
            const target: Exclude<PiSessionTarget, { kind: "none" }> =
              cursor.cwd === directory
                ? { kind: "resume", sessionFile: cursor.sessionFile }
                : { kind: "fork", sessionFile: cursor.sessionFile };
            opened = yield* launchProcess(ctx, target).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                input.resumePolicy === "required"
                  ? Effect.fail(error)
                  : closeProcess(ctx).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          ctx.session = { ...ctx.session, resumeFailed: true };
                        }),
                      ),
                      Effect.as(false),
                    ),
              ),
            );
          }
          if (!opened && input.forkFrom) {
            const forked = yield* forkInto(directory, input.forkFrom).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: `Pi could not fork the conversation: ${errorText(error)}`,
                  }),
              ),
            );
            if (!forked) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "Pi has no exact place to fork this conversation.",
              });
            }
            const proc = yield* launchProcess(ctx, {
              kind: "resume",
              sessionFile: forked.sessionFile,
            });
            // The cut kept the next turn's start marker.
            if (forked.droppedTurnId) yield* markDropped(ctx, proc, forked.droppedTurnId);
            opened = true;
          }
          if (!opened) {
            const proc = yield* launchProcess(ctx, { kind: "new" });
            // A new session starts on the default Pi picked for this folder.
            ctx.defaultModel = proc.baselineModel;
            if (input.contextSeed !== undefined) {
              ctx.pendingSeed = renderThreadContextSeed(input.contextSeed);
            }
          }
          // A session with history: revert counts back through the turns its markers name.
          if (opened) yield* seedTurns(ctx);
          if (boundSelection) yield* applyModel(ctx, boundSelection);
          updateCursor(ctx);
          sessions.set(input.threadId, ctx);
          yield* emit({
            type: "session.started",
            ...(yield* eventBase(ctx, undefined)),
            payload: {},
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* eventBase(ctx, undefined)),
            payload: { state: "ready", reason: "Pi session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* eventBase(ctx, undefined)),
            payload: { providerThreadId: ctx.sessionFile },
          });
          return ctx.session;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    // ── Models ───────────────────────────────────────────────────────────

    const reasoningEffortFor = (selection: {
      readonly model: string;
      readonly options?: unknown;
    }) => {
      const effort = getModelSelectionStringOptionValue(selection as never, "reasoningEffort");
      if (!effort) return undefined;
      const model = options.models().find((entry) => entry.slug === selection.model);
      const descriptor = model?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "reasoningEffort",
      );
      if (!descriptor || descriptor.type !== "select") return effort;
      return descriptor.options.some((option) => option.id === effort) ? effort : undefined;
    };

    /** Points Pi at the selected model and thinking level, when they differ. */
    const applyModel = (
      ctx: SessionContext,
      selection: { readonly model: string; readonly options?: unknown },
    ) =>
      Effect.gen(function* () {
        const proc = yield* requireProcess(ctx, "set_model");
        const target =
          parsePiModelSlug(selection.model) ??
          ctx.defaultModel ??
          options.defaultModel?.() ??
          proc.baselineModel;
        const targetSlug = target
          ? piModelSlug({ provider: target.provider, id: target.modelId })
          : undefined;
        if (target && targetSlug !== ctx.model) {
          const model = decodePi(PiModel)(
            yield* piRequest(ctx, {
              type: "set_model",
              provider: target.provider,
              modelId: target.modelId,
            }),
          );
          ctx.model = targetSlug;
          // Pi gives the new model its own default level: send the chosen one again.
          ctx.thinkingLevel = undefined;
          if (Option.isSome(model) && model.value.contextWindow) {
            ctx.contextWindow = model.value.contextWindow;
          }
          ctx.session = { ...ctx.session, ...(targetSlug ? { model: targetSlug } : {}) };
        }
        const effort = reasoningEffortFor(selection);
        if (effort && effort !== ctx.thinkingLevel) {
          yield* piRequest(ctx, { type: "set_thinking_level", level: effort });
          ctx.thinkingLevel = effort;
        }
      });

    // ── Input ────────────────────────────────────────────────────────────

    const promptContent = (
      method: string,
      input: {
        readonly input?: string | undefined;
        readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
        readonly skills?: ReadonlyArray<ChatSkillReference> | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const notes: Array<string> = [];
        for (const attachment of input.attachments ?? []) {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          if (attachment.type === "file") {
            notes.push(buildFileAttachmentNote(attachment, path));
            continue;
          }
          const bytes = yield* fileSystem.readFile(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: `Failed to read attachment file: ${cause.message}.`,
                  cause,
                }),
            ),
          );
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        for (const skill of input.skills ?? []) {
          const body = yield* fileSystem
            .readFileString(skill.path)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (body !== undefined) notes.push(skillBlock(skill, stripFrontmatter(body)));
        }
        const text = [input.input?.trim() ?? "", ...notes].filter(Boolean).join("\n\n");
        return { text, images };
      });

    /** Sends the prompt and follows its ack without holding the caller. */
    const sendPrompt = (
      ctx: SessionContext,
      proc: ProcessState,
      turn: ActiveTurn,
      content: { readonly text: string; readonly images: ReadonlyArray<unknown> },
    ) =>
      Effect.sync(() => {
        proc.pendingPrompts += 1;
      }).pipe(
        Effect.andThen(
          proc.rpc.request(
            {
              type: "prompt",
              message: content.text,
              ...(content.images.length > 0 ? { images: content.images } : {}),
              streamingBehavior: "steer",
            },
            { timeout: null },
          ),
        ),
        Effect.exit,
        Effect.flatMap((sent) =>
          Effect.gen(function* () {
            proc.pendingPrompts -= 1;
            turn.promptPending = false;
            if (Exit.isFailure(sent)) {
              const error = Option.getOrUndefined(Exit.findErrorOption(sent));
              if (ctx.activeTurn === turn) {
                turn.failure = `${PI_PROMPT_REFUSED_PREFIX}${error?.detail ?? "it stopped first."}`;
              }
            }
            // Whatever the ack says, whether the turn is over is Pi's state's call:
            // an ack held by an extension command can come after the run settled.
            yield* finishIfIdle(ctx, turn);
          }),
        ),
        Effect.forkIn(proc.scope),
        Effect.asVoid,
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (ctx) =>
        ctx.lifecycle.withPermit(
          Effect.gen(function* () {
            // One turn at a time: a send while Pi runs its own turn starts once it ends.
            // `lastTurn`, not just the active one: a finished turn is done only
            // once its end marker is written, which must come before this
            // turn's start marker.
            const previous = ctx.activeTurn ?? ctx.lastTurn;
            if (previous) yield* Deferred.await(previous.done);
            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            if (!ctx.proc || ctx.proc.closing) yield* relaunch(ctx);
            const proc = yield* requireProcess(ctx, "prompt");
            const plan = input.interactionMode === "plan";
            const access = piAccessLevel(ctx.runtimeMode);
            if (proc.plan !== plan || proc.access !== access) {
              yield* piRequest(ctx, {
                type: "prompt",
                message: piModeCommandText({ nonce: proc.nonce, access, plan }),
                streamingBehavior: "steer",
              });
              proc.plan = plan;
              proc.access = access;
            }
            const content = yield* promptContent("prompt", input);
            if (!content.text && content.images.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Turn for ${input.threadId} requires text or attachments.`,
              });
            }
            const selection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            // Pi refuses a model whose provider it no longer holds a key for (signed
            // out while this chat's Pi ran) when it's chosen: said as plainly as a
            // failed turn would say it.
            if (selection) {
              yield* applyModel(ctx, selection).pipe(
                Effect.mapError((error) => {
                  const failure = piTurnFailure(error.detail);
                  return failure.category === "auth"
                    ? new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: error.method,
                        detail: failure.message,
                        cause: error,
                      })
                    : error;
                }),
              );
            }
            const turnId = TurnId.make(yield* randomUUIDv4);
            // Where revert and fork cut; after any drop that couldn't be marked before.
            yield* retryDropped(ctx, proc);
            yield* markTurn(ctx, proc, turnId, undefined);
            const text = ctx.pendingSeed
              ? withContextSeedPreamble(ctx.pendingSeed, content.text)
              : content.text;
            const turn = yield* beginTurn(ctx, {
              turnId,
              origin: "user",
              plan,
              promptPending: true,
            });
            yield* sendPrompt(ctx, proc, turn, { text, images: content.images });
            ctx.pendingSeed = undefined;
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          }),
        ),
      );

    const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const steerable = Effect.suspend(() => {
          const turn = ctx.activeTurn;
          return !turn || turn.turnId !== input.expectedTurnId
            ? Effect.fail(steerRejectedError(PROVIDER, "Pi", "no-active-turn"))
            : turn.stopRequested
              ? Effect.fail(steerRejectedError(PROVIDER, "Pi", "turn-finishing"))
              : Effect.succeed(turn);
        });
        yield* steerable;
        const content = yield* promptContent("prompt", input);
        const proc = yield* requireProcess(ctx, "prompt");
        // Counted before the last check, so the turn can't end in between,
        // and uncounted however this ends. `steer` alone stays queued forever
        // if Pi just went idle; a prompt with this flag joins the running run
        // or starts one. Its ack is waited for like the turn's own: an
        // extension command holds it.
        const live = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            proc.pendingPrompts += 1;
          }),
          () =>
            Effect.gen(function* () {
              const turn = yield* steerable;
              yield* proc.rpc
                .request(
                  {
                    type: "prompt",
                    message: content.text,
                    ...(content.images.length > 0 ? { images: content.images } : {}),
                    streamingBehavior: "steer",
                  },
                  { timeout: null },
                )
                .pipe(Effect.mapError(requestError("prompt")));
              return turn;
            }),
          () =>
            Effect.suspend(() => {
              proc.pendingPrompts -= 1;
              const turn = ctx.activeTurn;
              return turn && ctx.proc === proc
                ? finishIfIdle(ctx, turn).pipe(Effect.forkIn(ctx.scope), Effect.asVoid)
                : Effect.void;
            }),
        );
        return {
          threadId: input.threadId,
          turnId: live.turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    /**
     * Stop: cancel open dialogs, clear queued input, abort. When Pi still
     * hasn't settled (detached work, a command still running its handler),
     * the process goes and the turn ends interrupted.
     */
    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turn = ctx.activeTurn;
        if (turnId !== undefined && turn?.turnId !== turnId) return;
        if (turn) turn.stopRequested = true;
        yield* dropPendingDialogs(ctx);
        yield* piRequest(ctx, { type: "clear_queue" }).pipe(Effect.ignore);
        yield* piRequest(ctx, { type: "abort" }, { timeout: STOP_STEP_TIMEOUT }).pipe(
          Effect.ignore,
        );
        if (!turn) return;
        yield* finishIfIdle(ctx, turn).pipe(Effect.ignore);
        const settled = yield* Deferred.await(turn.done).pipe(
          Effect.timeoutOption(STOP_STEP_TIMEOUT),
        );
        if (Option.isSome(settled) || ctx.activeTurn !== turn) return;
        yield* emit({
          type: "runtime.warning",
          ...(yield* eventBase(ctx, turn.turnId)),
          payload: { message: "Pi did not stop in time; restarting it." },
        } as ProviderRuntimeEvent);
        yield* closeProcess(ctx);
        yield* finishTurn(ctx, turn, { kind: "interrupted", reason: "user" });
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.dialogs.get(requestId);
        if (!pending?.approval) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        const proc = yield* requireProcess(ctx, "extension_ui_response");
        if (decision === "cancel") {
          yield* interruptTurn(threadId);
          return;
        }
        yield* proc.rpc.send({
          type: "extension_ui_response",
          id: pending.dialog.id,
          value:
            decision === "accept"
              ? PI_APPROVAL_OPTIONS.allow
              : decision === "acceptForSession"
                ? PI_APPROVAL_OPTIONS.allowForSession
                : PI_APPROVAL_OPTIONS.deny,
        });
        yield* resolveDialog(ctx, requestId, decision);
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.dialogs.get(requestId);
        if (!pending || pending.approval) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        const proc = yield* requireProcess(ctx, "extension_ui_response");
        const raw = answers.answer;
        const value = (Array.isArray(raw) ? raw[0] : raw) as unknown;
        const text = value === undefined || value === null ? undefined : String(value);
        const dialog = pending.dialog;
        const response =
          text === undefined
            ? { cancelled: true }
            : dialog.method === "confirm"
              ? { confirmed: text.trim().toLowerCase() === "yes" }
              : { value: text };
        yield* proc.rpc.send({ type: "extension_ui_response", id: dialog.id, ...response });
        yield* resolveDialog(ctx, requestId, undefined, answers);
      });

    const compactContext: NonNullable<PiAdapterShape["compactContext"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Compaction runs a model call; its reply is the finished summary.
        yield* piRequest(ctx, { type: "compact" }, { timeout: null }).pipe(
          Effect.catch((error) =>
            error.code === "rejected"
              ? Effect.gen(function* () {
                  yield* emit({
                    type: "runtime.warning",
                    ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
                    payload: { message: `Pi did not compact: ${error.detail}` },
                  } as ProviderRuntimeEvent);
                })
              : Effect.fail(error),
          ),
        );
        yield* reportContextUsage(ctx);
      });

    /**
     * Revert: fork Pi's session before the first removed turn's message and
     * continue on the copy. Pi's memory is rewound only when that turn has a
     * marker; otherwise Threadlines restores files and says so.
     */
    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* ctx.lifecycle.withPermit(
          Effect.gen(function* () {
            const keep = Math.max(0, ctx.turns.length - numTurns);
            // Turns from before the session's first marker (a recap's) can't be cut at.
            const target = numTurns <= ctx.turns.length ? ctx.turns[keep] : undefined;
            let rolledBack = false;
            if (target) {
              const entries = decodePi(PiEntries)(yield* piRequest(ctx, { type: "get_entries" }));
              const plan = Option.isSome(entries)
                ? planPiRevert(
                    piTurnBoundaries(entries.value.entries, entries.value.leafId),
                    target.id,
                  )
                : ({ kind: "unknown" } as const);
              if (plan.kind === "fork") {
                const result = decodePi(PiForkResult)(
                  yield* piRequest(
                    ctx,
                    { type: "fork", entryId: plan.entryId },
                    { timeout: Duration.seconds(60) },
                  ),
                );
                const state = decodePi(PiState)(yield* piRequest(ctx, { type: "get_state" }));
                if (
                  Option.isSome(result) &&
                  !result.value.cancelled &&
                  Option.isSome(state) &&
                  state.value.sessionFile
                ) {
                  ctx.sessionFile = state.value.sessionFile;
                  // The fork re-ran extensions without their settings: restart on the copy.
                  const proc = yield* relaunch(ctx);
                  // The dropped turn's start marker is still on the branch.
                  yield* markDropped(ctx, proc, target.id);
                  updateCursor(ctx);
                  rolledBack = true;
                }
              }
            }
            ctx.turns.splice(keep);
            return {
              threadId,
              turns: ctx.turns.map((turn) => ({ id: turn.id, items: [] })),
              conversationRolledBack: rolledBack,
            };
          }),
        );
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        yield* ctx.lifecycle.withPermit(stopContext(ctx, undefined));
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
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
        conversationRollback: "native",
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      compactContext,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.map(requireSession(threadId), (ctx) => ({
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: [] })),
        })),
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies PiAdapterShape;
  });
}

/** Commands from Pi's `get_commands` that Threadlines shows: not Pi's terminal ones, not ours. */
export function visiblePiCommands<
  T extends {
    readonly name: string;
    readonly sourceInfo?: { readonly source?: string | undefined } | undefined;
  },
>(commands: ReadonlyArray<T>): ReadonlyArray<T> {
  return commands.filter(
    (command) =>
      command.name !== PI_TURN_COMMAND &&
      command.name !== PI_MODE_COMMAND &&
      !HIDDEN_COMMAND_SOURCES.has(command.sourceInfo?.source ?? ""),
  );
}
