/**
 * AcpAdapter — generic `ProviderAdapterShape` for any ACP agent.
 *
 * One ACP child process per thread. Session setup, prompt streaming, mode
 * selection, permission requests and cancellation are protocol-level and
 * identical across agents; a descriptor contributes the spawn command, the
 * model-option mapping and optional vendor extension handlers.
 *
 * @module provider/acp/AcpAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type McpElicitation,
  type ProviderApprovalDecision,
  type ProviderFailureCategory,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
  type UsageTokenTotals,
  type ServerProviderSlashCommand,
} from "@threadlines/contracts";
import { mcpElicitationPrompt, mcpElicitationResponse } from "../mcpElicitation.ts";
import { withFailureCategory } from "../providerFailureCategory.ts";
import { makeAgentProcessLedger } from "../agentProcessLedger.ts";
import {
  type ProjectBriefPreface,
  projectBriefPreface,
  readProjectBriefHash,
} from "../projectBriefPreface.ts";
import {
  isProviderPlanGateMessage,
  isProviderPlanGateReply,
} from "@threadlines/shared/providerPlan";
import { renderThreadContextSeed, withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import { countTextReplacementStats } from "@threadlines/shared/textReplacementStats";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import { sameSlashCommands, slashCommandAtStart } from "@threadlines/shared/slashCommands";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { UsageLedgerEntry } from "../../usage/usageLedger.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  mcpEndpointUrl,
  mcpCommandsEndpointUrl,
  mcpDeviceEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import { PAGES_MCP_SERVER_NAME } from "../../mcp/pageTools.ts";
import { COMMANDS_MCP_SERVER_NAME } from "../../mcp/commandTools.ts";
import { DEVICE_MCP_SERVER_NAME } from "../../mcp/deviceTools.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import {
  ROOM_MCP_SERVER_NAME,
  roomEndpointGrant,
  roomSideKindOf,
} from "../../mcp/roomToolAccess.ts";
import { withoutProjectNoteWriteInstruction } from "../../projectContext/projectNotesAccess.ts";
import { driverAnswersOnTheSide } from "../sideAnswerDrivers.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  steerRejectedError,
} from "../Errors.ts";
import { buildFileAttachmentNote } from "../fileAttachmentPrompt.ts";
import {
  appendTailCapped,
  PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE,
  PROMPT_SUGGESTION_MAX_MESSAGES,
  type PromptSuggestionMessage,
  sanitizePromptSuggestion,
} from "../promptSuggestions.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  acpAvailableDecisions,
  acpPermissionOptionId,
  isAcpAuthRequiredError,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "./AcpNativeLogging.ts";
import type {
  AcpExtensionContext,
  AcpPromptOutcomeWatch,
  AcpPromptFailure,
  AcpPromptPlanMode,
  AcpProviderDescriptor,
  AcpProviderSettings,
  AcpSubagents,
  AcpTurnOutcome,
} from "./AcpProviderDescriptor.ts";
import { type AcpAttachmentBudget, acpAttachmentContent } from "./AcpPromptAttachments.ts";
import { type AcpSubagentRoster, makeAcpSubagentRoster } from "./AcpSubagentRoster.ts";
import {
  applyAcpModelSelection,
  defaultResolveAcpModelId,
  makeAcpProviderRuntime,
} from "./AcpProviderRuntime.ts";
import {
  type AcpPermissionRequest,
  type AcpToolCallReport,
  type AcpPlanUpdate,
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  acpTurnUsageTotals,
  describePermissionRequest,
  mergeToolCallState,
  toolCallSubstance,
  parsePermissionRequest,
} from "./AcpRuntimeModel.ts";
import { THREADLINES_ACP_CLIENT_INFO } from "./acpClientInfo.ts";
import {
  type AcpPromptOutcomeRead,
  type AcpTurnCommand,
  type AcpTurnEnd,
  type AcpTurnEvent,
  type AcpTurnMachineState,
  type AcpTurnTimer,
  initialTurnMachineState,
  stepTurnMachine,
  workPending,
} from "./AcpTurnMachine.ts";
import { type AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const ACP_RESUME_VERSION = 1 as const;
/** A session's command list reaches the clients at most this often. */
const ACP_SESSION_COMMANDS_INTERVAL_MS = 5_000;
/**
 * How long a cancelled prompt may take to return. Past it the turn settles
 * as cancelled here and the process is recycled; the next turn resumes the
 * conversation in a fresh one.
 */
const ACP_CANCEL_DEADLINE = Duration.seconds(15);
/** How long a steer waits to be written to the agent before failing so Stop is never blocked. */
const ACP_STEER_DELIVERY_TIMEOUT = Duration.seconds(15);
/** How long a revert lets the agent stop its work before its session ends. */
const ACP_REVERT_WIND_DOWN = Duration.seconds(3);
/**
 * An agent's own turn (see `agentTurns`) that has gone this long without
 * output is closed here, in case its end notice never comes. Long: a command
 * running inside the turn reports nothing until it changes or ends.
 */
const ACP_AGENT_TURN_QUIET_LIMIT = Duration.minutes(15);
const ACP_AGENT_TURN_QUIET_CHECK = Duration.seconds(30);
/**
 * A held turn ends this long after the agent's last word once nothing holds
 * it: another wake can follow straight after a reply.
 */
const ACP_HELD_TURN_SETTLE = Duration.seconds(2);
/** A reply the agent started by itself whose closing `usage_update` never comes ends after this. */
const ACP_HELD_REPLY_QUIET_LIMIT = Duration.minutes(2);
/** How long reading a prompt's real outcome (`turnMachine.outcome`) may take. */
const ACP_OUTCOME_CHECK_TIMEOUT = Duration.seconds(10);
/**
 * How long noting where the agent's records stand may hold a prompt back
 * (`turnMachine.outcome.watch`): past it the prompt goes with no baseline,
 * and its outcome is its own answer. The one sender waits on it.
 */
const ACP_OUTCOME_WATCH_TIMEOUT = Duration.seconds(2);
/**
 * How long after a cancel its notice is still expected (and dropped). An
 * agent that never sends one must not cost a real reply in those words later.
 */
const ACP_NOTICE_EXPIRY = Duration.seconds(30);
/** How often a stop that waits on subagents reads their records again. */
const ACP_STOP_CHECK_INTERVAL = Duration.seconds(1);
/**
 * How long stopping a machine session waits for its event reader to get
 * through what is already queued (answers, their usage, the turn's end).
 * The reader never waits on I/O, so this is only a guard against a bug.
 */
const ACP_STOP_DRAIN_LIMIT = Duration.seconds(5);
/**
 * The most turns a resume cursor remembers the agent's prompt positions for
 * (see `conversationHistory`); a revert further back trims Threadlines' turn
 * list only.
 */
const ACP_HISTORY_CURSOR_LIMIT = 200;
/** How long asking the agent where a prompt landed may take before it goes unanswered. */
const ACP_HISTORY_POSITION_TIMEOUT = Duration.seconds(5);
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export type AcpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface AcpAdapterOptions<Settings extends AcpProviderSettings> {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Selections are honored when `modelSelection.instanceId` matches this value. */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. Production binds settings to the
   * instance scope (the hydration layer rebuilds the adapter on config
   * change); tests that swap `binaryPath` mid-suite pass a live resolver.
   */
  readonly resolveSettings?: Effect.Effect<Settings>;
  /**
   * Writes down a finished turn's usage for the Usage page (the usage
   * ledger), for agents that keep no usage of their own on disk. Never fails.
   */
  readonly recordTurnUsage?: (entry: UsageLedgerEntry) => Effect.Effect<void>;
  /**
   * For `agentCommands` descriptors: a session's own command list changed
   * (`undefined`: the session ended). The driver puts it on the provider
   * status (`ServerProvider.sessionCommands`). Never fails.
   */
  readonly onSessionCommands?: (
    sessionKey: ThreadId,
    commands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
  ) => Effect.Effect<void>;
  /** The skills the provider status lists, by name: a typed `/name` runs one. */
  readonly skillNames?: Effect.Effect<ReadonlySet<string>>;
  /**
   * Optional next-message prompt suggestion sampler (gray composer hint, taken
   * with Tab). Run asynchronously after completed user-originated turns, never
   * in side/lockdown sessions, and cancelled whenever a new turn or stop begins.
   */
  readonly promptSuggestions?: {
    readonly shouldSuggest: (model: string | undefined) => Effect.Effect<boolean>;
    readonly sample: (input: {
      readonly cwd: string;
      readonly model: string | undefined;
      readonly messages: ReadonlyArray<PromptSuggestionMessage>;
    }) => Effect.Effect<string | undefined>;
  };
  /** Tests only: holds the turn machine's driver up at its seams (`AcpTurnMachineSeam`). */
  readonly turnMachineSeams?: (seam: AcpTurnMachineSeam) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly elicitation?: McpElicitation;
}

/**
 * Threadlines MCP servers pre-approved in Supervised mode, matching Claude and
 * Codex (`ClaudeAdapter.ts` `allowedTools`, `codexAppServerArgs.ts`
 * `default_tools_approval_mode="approve"`). `threadlines_browser` stays out so
 * browser actions still ask for approval in Supervised mode.
 */
const PREAPPROVED_THREADLINES_MCP_SERVERS: ReadonlySet<string> = new Set([
  ROOM_MCP_SERVER_NAME,
  PAGES_MCP_SERVER_NAME,
  COMMANDS_MCP_SERVER_NAME,
  DEVICE_MCP_SERVER_NAME,
]);

interface AcpSessionContext {
  readonly threadId: ThreadId;
  /** Done once a stop has closed the session's process scope (`whenStopped`). */
  readonly closed: Deferred.Deferred<void>;
  session: ProviderSession;
  /** A room's side runtime: read-only, every request declined, its mode never changed. */
  readonly lockdown: "side-answer" | "side-review" | undefined;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  /** The in-flight `session/prompt`; ACP runs one prompt per session at a time. */
  promptFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  /** This session's turns in order, for the agent's own rewind and fork. */
  history: Array<AcpHistoryEntry>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Head of the current turn's assistant text, kept for plan-gate detection. */
  activeTurnText: string;
  /** Tail of the current turn's assistant text, kept for prompt suggestions. */
  activeTurnReplyTail: string;
  /** Rolling recent user and assistant messages, for isolated prompt suggestions. */
  readonly recentMessages: Array<PromptSuggestionMessage>;
  /** In-flight prompt suggestion fiber for the last completed turn. */
  suggestionFiber: Fiber.Fiber<void, never> | undefined;
  /** Incremented on every turn start, interrupt, or stop so stale suggestions drop. */
  suggestionGeneration: number;
  /** Last provider status this turn (fx rate-limit retries etc.), for failure detail. */
  lastProviderStatus: string | undefined;
  /** Last context fill reported, so repeated identical `usage_update`s stay quiet. */
  lastContextUsageKey: string | undefined;
  /** The agent's session id, as its usage is recorded under. */
  readonly acpSessionId: string;
  /** Attached Threadlines MCP servers pre-approved without asking (room, pages, commands, device). */
  readonly preapprovedMcpServers: ReadonlySet<string>;
  /** What the agent's `initialize` answer says it reads in a prompt. */
  readonly promptCapabilities: EffectAcpSchema.PromptCapabilities | null | undefined;
  /** The subagents this session's tool calls launched (`subagents`), as the thread shows them. */
  readonly subagentRoster: AcpSubagentRoster | undefined;
  /**
   * The session's running cost at the last turn boundary, when it is known
   * exactly: zero for a session opened here, or a report between turns. A turn
   * that ends without a report leaves it unknown, since later totals include
   * a turn whose cost was estimated instead.
   */
  costBaselineUsd: number | undefined;
  /** The running cost the agent last reported. */
  latestCostUsd: number | undefined;
  /** A prompt is open whose cost isn't settled yet; reports outside one mark the boundary. */
  costTurnOpen: boolean;
  /** The agent reported its running cost during the open turn. */
  costReportedThisTurn: boolean;
  /** The thought being streamed; closes when reply text, a tool call, or the turn end arrives. */
  activeReasoning: { readonly itemId: string; readonly turnId: TurnId; text: string } | undefined;
  /** The session cwd and its real path: agents report real paths (macOS `/private/tmp`). */
  readonly cwdRoots: ReadonlyArray<string>;
  /** The plan the agent wrote this turn (prompt-command plan mode). */
  planMarkdown: string | undefined;
  /** Earlier conversation for an agent that starts without it, sent with the first turn. */
  pendingContextPreamble: string | undefined;
  /** The project's brief for the next turn, and the hash the conversation then holds (projectBriefPreface). */
  projectBrief: ProjectBriefPreface;
  /** The brief's hash this conversation holds, kept in the resume cursor. */
  projectBriefHash: string | undefined;
  /**
   * The turn whose prompt last carried the brief, and the hash held before
   * it: a prompt the agent refused, or one a revert removed, queues it again.
   */
  projectBriefCarrier:
    | {
        readonly turnId: TurnId;
        readonly preface: ProjectBriefPreface;
        readonly hashBefore: string | undefined;
      }
    | undefined;
  /** Held while a turn starts, so concurrent sends queue instead of racing. */
  readonly turnStartLock: Semaphore.Semaphore;
  /** The active turn is one the agent started itself; settled when it ends. */
  agentTurn: { readonly turnId: TurnId; readonly ended: Deferred.Deferred<void> } | undefined;
  /** When the agent's own turn last produced anything (ms since epoch). */
  agentTurnLastActivityMs: number;
  /**
   * The agent's own turn as far as the reader has read: begun (its id chosen
   * then, `after` the prompt open at that point) and not yet ended, though the
   * event fiber may not have opened it.
   */
  agentTurnAhead:
    | { readonly turnId: TurnId; readonly after: AcpSessionContext["openPrompt"] }
    | undefined;
  /**
   * The agent's own turn starts (by id) and ends the reader has read and the
   * event fiber has not reached yet, oldest first: output just ahead of a
   * start notice opens that turn.
   */
  readonly queuedAgentTurns: Array<TurnId | "end">;
  /** The turn each running tool call started in, for updates that land after it. */
  readonly toolCallTurns: Map<string, TurnId>;
  /** How the agent said the running prompt ended, from its own notice. */
  promptOutcome: AcpTurnOutcome | undefined;
  /**
   * The prompt whose turn is open. `drained` once the reader is past its
   * last output (the agent began a turn of its own after it), `closed` once
   * its turn has closed.
   */
  openPrompt:
    | {
        readonly turnId: TurnId;
        readonly drained: Deferred.Deferred<void>;
        readonly closed: Deferred.Deferred<void>;
      }
    | undefined;
  /** The newest position the agent has listed, so a later prompt is placed after it. */
  newestPosition: number | undefined;
  /** The turn machine and what its commands need (`descriptor.turnMachine`). */
  readonly machine: AcpMachineSession | undefined;
  stopped: boolean;
}

type AcpTurnCompletedPayload = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"];

/** A failed turn's completion, from how the agent's own words say it failed. */
function failedTurnPayload(
  failure: AcpPromptFailure,
  stopReason: string | null,
): AcpTurnCompletedPayload {
  return {
    state: "failed",
    stopReason,
    errorMessage: failure.errorMessage,
    ...withFailureCategory(failure.failureCategory),
    ...(failure.usageLimit !== undefined ? { usageLimit: failure.usageLimit } : {}),
  };
}

type AcpMachineEvent = AcpTurnEvent<AcpTurnCompletedPayload>;
type AcpMachineCommand = AcpTurnCommand<AcpTurnCompletedPayload>;

/** What a send or a steer hears back from the turn machine. */
type AcpMachineReply =
  | { readonly accepted: TurnId }
  | { readonly rejected: "no-active-turn" | "turn-finishing" };

/** A prompt a send or a steer asked for, until the machine sends it. */
interface AcpMachinePrompt {
  readonly parts: ReadonlyArray<EffectAcpSchema.ContentBlock>;
  /** A send's: the mode and model its turn applies before the prompt goes out. */
  readonly configure: Effect.Effect<void, ProviderAdapterError> | undefined;
  readonly model: string | undefined;
  readonly resolvedModel: string | undefined;
  /** The context preamble this prompt carries; back to the session if it never goes out. */
  readonly preamble: string | undefined;
  /** A send's or a steer's: hears whether its prompt was written to the agent (`reportDelivery`). */
  readonly delivered: Deferred.Deferred<boolean> | undefined;
}

/** A prompt the machine sent, with what its answer is read against. */
interface AcpMachinePromptSent extends AcpMachinePrompt {
  readonly turnId: TurnId;
  /** Its place in the turn: 1 for the turn's first, then each steer's. */
  readonly index: number;
  /** Set by the prompt's fiber before it reports the prompt sent, or answered. */
  watch: AcpPromptOutcomeWatch | undefined;
  exit: Exit.Exit<EffectAcpSchema.PromptResponse, unknown> | undefined;
}

/**
 * A session on the turn machine: the machine's state, which only the event
 * reader steps, and the data its commands carry out (the prompts sends and
 * steers asked for, the turns' models, the armed timers).
 */
interface AcpMachineSession {
  state: AcpTurnMachineState<AcpTurnCompletedPayload>;
  /** Sends and steers waiting on the machine, by id. */
  readonly callers: Map<
    string,
    {
      readonly prompt: AcpMachinePrompt;
      readonly messageId?: string;
      readonly userMessageText?: string;
      readonly suggestNextMessage?: boolean;
      readonly planMode: AcpPromptPlanMode | undefined;
      readonly reply: Deferred.Deferred<AcpMachineReply>;
    }
  >;
  readonly prompts: Map<number, AcpMachinePromptSent>;
  /** Outcome watch kept past prompt deletion so a held turn can re-check after a wake-up reply. */
  readonly watches: Map<
    number,
    {
      readonly watch: AcpPromptOutcomeWatch | undefined;
      readonly stopReason: EffectAcpSchema.StopReason;
      readonly fallback: AcpTurnCompletedPayload;
    }
  >;
  readonly turns: Map<
    string,
    {
      readonly model: string | undefined;
      readonly resolvedModel: string | undefined;
      readonly planMode: AcpPromptPlanMode | undefined;
      /** Set when the turn's opening prompt failed before being written to the agent. */
      setupFailed?: Cause.Cause<unknown>;
      readonly suggestNextMessage: boolean;
      readonly suggestionGeneration: number;
    }
  >;
  readonly timers: Map<AcpTurnTimer, Fiber.Fiber<void, never>>;
  /** When the agent last did anything: quiet timers count from here. */
  lastActivityMs: number;
  /**
   * The prompts the machine sent, in its order: one sender takes them, so
   * each (its turn's mode and model setup first) reaches the agent after
   * every prompt the machine sent before it.
   */
  readonly outbox: Queue.Queue<number>;
  /** Interrupted on session stop before draining `sessionStopping` so no late write slips through. */
  senderFiber?: Fiber.Fiber<void, never>;
}

/**
 * Where a test can hold the turn machine's driver up to force an ordering
 * (`AcpAdapterOptions.turnMachineSeams`). Each runs where it says and may
 * wait; nothing in production sets one.
 */
export type AcpTurnMachineSeam =
  /** On the event reader: a step's state is committed, its commands not yet run. */
  | {
      readonly point: "stepCommitted";
      readonly event: AcpTurnEvent<unknown>["type"];
      readonly commands: ReadonlyArray<AcpTurnCommand<unknown>["type"]>;
      /** Prompt records the driver still holds as the step begins. */
      readonly promptsHeld: number;
    }
  /** On the prompt sender: before a prompt's mode and model setup returns. */
  | { readonly point: "promptSetup"; readonly prompt: number }
  /** On the wire reader: a prompt's answer is read, not yet queued for the event reader. */
  | { readonly point: "answerRead"; readonly prompt: number }
  /** Off the reader: during a prompt's outcome check. */
  | { readonly point: "outcomeRead"; readonly prompt: number }
  /** Stopping a session: everything is settled, its process scope not yet closed. */
  | { readonly point: "processTeardown" }
  /** Off the reader: the child records are read, the reading not yet posted. */
  | { readonly point: "childrenRead"; readonly generation: number };

/** A turn's end payload as the machine reads it. */
function turnPayloadState(payload: AcpTurnCompletedPayload): "completed" | "failed" | "cancelled" {
  return payload.state === "completed" || payload.state === "failed" ? payload.state : "cancelled";
}

/** No tokens: a usage line that carries only a cost. */
const EMPTY_USAGE_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/** Plan-gate replies are one short sentence; more text than this is content. */
const PLAN_GATE_SCAN_MAX_CHARS = 500;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AcpRawRequest = (
  method: string,
  payload: unknown,
) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;

/**
 * One Threadlines turn on a session, and where its prompt sits in the
 * agent's own history once the agent has said (see `conversationHistory`).
 */
interface AcpHistoryEntry {
  readonly turnId: string;
  /** The user message the turn sent. */
  readonly messageId?: string;
  /** A turn the agent started itself: it sent no prompt, so it has no position. */
  readonly agentTurn?: true;
  position?: number;
}

function parseHistoryEntry(raw: unknown): AcpHistoryEntry | undefined {
  if (!isRecord(raw) || typeof raw.turnId !== "string" || !raw.turnId) return undefined;
  return {
    turnId: raw.turnId,
    ...(typeof raw.messageId === "string" && raw.messageId ? { messageId: raw.messageId } : {}),
    ...(raw.agentTurn === true ? { agentTurn: true as const } : {}),
    ...(typeof raw.position === "number" && Number.isInteger(raw.position) && raw.position >= 0
      ? { position: raw.position }
      : {}),
  };
}

export function parseAcpResumeCursor(raw: unknown):
  | {
      sessionId: string;
      history: ReadonlyArray<AcpHistoryEntry>;
      newestPosition: number | undefined;
      projectBriefHash: string | undefined;
    }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const history = Array.isArray(raw.history)
    ? raw.history.flatMap((entry) => parseHistoryEntry(entry) ?? [])
    : [];
  const newest = raw.newestPosition;
  return {
    sessionId: raw.sessionId.trim(),
    history,
    newestPosition:
      typeof newest === "number" && Number.isInteger(newest) && newest >= 0 ? newest : undefined,
    projectBriefHash: readProjectBriefHash(raw),
  };
}

function makeAcpResumeCursor(
  sessionId: string,
  history: ReadonlyArray<AcpHistoryEntry>,
  newestPosition: number | undefined,
  projectBriefHash: string | undefined,
) {
  return {
    schemaVersion: ACP_RESUME_VERSION,
    sessionId,
    ...(history.length > 0
      ? { history: history.slice(-ACP_HISTORY_CURSOR_LIMIT).map((entry) => ({ ...entry })) }
      : {}),
    ...(newestPosition !== undefined ? { newestPosition } : {}),
    ...(projectBriefHash !== undefined ? { projectBriefHash } : {}),
  };
}

/**
 * Where a fork's copy of the source conversation is rewound to, by the
 * boundary the fork asks for: before a turn (its prompt and what came after
 * go), or through one (the next prompt after it and what follows go).
 * `undefined` keeps the whole copy; `"unknown"` when the source's positions
 * don't cover the boundary, and the fork can't be made exactly.
 */
function forkRewindPosition(
  history: ReadonlyArray<AcpHistoryEntry> | undefined,
  boundary: {
    readonly beforeTurnId?: string | undefined;
    readonly lastTurnId?: string | undefined;
  },
): number | undefined | "unknown" {
  if (boundary.beforeTurnId === undefined && boundary.lastTurnId === undefined) return undefined;
  if (history === undefined) return "unknown";
  if (boundary.beforeTurnId !== undefined) {
    return history.find((entry) => entry.turnId === boundary.beforeTurnId)?.position ?? "unknown";
  }
  const index = history.findIndex((entry) => entry.turnId === boundary.lastTurnId);
  if (index < 0) return "unknown";
  const next = history[index + 1];
  if (next === undefined) return undefined;
  // The agent's own turn right after it has no prompt to rewind to: the copy
  // would keep it, beyond the fork's boundary.
  if (next.agentTurn === true) return "unknown";
  return next.position ?? "unknown";
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

/**
 * Picks the ACP session mode for the requested interaction/runtime mode.
 * Exported for tests; agents name their modes differently, so matching is
 * alias-based with a "first non-plan mode" fallback.
 */
export function resolveRequestedAcpModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

/**
 * File-change evidence from a finished edit's ACP `diff` content: exact
 * per-file +/- for paths inside the session's workspace. Only an edit that
 * completed counts; a denied or failed one changed nothing. A relative path
 * is the agent's, so it resolves against the session cwd (`cwdRoots[0]`).
 */
export function acpDiffFileChanges(
  toolCall: AcpToolCallState,
  cwdRoots: ReadonlyArray<string>,
  pathApi: Pick<Path.Path, "relative" | "isAbsolute" | "resolve" | "sep">,
): ReadonlyArray<{
  readonly path: string;
  readonly kind: "add" | "update" | "delete";
  readonly additions: number;
  readonly deletions: number;
}> {
  if (toolCall.status !== "completed") return [];
  if (toolCall.kind !== "edit" && toolCall.kind !== "delete" && toolCall.kind !== "move") return [];
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry: unknown) => {
    if (!isRecord(entry) || entry.type !== "diff") return [];
    const { path: filePath, oldText, newText } = entry;
    if (typeof filePath !== "string" || typeof newText !== "string") return [];
    const sessionCwd = cwdRoots[0];
    const absolute =
      pathApi.isAbsolute(filePath) || sessionCwd === undefined
        ? filePath
        : pathApi.resolve(sessionCwd, filePath);
    const relative = relativeToAnyRoot(absolute, cwdRoots, pathApi);
    if (relative === undefined) return [];
    const before = typeof oldText === "string" ? oldText : undefined;
    const stats = countTextReplacementStats(before, newText);
    const kind =
      toolCall.kind === "delete" && newText.length === 0
        ? "delete"
        : before === undefined
          ? "add"
          : "update";
    return [{ path: relative, kind, ...stats }];
  });
}

function relativeToAnyRoot(
  filePath: string,
  roots: ReadonlyArray<string>,
  pathApi: Pick<Path.Path, "relative" | "isAbsolute" | "sep">,
): string | undefined {
  for (const root of roots) {
    const relative = pathApi.relative(root, filePath);
    if (relative.length > 0 && !relative.startsWith("..") && !pathApi.isAbsolute(relative)) {
      return relative.split(pathApi.sep).join("/");
    }
  }
  return undefined;
}

/**
 * A failure category as reported, except a refusal that came with a provider
 * status: an exhausted rate-limit retry also ends as a bare refusal, and the
 * status, part of the message, tells them apart.
 */
function reportedFailureCategory(
  category: ProviderFailureCategory | undefined,
  providerStatus: string | undefined,
): ProviderFailureCategory | undefined {
  return category === "refusal" && providerStatus ? undefined : category;
}

/** An ACP sign-in-required error, as thrown or as the cause of the adapter's wrapper. */
function isAuthRequiredFailure(error: unknown): boolean {
  const wrapped =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return isAcpAuthRequiredError(error) || isAcpAuthRequiredError(wrapped);
}

export function makeAcpAdapter<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  options?: AcpAdapterOptions<Settings>,
) {
  const PROVIDER = descriptor.driverKind;
  const resolveModelId = descriptor.resolveModelId ?? defaultResolveAcpModelId;
  const extensionSource = descriptor.extensions?.source;

  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, AcpSessionContext>();
    /** Each agent process it started, until proven gone (confirmThreadStopped). */
    const processes = yield* makeAgentProcessLedger();
    /**
     * Each agent session's turn history by its id, kept after the session
     * stops: a fork of it finds its boundary here.
     */
    const historyBySession = new Map<
      string,
      {
        readonly history: ReadonlyArray<AcpHistoryEntry>;
        readonly newest: number | undefined;
        readonly cwd: string;
      }
    >();
    const adapterScope = yield* Scope.Scope;
    /**
     * Sessions the agent can no longer continue, as this adapter marked them
     * (`markSessionLost`). ProviderService forgets each in the thread's
     * binding when the session's exit says so (`conversationLost`); until it
     * has, a start asked to resume one opens a new conversation here anyway,
     * so a message sent right after the exit can't reopen it.
     */
    const lostSessions = new Set<string>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(
        // The subagent view follows the session's turns and usage updates.
        Effect.andThen(
          Effect.suspend(
            () => sessions.get(event.threadId)?.subagentRoster?.observe(event) ?? Effect.void,
          ),
        ),
      );

    /** The prompt that carried the brief is gone: the conversation holds what it held before. */
    const requeueProjectBrief = (ctx: AcpSessionContext) => {
      const carrier = ctx.projectBriefCarrier;
      if (carrier === undefined) return;
      ctx.projectBriefCarrier = undefined;
      ctx.projectBriefHash = carrier.hashBefore;
      ctx.projectBrief = carrier.preface;
      recordHistory(ctx);
    };

    /** Saves the session's turn history in its resume cursor, and for forks of it. */
    const recordHistory = (ctx: AcpSessionContext) => {
      const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
      if (sessionId === undefined) return;
      ctx.session = {
        ...ctx.session,
        resumeCursor: makeAcpResumeCursor(
          sessionId,
          ctx.history,
          ctx.newestPosition,
          ctx.projectBriefHash,
        ),
      };
      historyBySession.set(sessionId, {
        history: ctx.history.map((entry) => ({ ...entry })),
        newest: ctx.newestPosition,
        cwd: ctx.session.cwd ?? "",
      });
    };

    /**
     * Asks the agent where the prompt this turn sent sits in its history,
     * once the turn has ended, for a later revert or fork to rewind to.
     */
    const recordPromptPosition = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      promptText: string,
      newestBefore: number | undefined,
    ) =>
      Effect.gen(function* () {
        const history = descriptor.conversationHistory;
        const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
        const index = ctx.history.findIndex((candidate) => candidate.turnId === turnId);
        const entry = ctx.history[index];
        if (history === undefined || sessionId === undefined || entry === undefined) return;
        // Everything the agent had listed before this prompt went out is
        // older than it: an earlier turn's prompt, or what was steered in.
        const earlier = ctx.history
          .slice(0, index)
          .flatMap((candidate) => (candidate.position === undefined ? [] : [candidate.position]));
        if (newestBefore !== undefined) earlier.push(newestBefore);
        const placed = yield* history
          .promptPosition({
            acp: ctx.acp,
            sessionId,
            promptText,
            after: earlier.length > 0 ? Math.max(...earlier) : undefined,
          })
          .pipe(
            Effect.timeoutOption(ACP_HISTORY_POSITION_TIMEOUT),
            Effect.map(Option.getOrUndefined),
            Effect.catch((cause) =>
              Effect.logWarning("acp.history.position-unavailable", {
                provider: PROVIDER,
                threadId: ctx.threadId,
                cause: cause.message,
              }).pipe(Effect.as(undefined)),
            ),
          );
        if (placed === undefined) return;
        if (placed.newest !== undefined) {
          ctx.newestPosition = Math.max(ctx.newestPosition ?? placed.newest, placed.newest);
        }
        if (placed.position !== undefined) entry.position = placed.position;
        recordHistory(ctx);
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    /**
     * ACP streams reasoning as `agent_thought_chunk`s. A run of them becomes
     * one "Thinking" reasoning item, the same shape Claude's thinking blocks
     * take: started on the first chunk, the text streamed as a readable
     * summary, and the whole thought carried on completion.
     */
    const appendReasoning = (ctx: AcpSessionContext, text: string, rawPayload: unknown) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (!turnId) {
          return;
        }
        if (!ctx.activeReasoning) {
          ctx.activeReasoning = { itemId: `reasoning:${yield* randomUUIDv4}`, turnId, text: "" };
          yield* offerRuntimeEvent({
            type: "item.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(ctx.activeReasoning.itemId),
            payload: { itemType: "reasoning", status: "inProgress", title: "Thinking" },
          });
        }
        ctx.activeReasoning.text += text;
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(ctx.activeReasoning.itemId),
          payload: { streamKind: "reasoning_summary_text", delta: text },
          raw: { source: "acp.jsonrpc", method: "session/update", payload: rawPayload },
        });
      });

    const closeReasoning = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        const reasoning = ctx.activeReasoning;
        if (!reasoning) {
          return;
        }
        ctx.activeReasoning = undefined;
        const summary = reasoning.text.trim();
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: reasoning.turnId,
          itemId: RuntimeItemId.make(reasoning.itemId),
          payload: {
            itemType: "reasoning",
            status: "completed",
            title: "Thinking",
            ...(summary.length > 0 ? { data: { summary } } : {}),
          },
        });
      });

    const emitPlanUpdate = (
      ctx: AcpSessionContext,
      payload: AcpPlanUpdate,
      rawPayload: unknown,
      source: "acp.jsonrpc" | `acp.${string}.extension`,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    /** Clears what a turn accumulates, for a turn starting now. */
    const resetTurnState = (ctx: AcpSessionContext) => {
      ctx.lastPlanFingerprint = undefined;
      ctx.activeTurnText = "";
      ctx.activeTurnReplyTail = "";
      ctx.lastProviderStatus = undefined;
      ctx.planMarkdown = undefined;
      ctx.promptOutcome = undefined;
      ctx.costTurnOpen = true;
      ctx.costReportedThisTurn = false;
    };

    const pushRecentMessage = (
      ctx: AcpSessionContext,
      role: PromptSuggestionMessage["role"],
      rawText: string,
    ) => {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) return;
      const text =
        trimmed.length <= PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE
          ? trimmed
          : trimmed.slice(trimmed.length - PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE);
      ctx.recentMessages.push({ role, text });
      if (ctx.recentMessages.length > PROMPT_SUGGESTION_MAX_MESSAGES) {
        ctx.recentMessages.splice(0, ctx.recentMessages.length - PROMPT_SUGGESTION_MAX_MESSAGES);
      }
    };

    /** Cancels any in-flight suggestion for this session because the thread moved on. */
    const dropSuggestion = (ctx: AcpSessionContext) =>
      Effect.suspend(() => {
        ctx.suggestionGeneration += 1;
        const fiber = ctx.suggestionFiber;
        ctx.suggestionFiber = undefined;
        return fiber ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void;
      });

    /** Samples the user's likely next message in the background after a completed user turn. */
    const startSuggestion = (
      ctx: AcpSessionContext,
      promptSuggestions: NonNullable<AcpAdapterOptions<Settings>["promptSuggestions"]>,
      input: {
        readonly turnId: TurnId;
        readonly model: string | undefined;
        readonly completedEventId: EventId;
      },
    ) =>
      Effect.gen(function* () {
        yield* dropSuggestion(ctx);
        if (ctx.stopped || ctx.lockdown !== undefined || ctx.recentMessages.length === 0) return;
        const generation = ctx.suggestionGeneration;
        const messages = [...ctx.recentMessages];
        const fiber = yield* Effect.gen(function* () {
          if (!(yield* promptSuggestions.shouldSuggest(input.model))) return;
          if (ctx.stopped || ctx.suggestionGeneration !== generation) return;
          const sampled = yield* promptSuggestions.sample({
            cwd: ctx.session.cwd ?? ctx.cwdRoots[0] ?? process.cwd(),
            model: input.model,
            messages,
          });
          const suggestion = sanitizePromptSuggestion(sampled);
          if (
            suggestion === undefined ||
            ctx.stopped ||
            ctx.suggestionGeneration !== generation ||
            !(yield* promptSuggestions.shouldSuggest(input.model))
          ) {
            return;
          }
          yield* offerRuntimeEvent({
            type: "turn.prompt-suggestion.updated",
            eventId: EventId.make(`${input.completedEventId}:prompt-suggestion`),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: ctx.threadId,
            turnId: input.turnId,
            payload: { suggestion },
          });
        }).pipe(
          Effect.withSpan("AcpAdapter.suggestNextMessage"),
          Effect.catchCause((cause) =>
            Effect.logDebug("ACP made no prompt suggestion", {
              provider: PROVIDER,
              threadId: ctx.threadId,
              cause,
            }),
          ),
          Effect.forkIn(ctx.scope),
        );
        ctx.suggestionFiber = fiber;
      });

    /**
     * Writes down what a finished prompt spent: the tokens on its result and
     * the change in the session's running cost across it, when the cost is
     * known at both ends. Settles the cost boundary for the next turn either
     * way. A prompt the cancel deadline cut off records nothing: it returned
     * no tokens, and the session is gone.
     */
    const settleTurnUsage = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      model: string | undefined,
      totals: UsageTokenTotals | null,
    ) =>
      Effect.gen(function* () {
        const costUsd =
          ctx.costReportedThisTurn &&
          ctx.costBaselineUsd !== undefined &&
          ctx.latestCostUsd !== undefined
            ? Math.max(0, ctx.latestCostUsd - ctx.costBaselineUsd)
            : null;
        ctx.costBaselineUsd = ctx.costReportedThisTurn ? ctx.latestCostUsd : undefined;
        // Settled: a report from here on (one landing while this line is
        // written included) is the next turn's starting point.
        ctx.costTurnOpen = false;
        const record = options?.recordTurnUsage;
        if (!record || (totals === null && costUsd === null)) return;
        yield* record({
          atMs: yield* Clock.currentTimeMillis,
          sessionId: ctx.acpSessionId,
          turnId,
          model: model ?? ctx.session.model ?? "default",
          totals: totals ?? {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          costUsd,
        });
      });

    /**
     * Opens a turn the agent started itself (`agentTurns`): its wake-up
     * after background work, opened on the extension's notice (in order with
     * the updates, `beginAgentTurnInOrder`) or on the first output that
     * arrives while no turn runs, the way Claude's synthetic turns open.
     */
    const openAgentTurn = (
      ctx: AcpSessionContext,
      raw: { method: string; payload: unknown },
      turnId: TurnId = TurnId.make(crypto.randomUUID()),
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.activeTurnId !== undefined) return;
        yield* dropSuggestion(ctx);
        ctx.activeTurnId = turnId;
        ctx.agentTurn = { turnId, ended: yield* Deferred.make<void>() };
        ctx.agentTurnLastActivityMs = Date.now();
        ctx.history.push({ turnId, agentTurn: true });
        recordHistory(ctx);
        resetTurnState(ctx);
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {},
          raw: {
            source: extensionSource ?? "acp.jsonrpc",
            method: raw.method,
            payload: raw.payload,
          },
        });
        yield* watchAgentTurnQuiet(ctx, turnId).pipe(Effect.forkIn(ctx.scope));
      });

    /**
     * The extension's notice that the agent began a turn of its own, reached
     * in order. `after` is the prompt that was open when the notice arrived:
     * if its turn is still open it has had all its output by now, so it may
     * close without waiting for the reader, and the agent's turn opens once
     * it has. Its answer is due; one that never comes is a stuck prompt, which
     * Stop recycles.
     */
    const beginAgentTurnInOrder = (
      ctx: AcpSessionContext,
      raw: { method: string; payload: unknown },
      after: AcpSessionContext["openPrompt"],
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        ctx.queuedAgentTurns.shift();
        if (after !== undefined && ctx.openPrompt === after) {
          yield* Deferred.succeed(after.drained, undefined);
          yield* Deferred.await(after.closed);
        }
        // Opened already by the output just ahead of this notice, or opens now.
        yield* openAgentTurn(ctx, raw, turnId);
        // Not opened (a turn already runs): requests go to the running one.
        if (ctx.agentTurn?.turnId !== turnId && ctx.agentTurnAhead?.turnId === turnId) {
          ctx.agentTurnAhead = undefined;
        }
      });

    /**
     * Closes the agent's own turn. Reached in order (the extension's end
     * notice), everything before it is out and the runtime ended the reply at
     * the boundary. From anywhere else (a sent message, a long quiet) the
     * reply is ended and the queue flushed first.
     */
    const closeAgentTurn = (
      ctx: AcpSessionContext,
      outcome: AcpTurnOutcome,
      reached: "in-order" | "out-of-order" = "out-of-order",
    ) =>
      Effect.gen(function* () {
        const agentTurn = ctx.agentTurn;
        if (agentTurn === undefined) return;
        if (reached === "out-of-order") {
          // Its reply ends with it: the next turn's text is a message of its own.
          yield* ctx.acp.closeAssistantSegment;
          yield* ctx.acp.flushEvents();
          if (ctx.agentTurn !== agentTurn) return;
        }
        yield* closeReasoning(ctx);
        ctx.agentTurn = undefined;
        if (ctx.agentTurnAhead?.turnId === agentTurn.turnId) ctx.agentTurnAhead = undefined;
        if (ctx.activeTurnId === agentTurn.turnId) ctx.activeTurnId = undefined;
        ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: agentTurn.turnId,
          payload: {
            state: outcome.state,
            stopReason: outcome.stopReason ?? null,
            ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
            ...(outcome.state === "failed"
              ? withFailureCategory(
                  reportedFailureCategory(outcome.failureCategory, ctx.lastProviderStatus),
                )
              : {}),
          },
        });
        yield* Deferred.succeed(agentTurn.ended, undefined);
      });

    /**
     * Closes an agent turn whose end notice never came, after a long quiet.
     * One waiting on the user's approval or answer isn't quiet: it stays open.
     */
    const watchAgentTurnQuiet = (ctx: AcpSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        while (ctx.agentTurn?.turnId === turnId) {
          yield* Effect.sleep(ACP_AGENT_TURN_QUIET_CHECK);
          if (ctx.agentTurn?.turnId !== turnId) return;
          if (ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0) {
            ctx.agentTurnLastActivityMs = Date.now();
            continue;
          }
          if (
            Date.now() - ctx.agentTurnLastActivityMs >=
            Duration.toMillis(ACP_AGENT_TURN_QUIET_LIMIT)
          ) {
            yield* closeAgentTurn(ctx, { state: "completed" });
            return;
          }
        }
      });

    /**
     * A permission request as the descriptor describes its tool call
     * (`normalizeToolCall`): an MCP call the agent runs through a command
     * shows the server, tool and arguments it runs, under the same kind.
     */
    /**
     * What an open approval is for once a later update about its call arrived
     * (`latest`, the call as the session now shows it), or `undefined` when
     * that hasn't changed. The request keeps its kind, as on first asking.
     */
    const reaskedPermissionRequest = (
      params: EffectAcpSchema.RequestPermissionRequest,
      current: AcpPermissionRequest,
      latest: AcpToolCallState,
    ): AcpPermissionRequest | undefined => {
      const merged =
        current.toolCall === undefined ? latest : mergeToolCallState(current.toolCall, latest);
      // The session's own classification of the call is the newest word on it.
      const toolCall: AcpToolCallState =
        latest.itemType !== undefined ? { ...merged, itemType: latest.itemType } : merged;
      const described = describePermissionRequest(params, toolCall);
      const detail = toolCall.itemType !== undefined ? toolCall.detail : described.detail;
      const next: AcpPermissionRequest = {
        kind: current.kind,
        ...(detail !== undefined ? { detail } : {}),
        toolCall,
      };
      // Tied to what it would authorize, not only to how it reads.
      const same =
        next.detail === current.detail &&
        next.toolCall?.title === current.toolCall?.title &&
        toolCallSubstance(next.toolCall) === toolCallSubstance(current.toolCall);
      return same ? undefined : next;
    };

    const normalizedPermissionRequest = (
      request: AcpPermissionRequest,
      report: EffectAcpSchema.RequestPermissionRequest["toolCall"],
    ): AcpPermissionRequest => {
      const normalize = descriptor.normalizeToolCall;
      if (normalize === undefined || request.toolCall === undefined) return request;
      const toolCall = normalize(request.toolCall, report as AcpToolCallReport);
      // The request keeps its kind, so it is asked and answered as before; a
      // call the descriptor retyped shows its own detail (what really runs).
      const detail = toolCall.itemType !== undefined ? toolCall.detail : request.detail;
      return {
        kind: request.kind,
        ...(detail !== undefined ? { detail } : {}),
        toolCall,
      };
    };

    /**
     * The turn an update belongs to: for a tool call that started in an
     * earlier turn (a background shell), that turn; else the active one;
     * else, for an agent that starts its own turns, a new agent turn.
     */
    const turnForOutput = (ctx: AcpSessionContext, toolCallId?: string) =>
      Effect.gen(function* () {
        if (ctx.agentTurn !== undefined) ctx.agentTurnLastActivityMs = Date.now();
        const earlier = toolCallId === undefined ? undefined : ctx.toolCallTurns.get(toolCallId);
        // On the turn machine, output is an event: it opens a reply, or the
        // agent's own turn when none runs. A late update for an earlier
        // turn's tool opens nothing.
        const machine = ctx.machine;
        if (machine !== undefined) {
          if (earlier === undefined || machine.state.turn !== undefined) {
            yield* applyTurnEvent(ctx, {
              type: "agentOutput",
              newTurnId: crypto.randomUUID(),
            });
          } else {
            yield* noteActivity(machine);
          }
          return earlier ?? ctx.activeTurnId;
        }
        if (earlier !== undefined) return earlier;
        if (ctx.activeTurnId !== undefined) return ctx.activeTurnId;
        if (!descriptor.agentTurns) return undefined;
        // Output just ahead of a start notice is that turn's.
        const next = ctx.queuedAgentTurns[0];
        yield* openAgentTurn(
          ctx,
          { method: "session/update", payload: {} },
          next === "end" ? undefined : next,
        );
        return ctx.activeTurnId;
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /**
     * What each session last advertised, for `agentCommands` descriptors:
     * every name (a typed `/name` is its command, hidden ones included) and
     * the list the composer shows, reported through `onSessionCommands` no
     * more than once per `ACP_SESSION_COMMANDS_INTERVAL` and never unchanged.
     */
    const sessionCommandState = new WeakMap<
      AcpSessionContext,
      {
        names: ReadonlySet<string>;
        reported: ReadonlyArray<ServerProviderSlashCommand> | undefined;
        reportedAtMs: number;
        pending: ReadonlyArray<ServerProviderSlashCommand> | undefined;
      }
    >();

    const noteSessionCommands = (
      ctx: AcpSessionContext,
      commands: ReadonlyArray<ServerProviderSlashCommand>,
    ) =>
      Effect.gen(function* () {
        const hidden = descriptor.agentCommands?.hidden;
        const shown = commands.filter((command) => !hidden?.has(command.name));
        const report = options?.onSessionCommands;
        let state = sessionCommandState.get(ctx);
        if (state === undefined) {
          state = { names: new Set(), reported: undefined, reportedAtMs: 0, pending: undefined };
          sessionCommandState.set(ctx, state);
          // The list goes with the session.
          if (report !== undefined) {
            yield* Scope.addFinalizer(ctx.scope, report(ctx.threadId, undefined));
          }
        }
        state.names = new Set(commands.map((command) => command.name));
        if (report === undefined) return;
        const current = state.pending ?? state.reported;
        if (current !== undefined && sameSlashCommands(current, shown)) return;
        const waitMs = state.reportedAtMs + ACP_SESSION_COMMANDS_INTERVAL_MS - Date.now();
        if (waitMs <= 0 && state.pending === undefined) {
          state.reported = shown;
          state.reportedAtMs = Date.now();
          yield* report(ctx.threadId, shown);
          return;
        }
        // Too soon after the last report: the newest list goes when the
        // interval is up, and lists in between are never sent.
        const scheduled = state.pending !== undefined;
        state.pending = shown;
        if (scheduled) return;
        const flushing = state;
        yield* Effect.sleep(Math.max(0, waitMs)).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const next = flushing.pending;
              flushing.pending = undefined;
              if (next === undefined) return Effect.void;
              if (flushing.reported !== undefined && sameSlashCommands(flushing.reported, next)) {
                return Effect.void;
              }
              flushing.reported = next;
              flushing.reportedAtMs = Date.now();
              return report(ctx.threadId, next);
            }),
          ),
          Effect.forkIn(ctx.scope),
        );
      });

    /**
     * Whether a typed `/name` runs one of the agent's own commands: one this
     * session advertised, or a skill the status lists.
     */
    const isAgentCommand = (ctx: AcpSessionContext, name: string) =>
      Effect.gen(function* () {
        if (sessionCommandState.get(ctx)?.names.has(name) === true) return true;
        const skills = options?.skillNames;
        return skills === undefined ? false : (yield* skills).has(name);
      });

    const stopSessionInternal = (
      ctx: AcpSessionContext,
      exitKind: "graceful" | "error" = "graceful",
      exit?: { readonly conversationLost?: { readonly sessionCreatedAt: string } },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* dropSuggestion(ctx);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        // The agent's process takes its subagents with it.
        if (ctx.subagentRoster !== undefined) yield* ctx.subagentRoster.end;
        if (ctx.promptFiber) {
          yield* Fiber.interrupt(ctx.promptFiber);
        }
        // On the turn machine the stop is an event: the reader gets to it
        // after everything already queued (an answer and its usage, a turn's
        // end), and only then is it stopped.
        const machine = ctx.machine;
        if (machine?.senderFiber !== undefined) {
          yield* Fiber.interrupt(machine.senderFiber);
        }
        const drained =
          machine === undefined || ctx.notificationFiber === undefined
            ? false
            : yield* Effect.gen(function* () {
                const done = yield* Deferred.make<void>();
                yield* ctx.acp.inOrder(
                  applyTurnEvent(ctx, { type: "sessionStopping" }).pipe(
                    Effect.andThen(Deferred.succeed(done, undefined)),
                    Effect.asVoid,
                  ),
                );
                return Option.isSome(
                  yield* Deferred.await(done).pipe(Effect.timeoutOption(ACP_STOP_DRAIN_LIMIT)),
                );
              });
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        if (machine !== undefined) {
          // A reader that never got there: the stop is stepped here instead.
          if (!drained) yield* applyTurnEvent(ctx, { type: "sessionStopping" });
          for (const [id, caller] of machine.callers) {
            machine.callers.delete(id);
            yield* Deferred.succeed(caller.reply, { rejected: "no-active-turn" });
            if (caller.prompt.delivered !== undefined) {
              yield* Deferred.succeed(caller.prompt.delivered, false);
            }
          }
          // Nothing more goes out: a prompt not yet written never will be.
          for (const sent of machine.prompts.values()) {
            if (sent.delivered !== undefined) yield* Deferred.succeed(sent.delivered, false);
          }
        }

        yield* seam({ point: "processTeardown" });
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* Deferred.succeed(ctx.closed, undefined);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind, ...exit },
        });
      });

    /**
     * Tells the descriptor when the agent answered `auth_required`, given the
     * ACP error or the adapter error that wraps it. Never fails or dies: a
     * turn must complete whatever the hook does.
     */
    const notifyAuthRequired = (error: unknown): Effect.Effect<void> => {
      const onAuthRequired = descriptor.onAuthRequired;
      if (!onAuthRequired || !isAuthRequiredFailure(error)) return Effect.void;
      return Effect.suspend(() => onAuthRequired(settings)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ACP onAuthRequired hook failed", {
            provider: PROVIDER,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

    const applyRequestedSessionConfiguration = (input: {
      readonly runtime: AcpSessionRuntimeShape;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode | undefined;
      /** A side runtime keeps the mode it started in: its lockdown. */
      readonly lockedDown: boolean;
      readonly modelSelection:
        | {
            readonly model: string;
            readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
          }
        | undefined;
    }): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (input.modelSelection) {
          yield* applyAcpModelSelection({
            descriptor,
            runtime: input.runtime,
            model: input.modelSelection.model,
            selections: input.modelSelection.options,
            mapError: ({ cause }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          });
        }

        // Native controls: the agent's mode is the user's to pick (an option),
        // never inferred from the runtime mode.
        if (descriptor.sessionControls === "native" || input.lockedDown) {
          return;
        }
        const modeState = yield* input.runtime.getModeState;
        const mappedModeId = descriptor.agentModeFor?.({
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          availableModeIds: modeState?.availableModes.map((mode) => mode.id) ?? [],
        });
        const requestedModeId =
          mappedModeId !== undefined &&
          modeState?.availableModes.some((mode) => mode.id === mappedModeId)
            ? mappedModeId
            : resolveRequestedAcpModeId({
                interactionMode: input.interactionMode,
                runtimeMode: input.runtimeMode,
                modeState,
              });
        if (!requestedModeId) {
          return;
        }
        yield* input.runtime
          .setMode(requestedModeId)
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
            ),
          );
        // An agent can also answer `auth_required` to a model or option change.
      }).pipe(Effect.tapError(notifyAuthRequired));

    const startSession: AcpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          // A side answer must be read-only for certain. Only an agent whose
          // descriptor can lock it down here runs one, and always fresh: its
          // locked-down process can't reach the conversation it would fork.
          const lockdown = input.lockdown;
          const sideRuntime = lockdown === undefined ? undefined : descriptor.sideRuntime;
          if (
            lockdown !== undefined &&
            (sideRuntime === undefined || !driverAnswersOnTheSide(descriptor.driverKind))
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "This provider cannot answer on the side while another agent works.",
            });
          }
          if (lockdown !== undefined && input.forkFrom !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "A side answer from this provider starts fresh; it can't fork the conversation.",
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
          const boundModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          /**
           * The approvals waiting on the user, by the tool call they ask
           * about: an update that changes what one is for asks it again.
           */
          const openApprovals = new Map<
            string,
            { readonly reask: (latest: AcpToolCallState) => Effect.Effect<void> }
          >();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: AcpSessionContext;

          const resumed = parseAcpResumeCursor(input.resumeCursor);
          // A session the agent can no longer continue is not reopened: the
          // thread starts a new one with its history, as after a failed resume.
          const lostSession =
            resumed !== undefined && lostSessions.has(resumed.sessionId)
              ? resumed.sessionId
              : undefined;
          const resumeSessionId = lostSession === undefined ? resumed?.sessionId : undefined;
          // A native fork opens on the agent's copy of the source conversation,
          // up to the boundary. One it can't make exactly (a boundary it can't
          // place, or one before the first prompt) fails here, and the caller
          // seeds the thread from its transcript instead.
          const conversationHistory = descriptor.conversationHistory;
          let forkSession:
            | ((request: AcpRawRequest) => Effect.Effect<string, EffectAcpErrors.AcpError>)
            | undefined;
          let forkNewest: number | undefined;
          if (input.forkFrom !== undefined) {
            const source = historyBySession.get(input.forkFrom.providerThreadId);
            const rewindTo =
              conversationHistory === undefined
                ? "unknown"
                : forkRewindPosition(source?.history, input.forkFrom);
            if (conversationHistory === undefined || rewindTo === "unknown" || rewindTo === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "This conversation can't be forked at that turn.",
              });
            }
            const throughPosition = rewindTo === undefined ? undefined : rewindTo - 1;
            const sourceSessionId = input.forkFrom.providerThreadId;
            forkSession = (request) =>
              conversationHistory.fork({
                request,
                sessionId: sourceSessionId,
                sourceCwd: source?.cwd || cwd,
                cwd,
                throughPosition,
              });
            // The copy lists the source's prompts, up to the boundary.
            forkNewest = throughPosition ?? source?.newest;
          }
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const effectiveSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : settings;
          // The browser the user has open, offered as tools: the same HTTP
          // endpoint Codex and Claude use, with a credential naming the thread
          // because the tools take no thread argument. In a room, the room
          // tools too, on the same credential. Neither when the agent cannot
          // reach this machine's loopback (fx under WSL). The credential dies
          // with the session's scope.
          const reachesHost = descriptor.reachesHostLoopback?.(process.platform) !== false;
          const roomToolsRequested = input.roomTools === true;
          // The room endpoint, with every room tool its kind allows or the app
          // guide alone (roomEndpointGrant). A side runtime gets only the
          // room's read tools: no browser, pages, commands or schedules.
          const sideKind = roomSideKindOf(lockdown);
          const roomGrant = roomEndpointGrant(input, sideKind);
          // The page tools ride the same credential. An ACP agent hears no
          // instructions of ours, so the tool descriptions carry the rules and
          // a misplaced image's error names the thread's image folder.
          const agentPagesRequested = input.agentPages === true && lockdown === undefined;
          // `ask_user_to_run` likewise: its description carries the rules.
          const commandRequestsRequested = input.commandRequests === true && lockdown === undefined;
          // The device tools likewise.
          const deviceToolsRequested = input.deviceTools === true && lockdown === undefined;
          const credential =
            reachesHost && (lockdown === undefined || roomGrant.attach)
              ? yield* mcpSessionRegistry.credentialFor({
                  sessionKey: input.threadId,
                  browser: lockdown === undefined,
                  room: roomGrant.attach,
                  pages: agentPagesRequested,
                  commands: commandRequestsRequested,
                  device: deviceToolsRequested,
                  ...(sideKind !== undefined ? { sideKind } : {}),
                  scheduledRun: lockdown === undefined && input.scheduledRunTools === true,
                  guideOnly: roomGrant.guideOnly,
                })
              : undefined;
          if (credential !== undefined) {
            yield* Scope.addFinalizer(
              sessionScope,
              mcpSessionRegistry.revoke(input.threadId, credential.generation),
            );
          }
          const authorization = [
            { name: "Authorization", value: `Bearer ${credential?.token ?? ""}` },
          ];
          const mcpServers: Array<EffectAcpSchema.McpServer> =
            credential === undefined
              ? []
              : [
                  ...(lockdown === undefined
                    ? [
                        {
                          type: "http" as const,
                          name: BROWSER_MCP_SERVER_NAME,
                          url: mcpEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(roomGrant.attach
                    ? [
                        {
                          type: "http" as const,
                          name: ROOM_MCP_SERVER_NAME,
                          url: mcpRoomEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(agentPagesRequested
                    ? [
                        {
                          type: "http" as const,
                          name: PAGES_MCP_SERVER_NAME,
                          url: mcpPagesEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(commandRequestsRequested
                    ? [
                        {
                          type: "http" as const,
                          name: COMMANDS_MCP_SERVER_NAME,
                          url: mcpCommandsEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(deviceToolsRequested
                    ? [
                        {
                          type: "http" as const,
                          name: DEVICE_MCP_SERVER_NAME,
                          url: mcpDeviceEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                ];

          // A side runtime's process is the descriptor's locked-down one; what
          // it sets up (a throwaway home) goes with the session's scope.
          const side =
            sideRuntime === undefined || lockdown === undefined
              ? undefined
              : yield* sideRuntime({
                  settings: effectiveSettings,
                  cwd,
                  environment: options?.environment ?? process.env,
                  kind: lockdown === "side-review" ? "review" : "ask",
                  childProcessSpawner,
                }).pipe(
                  Effect.provideService(Scope.Scope, sessionScope),
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: input.threadId,
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
          const runtimeDescriptor =
            side === undefined ? descriptor : { ...descriptor, spawn: () => side.spawn };
          const acp = yield* makeAcpProviderRuntime(runtimeDescriptor, {
            settings: effectiveSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(forkSession !== undefined
              ? { forkSession }
              : resumeSessionId
                ? { resumeSessionId }
                : {}),
            clientInfo: THREADLINES_ACP_CLIENT_INFO,
            mcpServers,
            runtimeMode: input.runtimeMode,
            ...(descriptor.agentTurns || descriptor.turnMachine ? { liveOutsidePrompt: true } : {}),
            ...(descriptor.turnMachine ? { trackSilentToolCalls: true } : {}),
            // An open approval must hear of an update that changes only what it would authorize.
            reportRevisedToolCalls: true,
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          if (acp.process !== undefined) {
            yield* processes.track(input.threadId, acp.process);
          }

          /**
           * Shows a request from the agent in order with the output before it,
           * naming the turn running there, and resolves with that turn once
           * shown. While the reader waits on a prompt's answer to open a turn
           * the agent began, it shows at once under that turn instead: the
           * agent may hold the answer back until this request is answered.
           * A queued show can't end up behind a hand-off for an agent that
           * announces each turn before its requests and answers a prompt when
           * it finishes, as Grok (the one agent with turns of its own) does.
           */
          const showRequest = (show: (turnId: TurnId | undefined) => Effect.Effect<void>) =>
            Effect.gen(function* () {
              const shown = yield* Deferred.make<TurnId | undefined>();
              const showAs = (turnId: TurnId | undefined) =>
                show(turnId).pipe(Effect.andThen(Deferred.succeed(shown, turnId)), Effect.asVoid);
              const context = ctx;
              const ahead = context?.agentTurnAhead;
              if (context === undefined) {
                yield* showAs(undefined);
              } else if (ahead?.after !== undefined && context.openPrompt === ahead.after) {
                yield* showAs(ahead.turnId);
              } else {
                yield* acp.inOrder(
                  Effect.gen(function* () {
                    // On the turn machine a request is an event: with no
                    // turn running (a wake asks for a permission) it opens
                    // one of the agent's own, and no quiet limit runs while
                    // it waits on the user.
                    if (context.machine !== undefined) {
                      yield* applyTurnEvent(context, {
                        type: "requestOpened",
                        newTurnId: crypto.randomUUID(),
                      });
                    }
                    yield* showAs(context.activeTurnId);
                  }),
                );
              }
              return shown;
            });

          // A side runtime never reaches the user: its questions go unanswered
          // at once (no answers reads as declined), and nothing is shown.
          const requestUserInput = (request: {
            readonly method: string;
            readonly payload: unknown;
            readonly questions: Parameters<AcpExtensionContext["requestUserInput"]>[0]["questions"];
            readonly elicitation?: McpElicitation;
          }): Effect.Effect<ProviderUserInputAnswers> =>
            Effect.gen(function* () {
              if (lockdown !== undefined) {
                yield* logNative(input.threadId, `${request.method} (declined: side answer)`, {});
                return {};
              }
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              pendingUserInputs.set(requestId, {
                answers,
                ...(request.elicitation ? { elicitation: request.elicitation } : {}),
              });
              const shown = yield* showRequest((turnId) =>
                Effect.gen(function* () {
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: {
                      questions: request.questions,
                      ...(request.elicitation ? { elicitation: request.elicitation } : {}),
                    },
                    ...(extensionSource
                      ? {
                          raw: {
                            source: extensionSource,
                            method: request.method,
                            payload: request.payload,
                          },
                        }
                      : {}),
                  });
                }),
              );
              const resolved = yield* Deferred.await(answers).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    pendingUserInputs.delete(requestId);
                    return closeMachineRequest(ctx);
                  }),
                ),
              );
              const turnId = yield* Deferred.await(shown);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                requestId: runtimeRequestId,
                payload: { answers: resolved },
              });
              return resolved;
            });

          const extensionContext: AcpExtensionContext = {
            threadId: input.threadId,
            acp,
            sessionId: () => parseAcpResumeCursor(ctx?.session.resumeCursor)?.sessionId,
            activeTurnId: () => ctx?.activeTurnId,
            logNative: (method, payload) => logNative(input.threadId, method, payload),
            requestUserInput,
            // What the extension emits names the running turn, so it goes
            // through the reader, in order with the updates and the turns the
            // agent starts and ends around it.
            emitProposedPlan: (request) =>
              acp.inOrder(
                Effect.gen(function* () {
                  yield* offerRuntimeEvent({
                    type: "turn.proposed.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    payload: { planMarkdown: request.planMarkdown },
                    ...(extensionSource
                      ? {
                          raw: {
                            source: extensionSource,
                            method: request.method,
                            payload: request.payload,
                          },
                        }
                      : {}),
                  });
                }),
              ),
            emitPlanUpdate: (request) =>
              ctx && extensionSource
                ? acp.inOrder(
                    emitPlanUpdate(
                      ctx,
                      request.plan,
                      request.payload,
                      extensionSource,
                      request.method,
                    ),
                  )
                : Effect.void,
            emitRuntimeEvent: (request) =>
              acp.inOrder(
                Effect.gen(function* () {
                  const turnId = request.event.turnId ?? ctx?.activeTurnId;
                  const event = {
                    ...request.event,
                    ...(turnId ? { turnId } : {}),
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    ...(extensionSource
                      ? {
                          raw: {
                            source: extensionSource,
                            method: request.method,
                            payload: request.payload,
                          },
                        }
                      : {}),
                  } as ProviderRuntimeEvent;
                  yield* offerRuntimeEvent(event);
                }),
              ),
            // Both run on the reader, where the notice falls: the turn's id is
            // chosen here, so a request read after the start names it at once.
            beginAgentTurn: (request) => {
              if (!ctx) return Effect.void;
              const turnId = TurnId.make(crypto.randomUUID());
              const after = ctx.openPrompt;
              ctx.agentTurnAhead = { turnId, after };
              ctx.queuedAgentTurns.push(turnId);
              return acp.markAgentTurnBoundary.pipe(
                Effect.andThen(acp.inOrder(beginAgentTurnInOrder(ctx, request, after, turnId))),
              );
            },
            endAgentTurn: (request) => {
              const context = ctx;
              if (!context) return Effect.void;
              context.agentTurnAhead = undefined;
              context.queuedAgentTurns.push("end");
              return acp.markAgentTurnBoundary.pipe(
                Effect.andThen(
                  acp.inOrder(
                    Effect.suspend(() => {
                      context.queuedAgentTurns.shift();
                      return closeAgentTurn(context, request.outcome, "in-order");
                    }),
                  ),
                ),
              );
            },
            reportPromptOutcome: (outcome) =>
              Effect.sync(() => {
                if (ctx && ctx.activeTurnId !== undefined && ctx.agentTurn === undefined) {
                  ctx.promptOutcome = outcome;
                }
              }),
          };

          const ElicitationCreatePayload = Schema.Struct({
            sessionId: Schema.optionalKey(Schema.String),
            mode: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
            message: Schema.String,
            requestedSchema: Schema.optionalKey(
              Schema.Union([
                Schema.Struct({
                  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                  title: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                  properties: Schema.optionalKey(
                    Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
                  ),
                  required: Schema.optionalKey(
                    Schema.Union([Schema.Array(Schema.String), Schema.Null]),
                  ),
                }),
                Schema.Null,
              ]),
            ),
          });

          const handleFormElicitation = (
            method: string,
            params: {
              readonly sessionId?: string;
              readonly mode?: string | null;
              readonly message: string;
              readonly requestedSchema?: {
                readonly type?: string | null;
                readonly title?: string | null;
                readonly description?: string | null;
                readonly properties?: Readonly<Record<string, unknown>> | null;
                readonly required?: ReadonlyArray<string> | null;
              } | null;
            },
          ): Effect.Effect<
            | {
                readonly action: "accept";
                readonly content: Readonly<
                  Record<string, string | number | boolean | ReadonlyArray<string>>
                >;
              }
            | { readonly action: "decline" | "cancel" }
          > =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, method, params);
              if (
                side !== undefined ||
                (params.mode !== undefined && params.mode !== null && params.mode !== "form")
              ) {
                return { action: "decline" as const };
              }
              const classified = descriptor.classifyElicitationForm?.(params);
              if (classified) {
                const answers = yield* requestUserInput({
                  method,
                  payload: params,
                  questions: classified.questions,
                });
                return classified.responseForAnswers(answers);
              }
              const elicitation = mcpElicitationPrompt({
                serverName: descriptor.presentation.displayName,
                message: params.message,
                mode: "form",
                requestedSchema: params.requestedSchema,
              });
              if (!elicitation) {
                return { action: "decline" as const };
              }
              const answers = yield* requestUserInput({
                method,
                payload: params,
                questions: [],
                elicitation,
              });
              const response = yield* Effect.try(() =>
                mcpElicitationResponse(elicitation, answers),
              ).pipe(Effect.orElseSucceed(() => ({ action: "cancel" as const, content: null })));
              if (response.action !== "accept") {
                return { action: response.action };
              }
              const content =
                typeof response.content === "object" &&
                response.content !== null &&
                !Array.isArray(response.content)
                  ? (response.content as Readonly<
                      Record<string, string | number | boolean | ReadonlyArray<string>>
                    >)
                  : {};
              return { action: "accept" as const, content };
            });

          const started = yield* Effect.gen(function* () {
            yield* acp.handleExtRequest("elicitation/create", ElicitationCreatePayload, (params) =>
              handleFormElicitation("elicitation/create", params),
            );
            yield* acp.handleElicitation((params) =>
              params.mode === "form"
                ? handleFormElicitation("session/elicitation", params).pipe(
                    Effect.map((action) => ({ action })),
                  )
                : Effect.succeed({ action: { action: "decline" as const } }),
            );
            if (descriptor.extensions) {
              yield* descriptor.extensions.register(extensionContext);
            }
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                // A side runtime never shows a request. It is answered once,
                // as its descriptor says (AcpSideRuntime.approvals): declined,
                // or allowed where the agent's own sandbox keeps it read-only.
                // Never "always", and never `cancelled`, which ends the turn.
                if (side !== undefined) {
                  const kind = side.approvals === "approve-once" ? "allow_once" : "reject_once";
                  const once = params.options.find(
                    (option) => option.kind === kind && option.optionId.trim() !== "",
                  );
                  return once === undefined
                    ? { outcome: { outcome: "cancelled" as const } }
                    : { outcome: { outcome: "selected" as const, optionId: once.optionId } };
                }
                const selected = (optionId: string | undefined) =>
                  optionId === undefined
                    ? { outcome: { outcome: "cancelled" as const } }
                    : { outcome: { outcome: "selected" as const, optionId } };
                // A question in permission clothing goes to the user, whatever
                // the runtime mode: auto-approving would answer for them.
                const question = descriptor.classifyPermissionRequest?.(params);
                if (question) {
                  const answers = yield* requestUserInput({
                    method: "session/request_permission",
                    payload: params,
                    questions: question.questions,
                  });
                  return selected(question.optionIdForAnswers(answers));
                }
                // A request may restate only part of the call: it is read on
                // top of what the session's updates already said about it.
                const known = yield* acp.getToolCall(params.toolCall.toolCallId);
                const permissionRequest = normalizedPermissionRequest(
                  parsePermissionRequest(params, known),
                  params.toolCall,
                );
                const ownSession =
                  ctx !== undefined && String(params.sessionId) === ctx.acpSessionId;
                const planFileWrite =
                  permissionRequest.toolCall !== undefined &&
                  descriptor.planMode?.isPlanFile(
                    permissionRequest.toolCall,
                    // Only this session's own plan: a request from another
                    // session (a subagent's) never writes it unasked.
                    ownSession ? ctx.acpSessionId : undefined,
                  ) === true;
                if (planFileWrite && permissionRequest.toolCall) {
                  const planMarkdown = descriptor.planMode?.planMarkdown(
                    permissionRequest.toolCall,
                  );
                  if (planMarkdown !== undefined && ctx) ctx.planMarkdown = planMarkdown;
                }
                // Threadlines' own room, page, command, and device tools follow
                // the same pre-approval rule as Claude and Codex (never
                // browser or third-party MCP servers, and only when normalized
                // positively as `mcp_tool_call` with no command/edit evidence).
                const preapprovedThreadlinesMcpCall =
                  ownSession &&
                  permissionRequest.toolCall !== undefined &&
                  permissionRequest.toolCall.itemType === "mcp_tool_call" &&
                  typeof permissionRequest.toolCall.data.server === "string" &&
                  ctx.preapprovedMcpServers.has(permissionRequest.toolCall.data.server);
                // Options whose "always" outlives the session are never ours to pick.
                const offered = descriptor.isLastingPermissionOption
                  ? params.options.filter(
                      (option) => !descriptor.isLastingPermissionOption!(option),
                    )
                  : params.options;
                // Full access answers each request once: an "always" option
                // would leave a standing rule behind in the agent's own store.
                // A request with no "once" to give goes to the user instead.
                if (
                  input.runtimeMode === "full-access" ||
                  planFileWrite ||
                  preapprovedThreadlinesMcpCall
                ) {
                  const once = acpPermissionOptionId("accept", offered);
                  if (once !== undefined) return selected(once);
                }
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                // The card the user can answer now: asked again under a new
                // id when what it is for changes, so the old one can't be.
                const card = {
                  requestId: ApprovalRequestId.make(crypto.randomUUID()),
                  permissionRequest,
                };
                pendingApprovals.set(card.requestId, { decision, kind: permissionRequest.kind });
                const warningFor = (kind: EffectAcpSchema.PermissionOption["kind"]) => {
                  const option = offered.find((candidate) => candidate.kind === kind);
                  return option ? descriptor.permissionOptionWarning?.(option) : undefined;
                };
                const acceptForSessionWarning = warningFor("allow_always");
                const acceptWarning = warningFor("allow_once");
                const decisionWarnings =
                  acceptForSessionWarning || acceptWarning
                    ? {
                        ...(acceptWarning ? { accept: acceptWarning } : {}),
                        ...(acceptForSessionWarning
                          ? { acceptForSession: acceptForSessionWarning }
                          : {}),
                      }
                    : undefined;
                const availableDecisions = acpAvailableDecisions(offered);
                const openCard = (turnId: TurnId | undefined) =>
                  Effect.gen(function* () {
                    yield* offerRuntimeEvent(
                      makeAcpRequestOpenedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: RuntimeRequestId.make(card.requestId),
                        permissionRequest: card.permissionRequest,
                        detail:
                          card.permissionRequest.detail ??
                          encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                          "[unserializable params]",
                        args: params,
                        ...(availableDecisions ? { availableDecisions } : {}),
                        ...(decisionWarnings ? { decisionWarnings } : {}),
                        source: "acp.jsonrpc",
                        method: "session/request_permission",
                        rawPayload: params,
                      }),
                    );
                  });
                const shown = yield* showRequest(openCard);
                const toolCallId = params.toolCall.toolCallId;
                const openApproval = {
                  reask: (latest: AcpToolCallState) =>
                    Effect.gen(function* () {
                      const next = reaskedPermissionRequest(params, card.permissionRequest, latest);
                      if (next === undefined) return;
                      if (!(yield* Deferred.isDone(shown))) {
                        // Not on screen yet: it shows as it now is.
                        card.permissionRequest = next;
                        return;
                      }
                      const turnId = yield* Deferred.await(shown);
                      const withdrawn = card.requestId;
                      pendingApprovals.delete(withdrawn);
                      yield* offerRuntimeEvent(
                        makeAcpRequestResolvedEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          requestId: RuntimeRequestId.make(withdrawn),
                          permissionRequest: card.permissionRequest,
                        }),
                      );
                      card.requestId = ApprovalRequestId.make(crypto.randomUUID());
                      card.permissionRequest = next;
                      pendingApprovals.set(card.requestId, { decision, kind: next.kind });
                      yield* openCard(turnId);
                    }),
                };
                openApprovals.set(toolCallId, openApproval);
                // Gone however the wait ends (an interrupted handler included),
                // or the quiet watch would hold the agent's turn open forever.
                const resolved = yield* Deferred.await(decision).pipe(
                  Effect.ensuring(
                    Effect.suspend(() => {
                      pendingApprovals.delete(card.requestId);
                      if (openApprovals.get(toolCallId) === openApproval) {
                        openApprovals.delete(toolCallId);
                      }
                      return closeMachineRequest(ctx);
                    }),
                  ),
                );
                const turnId = yield* Deferred.await(shown);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: RuntimeRequestId.make(card.requestId),
                    permissionRequest: card.permissionRequest,
                    decision: resolved,
                  }),
                );
                return resolved === "cancel"
                  ? { outcome: { outcome: "cancelled" as const } }
                  : selected(acpPermissionOptionId(resolved, offered));
              }),
            );
            const startedSession = yield* acp.start();
            // Up, but not trusted yet: the descriptor checks the agent really
            // came up locked down before anything is sent to it.
            if (side !== undefined) yield* side.verifyStarted;
            return startedSession;
          }).pipe(
            Effect.tapError(notifyAuthRequired),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            lockedDown: lockdown !== undefined,
            modelSelection: boundModelSelection,
          });

          const resumeFailure =
            started.resumeFailure ??
            (lostSession !== undefined
              ? `${descriptor.presentation.displayName} can no longer continue its earlier conversation.`
              : undefined);
          // A resumed conversation keeps the turn history its cursor carried.
          const keepsHistory =
            resumed !== undefined &&
            started.sessionId === resumed.sessionId &&
            resumeFailure === undefined;
          const history = keepsHistory ? resumed.history.map((entry) => ({ ...entry })) : [];
          const resumedNewestPosition = keepsHistory ? resumed.newestPosition : forkNewest;
          const attachedMcpServers = new Set(started.attachedMcpServerNames);
          const roomEndpointAttached =
            credential !== undefined && attachedMcpServers.has(ROOM_MCP_SERVER_NAME);
          const preapprovedMcpServers = new Set(
            credential === undefined
              ? []
              : started.attachedMcpServerNames.filter((name) =>
                  PREAPPROVED_THREADLINES_MCP_SERVERS.has(name),
                ),
          );
          // The brief is sent again whenever it changed. Only the thread's
          // own resumed conversation is known to hold one; a side answer
          // never gets it. Without the room/app MCP server, leave out the
          // `project_note_write` instruction so the agent isn't told to call
          // a tool it does not have.
          const projectBriefHash = keepsHistory ? resumed.projectBriefHash : undefined;
          const effectiveProjectInstructions = roomEndpointAttached
            ? input.projectInstructions
            : withoutProjectNoteWriteInstruction(input.projectInstructions);
          const projectBrief =
            lockdown === undefined
              ? projectBriefPreface({
                  projectInstructions: effectiveProjectInstructions,
                  sentHash: projectBriefHash,
                })
              : { text: undefined, hash: projectBriefHash };
          const now = yield* nowIso;
          // Reflects whether `ROOM_MCP_SERVER_NAME` was actually passed in
          // `session/new` / `session/resume` (over HTTP or via stdio fallback).
          const roomToolsAttached = roomEndpointAttached;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: boundModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: makeAcpResumeCursor(
              started.sessionId,
              history,
              resumedNewestPosition,
              projectBriefHash,
            ),
            ...(roomToolsRequested ? { roomTools: roomToolsAttached } : {}),
            ...(resumeFailure !== undefined ? { resumeFailed: true } : {}),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            lockdown,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            promptFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            history,
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            activeTurnText: "",
            activeTurnReplyTail: "",
            recentMessages: (input.contextSeed?.entries ?? [])
              .flatMap((entry): ReadonlyArray<PromptSuggestionMessage> => {
                if (
                  entry.kind !== "message" ||
                  (entry.role !== "user" && entry.role !== "assistant")
                ) {
                  return [];
                }
                const text = entry.text.trim();
                if (text.length === 0) return [];
                return [
                  {
                    role: entry.role,
                    text:
                      text.length <= PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE
                        ? text
                        : text.slice(text.length - PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE),
                  },
                ];
              })
              .slice(-PROMPT_SUGGESTION_MAX_MESSAGES),
            suggestionFiber: undefined,
            suggestionGeneration: 0,
            lastProviderStatus: undefined,
            lastContextUsageKey: undefined,
            acpSessionId: started.sessionId,
            preapprovedMcpServers,
            promptCapabilities: started.initializeResult.agentCapabilities?.promptCapabilities,
            subagentRoster:
              descriptor.subagents === undefined
                ? undefined
                : makeAcpSubagentRoster({
                    subagents: descriptor.subagents,
                    sessionId: started.sessionId,
                    emit: (event, turnId) =>
                      Effect.gen(function* () {
                        yield* offerRuntimeEvent({
                          ...event,
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: input.threadId,
                          ...(turnId ? { turnId } : {}),
                        } as ProviderRuntimeEvent);
                      }),
                    fork: (effect) => effect.pipe(Effect.forkIn(sessionScope), Effect.asVoid),
                  }),
            // A session reopened from elsewhere has spent an unknown amount.
            costBaselineUsd:
              (resumeSessionId !== undefined || forkSession !== undefined) &&
              resumeFailure === undefined
                ? undefined
                : 0,
            latestCostUsd: undefined,
            costTurnOpen: false,
            costReportedThisTurn: false,
            activeReasoning: undefined,
            cwdRoots: realCwd === cwd ? [cwd] : [cwd, realCwd],
            planMarkdown: undefined,
            // A switch from another agent starts without the history: the
            // thread hands it over. (A failed resume is seeded by the reactor.)
            pendingContextPreamble:
              input.contextSeed !== undefined && resumeSessionId === undefined
                ? renderThreadContextSeed(input.contextSeed)
                : undefined,
            projectBrief,
            projectBriefHash,
            projectBriefCarrier: undefined,
            turnStartLock: yield* Semaphore.make(1),
            agentTurn: undefined,
            agentTurnLastActivityMs: 0,
            agentTurnAhead: undefined,
            queuedAgentTurns: [],
            toolCallTurns: new Map(),
            promptOutcome: undefined,
            openPrompt: undefined,
            newestPosition: resumedNewestPosition,
            machine:
              descriptor.turnMachine === undefined
                ? undefined
                : {
                    state: initialTurnMachineState(),
                    callers: new Map(),
                    prompts: new Map(),
                    watches: new Map(),
                    turns: new Map(),
                    timers: new Map(),
                    lastActivityMs: yield* Clock.currentTimeMillis,
                    outbox: yield* Queue.unbounded<number>(),
                  },
            stopped: false,
            closed: yield* Deferred.make<void>(),
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier": {
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    // Past a prompt's last update, what follows belongs to a
                    // later turn: it waits until the prompt's turn has closed.
                    if (event.holdUntil !== undefined) yield* Deferred.await(event.holdUntil);
                    return;
                  }
                  case "InOrder":
                    yield* event.run;
                    return;
                  case "PromptSent":
                    // Written to the agent (`promptInOrder`): what it carries is delivered.
                    yield* applyTurnEvent(ctx, { type: "promptDispatched", prompt: event.key });
                    return;
                  case "PromptAnswered": {
                    // In its place among the updates (`promptInOrder`).
                    const sent = ctx.machine?.prompts.get(event.key);
                    if (sent !== undefined) sent.exit = event.answer;
                    yield* answerMachinePrompt(ctx, event.key);
                    return;
                  }
                  case "SessionStatus":
                    if (event.message === ctx.lastProviderStatus) {
                      return;
                    }
                    ctx.lastProviderStatus = event.message;
                    // Narrate provider-side recovery (rate-limit retries) on
                    // the live turn so it doesn't read as a hang.
                    if (ctx.activeTurnId) {
                      yield* offerRuntimeEvent({
                        type: "turn.status.updated",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: { statusMessage: event.message },
                      });
                    }
                    return;
                  case "ContextUsage": {
                    // The update that closes each model call: a reply the
                    // agent started by itself ends with it.
                    yield* applyTurnEvent(ctx, { type: "replyEnded" });
                    // Drives the composer's context meter, same event Codex
                    // and Claude send. Not gated on a prompt: the fill after a
                    // resumed session's replay is still the right reading.
                    const usageKey = `${event.usedTokens}/${event.maxTokens ?? ""}`;
                    if (usageKey === ctx.lastContextUsageKey) {
                      return;
                    }
                    ctx.lastContextUsageKey = usageKey;
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                      payload: {
                        usage: {
                          usedTokens: event.usedTokens,
                          ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
                        },
                      },
                    });
                    return;
                  }
                  case "AvailableCommandsUpdated": {
                    // The composer's `/` list for this session; a side
                    // runtime answers no messages of its own, so it lists none.
                    if (descriptor.agentCommands === undefined || ctx.lockdown !== undefined) {
                      return;
                    }
                    yield* noteSessionCommands(ctx, event.commands);
                    return;
                  }
                  case "SessionCost":
                    ctx.latestCostUsd = event.totalUsd;
                    // A report between turns marks the boundary exactly.
                    if (ctx.costTurnOpen) ctx.costReportedThisTurn = true;
                    else ctx.costBaselineUsd = event.totalUsd;
                    return;
                  case "ModeChanged":
                    return;
                  case "ToolCallRevised": {
                    // Changed only in what it would do: an approval open for it is asked again.
                    const openApproval = openApprovals.get(event.toolCall.toolCallId);
                    if (openApproval !== undefined) yield* openApproval.reask(event.toolCall);
                    return;
                  }
                  case "ToolCallTracked":
                    // Work whose updates show nothing new still counts (a
                    // timer's "Running schedule" stays as it started).
                    if (ctx.machine !== undefined) {
                      yield* noteActivity(ctx.machine);
                      yield* trackMachineWork(ctx, event.toolCall);
                    }
                    // A launch approved earlier completes with nothing new to show.
                    if (ctx.subagentRoster !== undefined) {
                      yield* ctx.subagentRoster.noteToolCall(
                        event.toolCall,
                        ctx.toolCallTurns.get(event.toolCall.toolCallId) ?? ctx.activeTurnId,
                      );
                    }
                    return;
                  case "CancellationNotice": {
                    // The notice a cancel owed is dropped; any other is output.
                    const commands =
                      ctx.machine === undefined
                        ? []
                        : yield* applyTurnEvent(ctx, {
                            type: "cancellationNotice",
                            newTurnId: crypto.randomUUID(),
                          });
                    if (commands.some((command) => command.type === "dropNotice")) return;
                    if (ctx.machine === undefined) yield* turnForOutput(ctx);
                    yield* closeReasoning(ctx);
                    const segment = yield* acp.openAssistantSegmentNow;
                    const turnId = ctx.activeTurnId;
                    if (segment.opened) {
                      yield* offerRuntimeEvent(
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId,
                          itemId: segment.itemId,
                          lifecycle: "item.started",
                        }),
                      );
                    }
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId: segment.itemId,
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ReasoningDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* turnForOutput(ctx);
                    yield* appendReasoning(ctx, event.text, event.rawPayload);
                    return;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted": {
                    yield* closeReasoning(ctx);
                    const turnId =
                      event._tag === "AssistantItemStarted"
                        ? yield* turnForOutput(ctx)
                        : ctx.activeTurnId;
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated":
                    yield* turnForOutput(ctx);
                    yield* closeReasoning(ctx);
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated": {
                    yield* closeReasoning(ctx);
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    // The plan card stands for the agent's plan-file writes.
                    if (descriptor.planMode?.isPlanFile(event.toolCall, ctx.acpSessionId)) {
                      const planMarkdown = descriptor.planMode.planMarkdown(event.toolCall);
                      if (planMarkdown !== undefined) ctx.planMarkdown = planMarkdown;
                      return;
                    }
                    const changes = descriptor.diffEvidence
                      ? acpDiffFileChanges(event.toolCall, ctx.cwdRoots, path)
                      : [];
                    const toolCallId = event.toolCall.toolCallId;
                    const turnId = yield* turnForOutput(ctx, toolCallId);
                    if (ctx.machine !== undefined) yield* trackMachineWork(ctx, event.toolCall);
                    if (ctx.subagentRoster !== undefined) {
                      yield* ctx.subagentRoster.noteToolCall(event.toolCall, turnId);
                    }
                    // An approval still open for this call is asked again if
                    // what it is for has changed.
                    const openApproval = openApprovals.get(toolCallId);
                    if (openApproval !== undefined) yield* openApproval.reask(event.toolCall);
                    if (
                      event.toolCall.status === "completed" ||
                      event.toolCall.status === "failed"
                    ) {
                      ctx.toolCallTurns.delete(toolCallId);
                    } else if (turnId !== undefined) {
                      ctx.toolCallTurns.set(toolCallId, turnId);
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        toolCall:
                          changes.length > 0
                            ? { ...event.toolCall, data: { ...event.toolCall.data, changes } }
                            : event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ContentDelta":
                    yield* turnForOutput(ctx);
                    yield* closeReasoning(ctx);
                    if (ctx.activeTurnText.length < PLAN_GATE_SCAN_MAX_CHARS) {
                      ctx.activeTurnText += event.text;
                    }
                    ctx.activeTurnReplyTail = appendTailCapped(
                      ctx.activeTurnReplyTail,
                      event.text,
                      PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE,
                    );
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
            // Tied to the session, not to whichever fiber called startSession:
            // a child fork dies with its caller, which in the server is a
            // short-lived command fiber — and with it every later delta.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = notificationFiber;
          if (ctx.machine !== undefined) {
            ctx.machine.senderFiber = yield* runPromptSender(ctx, ctx.machine).pipe(
              Effect.forkIn(sessionScope),
            );
          }
          sessions.set(input.threadId, ctx);
          // A turn the machine holds open waits on no request the exit would
          // fail: the machine hears of the exit itself.
          if (ctx.machine !== undefined && acp.process !== undefined) {
            const session = ctx;
            yield* acp.process.exited.pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  session.stopped ? Effect.void : postTurnEvent(session, { type: "processExited" }),
                ),
              ),
              Effect.forkIn(sessionScope),
            );
          }
          sessionScopeTransferred = true;
          recordHistory(ctx);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              state: "ready",
              reason: `${descriptor.presentation.displayName} ACP session ready`,
            },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          if (resumeFailure !== undefined) {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                message: `${descriptor.presentation.displayName} could not reopen its earlier conversation, so it starts a new one with this thread's history.`,
                detail: resumeFailure,
                warningKind: "resume-failed",
              },
            });
          }
          if (descriptor.onSessionConfigOptions) {
            yield* descriptor
              .onSessionConfigOptions(effectiveSettings, yield* acp.getConfigOptions)
              .pipe(Effect.ignore);
          }

          return session;
        }).pipe(Effect.scoped),
      );

    /**
     * A message as ACP content: its text, then each attachment. By default an
     * image's bytes, or a note naming a file the agent reads from disk (see
     * buildFileAttachmentNote); an agent that reads more natively says how
     * (`attachmentDelivery`, see AcpPromptAttachments).
     */
    const promptContent = (
      ctx: AcpSessionContext,
      text: string | undefined,
      attachments: Parameters<AcpAdapterShape["sendTurn"]>[0]["attachments"],
      method: string,
    ) =>
      Effect.gen(function* () {
        const parts: Array<EffectAcpSchema.ContentBlock> = [];
        if (text !== undefined) parts.push({ type: "text", text });
        const budget: AcpAttachmentBudget = { inlineBytes: 0 };
        for (const attachment of attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const delivery = descriptor.attachmentDelivery?.(attachment, ctx.promptCapabilities);
          if (delivery !== undefined) {
            const blocks = yield* acpAttachmentContent({
              attachment,
              path: attachmentPath,
              delivery,
              budget,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            parts.push(...blocks);
            continue;
          }
          if (attachment.type === "file") {
            parts.push({ type: "text", text: buildFileAttachmentNote(attachment, attachmentPath) });
            continue;
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          parts.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return parts;
      });

    /**
     * A prompt's answer as its turn ends with it. Multi-provider harnesses
     * advertise their whole catalog and reject a plan-gated model as a
     * one-line "reply": that is the failure it is, so the chat can offer the
     * upgrade page. A refusal that produced no text would render as a
     * silently empty turn: it says so instead (`refused` is fx's dialect).
     */
    const answeredTurnPayload = (
      stopReason: EffectAcpSchema.StopReason | null | undefined,
      activeTurnText: string,
      providerStatus: string | undefined,
    ): AcpTurnCompletedPayload => {
      const turnText = activeTurnText.trim();
      if (stopReason !== "cancelled" && isProviderPlanGateReply(turnText)) {
        return { state: "failed", stopReason: "plan_gated", errorMessage: turnText };
      }
      if ((stopReason === "refusal" || stopReason === "refused") && turnText.length === 0) {
        return {
          state: "failed",
          stopReason: stopReason ?? null,
          ...withFailureCategory(reportedFailureCategory("refusal", providerStatus)),
          // A rate-limit retry that ran out also surfaces as a bare refusal;
          // the provider's own status tells them apart.
          errorMessage: providerStatus
            ? `${descriptor.presentation.displayName} returned no output. Provider status: ${providerStatus}`
            : `${descriptor.presentation.displayName} reported the model refused this request and returned no output.`,
        };
      }
      return {
        state: stopReason === "cancelled" ? "cancelled" : "completed",
        stopReason: stopReason ?? null,
      };
    };

    /** A prompt that failed, in the agent's own words where it gave them. */
    const promptFailurePayload = (
      ctx: AcpSessionContext,
      failure: unknown,
    ): AcpTurnCompletedPayload => {
      const reportedOutcome = ctx.promptOutcome?.state === "failed" ? ctx.promptOutcome : undefined;
      const reportedFailure = reportedOutcome?.errorMessage;
      const failureCategory =
        reportedFailureCategory(reportedOutcome?.failureCategory, ctx.lastProviderStatus) ??
        (isAuthRequiredFailure(failure) ? ("auth" as const) : undefined);
      const detail = reportedFailure
        ? reportedFailure
        : failure instanceof Error
          ? mapAcpToAdapterError(
              PROVIDER,
              ctx.threadId,
              "session/prompt",
              failure as EffectAcpErrors.AcpError,
            ).message
          : String(failure);
      return {
        state: "failed",
        stopReason: isProviderPlanGateMessage(detail) ? "plan_gated" : null,
        errorMessage: ctx.lastProviderStatus
          ? `${detail} Provider status: ${ctx.lastProviderStatus}`
          : detail,
        ...withFailureCategory(failureCategory),
      };
    };

    /** A prompt's reported tokens, read the agent's way (`turnUsageTotals`). */
    const usageTotalsOf = descriptor.turnUsageTotals ?? acpTurnUsageTotals;

    // ── The turn machine (`descriptor.turnMachine`) ─────────────────────
    //
    // An agent on the turn machine has one owner for its turn's state: the
    // pure reducer in AcpTurnMachine.ts, stepped on the session's event
    // reader in order with the agent's updates. Every other source (a send,
    // a steer, Stop, a prompt's answer, a timer, the process exiting) posts
    // an event there; the commands it returns run here, in order.

    const machineOptions = descriptor.turnMachine;

    /** How the machine's quiet timers last; the cancel deadline is `ACP_CANCEL_DEADLINE`. */
    const quietLimit = (timer: Exclude<AcpTurnTimer, "cancelDeadline" | "noticeExpiry">) =>
      timer === "settle"
        ? ACP_HELD_TURN_SETTLE
        : timer === "replyQuiet"
          ? (machineOptions?.replyQuietLimit ?? ACP_HELD_REPLY_QUIET_LIMIT)
          : (machineOptions?.silentLimit ?? ACP_AGENT_TURN_QUIET_LIMIT);

    /** Events that are the agent doing something: each restarts the quiet timers. */
    const isAgentActivity = (event: AcpMachineEvent) =>
      event.type !== "send" &&
      event.type !== "childrenAtWork" &&
      event.type !== "steer" &&
      event.type !== "stopRequested" &&
      event.type !== "timerFired" &&
      event.type !== "processExited" &&
      event.type !== "sessionStopping" &&
      event.type !== "outcomeRead" &&
      event.type !== "promptDispatched";

    /** The driver's seams, for tests (`AcpAdapterOptions.turnMachineSeams`). */
    const seam = (point: AcpTurnMachineSeam) =>
      options?.turnMachineSeams === undefined ? Effect.void : options.turnMachineSeams(point);

    /** The agent did something: quiet timers count from now. */
    const noteActivity = (machine: AcpMachineSession) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        machine.lastActivityMs = now;
      });

    /**
     * Steps the machine with one event, on the event reader, and runs its
     * commands. One step is one unit: nothing interrupts it between the
     * commit and its last command (a session stop is an event the reader
     * gets to after it).
     */
    const applyTurnEvent = (
      ctx: AcpSessionContext,
      event: AcpMachineEvent,
    ): Effect.Effect<ReadonlyArray<AcpMachineCommand>> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const machine = ctx.machine;
          if (machine === undefined) return [];
          if (isAgentActivity(event)) yield* noteActivity(machine);
          const step = stepTurnMachine(machine.state, event);
          machine.state = step.state;
          yield* seam({
            point: "stepCommitted",
            event: event.type,
            commands: step.commands.map((command) => command.type),
            promptsHeld: machine.prompts.size,
          });
          for (const command of step.commands) yield* runTurnCommand(ctx, machine, command);
          return step.commands;
        }),
      );

    /**
     * A prompt's answer, stepped: the step reads its usage and starts its
     * outcome check (which keeps what it needs), and nothing reads its
     * record after, so it goes. Its parts can be large (inline attachments).
     * A late answer to a prompt a steer replaced goes the same way.
     */
    const answerMachinePrompt = (ctx: AcpSessionContext, prompt: number) =>
      applyTurnEvent(ctx, { type: "promptAnswered", prompt }).pipe(
        Effect.ensuring(Effect.sync(() => void ctx.machine?.prompts.delete(prompt))),
        Effect.asVoid,
      );

    /** A request the agent made was answered (or given up on): quiet limits may run again. */
    const closeMachineRequest = (ctx: AcpSessionContext | undefined) =>
      ctx?.machine === undefined ? Effect.void : postTurnEvent(ctx, { type: "requestClosed" });

    /** Posts an event to the machine from outside the reader, in order with the updates. */
    const postTurnEvent = (ctx: AcpSessionContext, event: AcpMachineEvent) =>
      ctx.acp.inOrder(applyTurnEvent(ctx, event).pipe(Effect.asVoid));

    /** The machine's events for a tool call that goes on after its prompt. */
    const trackMachineWork = (ctx: AcpSessionContext, toolCall: AcpToolCallState) =>
      Effect.gen(function* () {
        const work = machineOptions?.workAfterPrompt(toolCall);
        const id = toolCall.toolCallId;
        // Taken for work before, and now shown to be something else (an MCP
        // call the agent ran through a command): it holds nothing.
        if (work === undefined) {
          const machine = ctx.machine;
          if (machine?.state.running.some(([running]) => running === id) === true) {
            yield* applyTurnEvent(ctx, { type: "workDropped", id });
          }
          return;
        }
        const ended = toolCall.status === "completed" || toolCall.status === "failed";
        if (work.kind === "subagents") {
          if (toolCall.status === "completed") {
            yield* applyTurnEvent(ctx, { type: "subagentsLaunched", id, count: work.count });
          }
          return;
        }
        yield* applyTurnEvent(
          ctx,
          ended ? { type: "workEnded", id } : { type: "workStarted", id, kind: work.kind },
        );
      });

    /**
     * Arms one of the machine's timers. A quiet timer fires once its limit
     * has passed since the later of its arming and the agent's last
     * activity: activity while it waits moves the end, not the whole wait.
     */
    const armTurnTimer = (
      ctx: AcpSessionContext,
      machine: AcpMachineSession,
      timer: AcpTurnTimer,
      generation: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const armedAt = yield* Clock.currentTimeMillis;
        const quiet =
          timer !== "cancelDeadline" && timer !== "noticeExpiry" && timer !== "stopCheck";
        const limit =
          timer === "cancelDeadline"
            ? ACP_CANCEL_DEADLINE
            : timer === "noticeExpiry"
              ? ACP_NOTICE_EXPIRY
              : timer === "stopCheck"
                ? ACP_STOP_CHECK_INTERVAL
                : quietLimit(timer);
        const limitMs = Duration.toMillis(limit);
        const wait = (ms: number): Effect.Effect<void> =>
          Effect.sleep(Duration.millis(ms)).pipe(
            Effect.andThen(
              ctx.acp.inOrder(
                Effect.gen(function* () {
                  const armed = machine.state.timers.find(([name]) => name === timer);
                  if (armed?.[1] !== generation) return;
                  const since = quiet ? Math.max(armedAt, machine.lastActivityMs) : armedAt;
                  const left = since + limitMs - (yield* Clock.currentTimeMillis);
                  if (left > 0) {
                    const fiber = yield* wait(left).pipe(Effect.forkIn(ctx.scope));
                    machine.timers.set(timer, fiber);
                    return;
                  }
                  yield* applyTurnEvent(ctx, { type: "timerFired", timer, generation });
                }),
              ),
            ),
          );
        machine.timers.set(timer, yield* wait(limitMs).pipe(Effect.forkIn(ctx.scope)));
      });

    /**
     * The session's one prompt sender: takes the machine's prompts in the
     * order it sent them, and sends each (its turn's mode and model setup
     * first) only after the one before it is on the wire, so a steer never
     * reaches the agent ahead of the prompt it steers. A prompt's answer
     * reaches the machine as the reader reads it (`PromptAnswered`); one that
     * never went out answers with why.
     */
    const runPromptSender = (ctx: AcpSessionContext, machine: AcpMachineSession) =>
      Effect.forever(
        Queue.take(machine.outbox).pipe(
          Effect.flatMap((prompt) => sendMachinePrompt(ctx, machine, prompt)),
        ),
      );

    /** Sends one prompt for the sender: returns once it is on the wire (or failed to go). */
    const sendMachinePrompt = (
      ctx: AcpSessionContext,
      machine: AcpMachineSession,
      prompt: number,
    ) =>
      Effect.gen(function* () {
        const sent = machine.prompts.get(prompt);
        if (sent === undefined || ctx.stopped) return;
        const turnData = machine.turns.get(sent.turnId);
        // If the turn's opening prompt failed before reaching the agent, a
        // steer queued behind it must never go out alone under the old mode.
        if (sent.index > 1 && turnData?.setupFailed !== undefined) {
          const setupFailure = turnData.setupFailed;
          yield* ctx.acp.inOrder(
            Effect.suspend(() => {
              sent.exit = Exit.failCause(setupFailure);
              return answerMachinePrompt(ctx, prompt);
            }).pipe(Effect.asVoid),
          );
          return;
        }
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            if (sent.configure !== undefined) yield* sent.configure;
            yield* seam({ point: "promptSetup", prompt });
            if (ctx.stopped) return;
            // Where the agent's records stand as this prompt goes out.
            sent.watch =
              machineOptions?.outcome === undefined
                ? undefined
                : yield* machineOptions.outcome.watch(ctx.acpSessionId, sent.model).pipe(
                    // A stalled file system must not hold every prompt behind this one.
                    Effect.timeoutOption(ACP_OUTCOME_WATCH_TIMEOUT),
                    Effect.map(Option.getOrUndefined),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("acp.prompt-outcome.watch-failed", {
                        provider: PROVIDER,
                        cause: Cause.pretty(cause),
                      }).pipe(Effect.as(undefined)),
                    ),
                  );
            if (ctx.stopped) return;
            const promptMeta = descriptor.promptMeta?.(sent.turnId);
            yield* ctx.acp.promptInOrder(
              prompt,
              {
                prompt: [...sent.parts],
                ...(promptMeta ? { _meta: { ...promptMeta } } : {}),
              },
              seam({ point: "answerRead", prompt }),
            );
          }),
        );
        // A stopping session ends the turn itself.
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
        if (sent.index === 1 && turnData !== undefined) {
          turnData.setupFailed = exit.cause;
        }
        yield* ctx.acp.inOrder(
          Effect.suspend(() => {
            sent.exit = Exit.failCause(exit.cause);
            return answerMachinePrompt(ctx, prompt);
          }).pipe(Effect.asVoid),
        );
      });

    /**
     * How a machine prompt's answer reads: the payload its turn ends with,
     * after the agent's own records had their say (`outcome`). `seen` is what
     * the reader had when the answer arrived.
     */
    const readMachineOutcome = (
      ctx: AcpSessionContext,
      sent: AcpMachinePromptSent,
      seen: {
        readonly turnText: string;
        readonly providerStatus: string | undefined;
      },
    ): Effect.Effect<AcpPromptOutcomeRead<AcpTurnCompletedPayload>> =>
      Effect.gen(function* () {
        const exit = sent.exit;
        const check = (answer: Parameters<AcpPromptOutcomeWatch["check"]>[0]) =>
          sent.watch === undefined
            ? Effect.succeed(undefined)
            : sent.watch.check(answer).pipe(
                // A check that hangs (a network read) must not hold the turn.
                Effect.timeoutOption(ACP_OUTCOME_CHECK_TIMEOUT),
                Effect.map(Option.getOrUndefined),
                Effect.catchCause((cause) =>
                  Effect.logWarning("acp.prompt-outcome.check-failed", {
                    provider: PROVIDER,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(undefined)),
                ),
              );
        if (exit !== undefined && Exit.isSuccess(exit)) {
          const result = exit.value;
          ctx.turns.push({ id: sent.turnId, items: [{ prompt: sent.parts, result }] });
          ctx.session = {
            ...ctx.session,
            updatedAt: yield* nowIso,
            ...(sent.resolvedModel !== undefined ? { model: sent.resolvedModel } : {}),
          };
          const hidden =
            result.stopReason === "cancelled" ? undefined : yield* check({ response: result });
          const payload = hidden
            ? failedTurnPayload(hidden, result.stopReason ?? null)
            : answeredTurnPayload(result.stopReason, seen.turnText, seen.providerStatus);
          return {
            state: turnPayloadState(payload),
            answer: payload,
            sessionLost: hidden?.sessionLost === true,
          };
        }
        // The agent may never have taken the prompt: the brief goes again.
        if (ctx.projectBriefCarrier?.turnId === sent.turnId) requeueProjectBrief(ctx);
        const failure = exit === undefined ? undefined : Cause.squash(exit.cause);
        yield* notifyAuthRequired(failure);
        const reported = yield* check({ error: failure });
        const payload = reported
          ? failedTurnPayload(reported, null)
          : promptFailurePayload(ctx, failure);
        return { state: "failed", answer: payload, sessionLost: reported?.sessionLost === true };
      });

    /** Carries out one of the machine's commands. Runs on the event reader: nothing here waits long. */
    const runTurnCommand = (
      ctx: AcpSessionContext,
      machine: AcpMachineSession,
      command: AcpMachineCommand,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (command.type) {
          case "startTurn": {
            const turnId = TurnId.make(command.turnId);
            const caller =
              command.sendId === undefined ? undefined : machine.callers.get(command.sendId);
            yield* dropSuggestion(ctx);
            ctx.activeTurnId = turnId;
            resetTurnState(ctx);
            if (caller?.userMessageText) {
              pushRecentMessage(ctx, "user", caller.userMessageText);
            }
            ctx.history.push(
              caller?.messageId !== undefined
                ? { turnId, messageId: caller.messageId }
                : caller !== undefined
                  ? { turnId }
                  : { turnId, agentTurn: true },
            );
            recordHistory(ctx);
            ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
            machine.turns.set(command.turnId, {
              model: caller?.prompt.model ?? ctx.session.model,
              resolvedModel: caller?.prompt.resolvedModel ?? resolveModelId(ctx.session.model),
              planMode: caller?.planMode,
              suggestNextMessage: caller?.suggestNextMessage === true,
              suggestionGeneration: ctx.suggestionGeneration,
            });
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: caller !== undefined ? { model: caller.prompt.resolvedModel } : {},
              ...(caller === undefined
                ? { raw: { source: "acp.jsonrpc" as const, method: "session/update", payload: {} } }
                : {}),
            });
            return;
          }
          case "sendPrompt": {
            const callerId =
              "sendId" in command.source ? command.source.sendId : command.source.steerId;
            const caller = machine.callers.get(callerId);
            const turn = machine.turns.get(command.turnId);
            if (caller === undefined) return;
            const turnPrompts = machine.state.turn?.prompts ?? [];
            const sent: AcpMachinePromptSent = {
              ...caller.prompt,
              turnId: TurnId.make(command.turnId),
              // Its place in the turn: a steer's prompt has a usage line of its own.
              index: turnPrompts.indexOf(command.prompt) + 1,
              model: caller.prompt.model ?? turn?.model,
              resolvedModel: caller.prompt.resolvedModel ?? turn?.resolvedModel,
              watch: undefined,
              exit: undefined,
            };
            machine.prompts.set(command.prompt, sent);
            yield* Queue.offer(machine.outbox, command.prompt);
            return;
          }
          case "reportDelivery": {
            const sent = machine.prompts.get(command.prompt);
            if (sent === undefined) return;
            if (!command.delivered) {
              // Never written: the context it carried waits for the next message.
              if (sent.preamble !== undefined && ctx.pendingContextPreamble === undefined) {
                ctx.pendingContextPreamble = sent.preamble;
              }
              if (ctx.projectBriefCarrier?.turnId === sent.turnId) requeueProjectBrief(ctx);
            }
            if (sent.delivered !== undefined) {
              yield* Deferred.succeed(sent.delivered, command.delivered);
            }
            return;
          }
          case "acceptSend":
          case "acceptSteer":
          case "rejectSend":
          case "rejectSteer": {
            const callerId = "sendId" in command ? command.sendId : command.steerId;
            const caller = machine.callers.get(callerId);
            machine.callers.delete(callerId);
            if (caller === undefined) return;
            if (command.type === "acceptSteer" && caller.userMessageText) {
              pushRecentMessage(ctx, "user", caller.userMessageText);
            }
            yield* Deferred.succeed(
              caller.reply,
              command.type === "acceptSend" || command.type === "acceptSteer"
                ? { accepted: TurnId.make(command.turnId) }
                : { rejected: command.type === "rejectSteer" ? command.reason : "no-active-turn" },
            );
            return;
          }
          case "readOutcome": {
            const sent = machine.prompts.get(command.prompt);
            const seen = { turnText: ctx.activeTurnText, providerStatus: ctx.lastProviderStatus };
            if (sent !== undefined) {
              const retainedWatch = sent.watch;
              const retainedStopReason =
                sent.exit !== undefined && Exit.isSuccess(sent.exit)
                  ? sent.exit.value.stopReason
                  : undefined;
              yield* seam({ point: "outcomeRead", prompt: command.prompt }).pipe(
                Effect.andThen(readMachineOutcome(ctx, sent, seen)),
                Effect.flatMap((outcome) => {
                  if (retainedStopReason !== undefined && outcome.state === "completed") {
                    machine.watches.set(command.prompt, {
                      watch: retainedWatch,
                      stopReason: retainedStopReason,
                      fallback: outcome.answer,
                    });
                  }
                  return postTurnEvent(ctx, {
                    type: "outcomeRead",
                    prompt: command.prompt,
                    outcome,
                  });
                }),
                Effect.forkIn(ctx.scope),
              );
              return;
            }
            // Post-settle re-check: the prompt's payload is already freed, so
            // re-run its watch against the session log for any error written
            // during a wake-up reply.
            const retained = machine.watches.get(command.prompt);
            machine.watches.delete(command.prompt);
            yield* seam({ point: "outcomeRead", prompt: command.prompt }).pipe(
              Effect.andThen(
                retained?.watch === undefined
                  ? Effect.succeed<AcpPromptFailure | undefined>(undefined)
                  : retained.watch.check({ response: { stopReason: retained.stopReason } }).pipe(
                      Effect.timeoutOption(ACP_OUTCOME_CHECK_TIMEOUT),
                      Effect.map(Option.getOrUndefined),
                      Effect.catchCause((cause) =>
                        Effect.logWarning("acp.prompt-outcome.recheck-failed", {
                          provider: PROVIDER,
                          cause: Cause.pretty(cause),
                        }).pipe(Effect.as(undefined)),
                      ),
                    ),
              ),
              Effect.flatMap((hidden) => {
                const outcome: AcpPromptOutcomeRead<AcpTurnCompletedPayload> =
                  hidden !== undefined
                    ? {
                        state: "failed",
                        answer: failedTurnPayload(hidden, retained?.stopReason ?? null),
                        sessionLost: hidden.sessionLost === true,
                      }
                    : {
                        state: "completed",
                        answer: retained?.fallback ?? { state: "completed", stopReason: null },
                        sessionLost: false,
                      };
                return postTurnEvent(ctx, { type: "outcomeRead", prompt: command.prompt, outcome });
              }),
              Effect.forkIn(ctx.scope),
            );
            return;
          }
          case "readChildren": {
            // The agent's own records, off the reader and bounded. A launch
            // counts only for the child its own call id started, so records
            // from before a resume, or of another launch, prove nothing; one
            // the records don't tie to a single child is left out, and the
            // protocol count stands for it.
            const states = descriptor.subagents?.states;
            if (states === undefined) return;
            const { generation, launches } = command;
            yield* states({
              sessionId: ctx.acpSessionId,
              launchCallIds: launches.map(([id]) => id),
            }).pipe(
              Effect.timeoutOption(ACP_OUTCOME_CHECK_TIMEOUT),
              Effect.map(Option.getOrUndefined),
              Effect.tap(() => seam({ point: "childrenRead", generation })),
              Effect.flatMap((reading) => {
                if (reading === undefined) return Effect.void;
                const covered = launches.flatMap(([id, count]) => {
                  const child = reading.byLaunch.get(id);
                  return child === undefined || count !== 1
                    ? []
                    : [[id, child.state === "working" ? 1 : 0] as const];
                });
                return postTurnEvent(ctx, {
                  type: "childrenAtWork",
                  generation,
                  launches: covered,
                });
              }),
              Effect.forkIn(ctx.scope),
            );
            return;
          }
          case "recordUsage": {
            const sent = machine.prompts.get(command.prompt);
            if (sent === undefined) return;
            const exit = sent.exit;
            const totals =
              exit !== undefined && Exit.isSuccess(exit) ? usageTotalsOf(exit.value.usage) : null;
            yield* recordMachinePromptUsage(ctx, sent, totals);
            return;
          }
          case "sendCancel":
            yield* ctx.acp.cancel.pipe(Effect.ignore, Effect.forkIn(ctx.scope));
            return;
          case "endTurn":
            yield* endMachineTurn(ctx, machine, command.turnId, command.end);
            return;
          case "armTimer": {
            const previous = machine.timers.get(command.timer);
            if (previous !== undefined) yield* Fiber.interrupt(previous);
            yield* armTurnTimer(ctx, machine, command.timer, command.generation);
            return;
          }
          case "disarmTimer": {
            const fiber = machine.timers.get(command.timer);
            machine.timers.delete(command.timer);
            if (fiber !== undefined) yield* Fiber.interrupt(fiber);
            return;
          }
          case "recycleAgent":
            // Stopped first, so nothing the agent does lands after the turn's end.
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              ...(ctx.activeTurnId !== undefined ? { turnId: ctx.activeTurnId } : {}),
              payload: {
                message: `${descriptor.presentation.displayName} did not stop in time, so it was restarted. The next message picks the conversation up again.`,
                warningKind: "cancel-timeout",
              },
            });
            yield* stopFromMachine(ctx, "graceful");
            return;
          case "stopSession":
            // A lost conversation: ProviderService forgets it in the thread's
            // binding, if the binding still names this one.
            yield* stopFromMachine(
              ctx,
              command.reason === "exited" ? "error" : "graceful",
              command.reason === "sessionLost"
                ? { conversationLost: { sessionCreatedAt: ctx.session.createdAt } }
                : undefined,
            );
            return;
          case "markSessionLost":
            // Before the session ends: a start racing ProviderService's forget opens anew.
            lostSessions.add(ctx.acpSessionId);
            return;
          case "dropNotice":
            return;
        }
      });

    /** Stops the session from a machine command, off the reader (stopping interrupts it). */
    const stopFromMachine = (
      ctx: AcpSessionContext,
      exitKind: "graceful" | "error",
      exit?: { readonly conversationLost?: { readonly sessionCreatedAt: string } },
    ) =>
      withThreadLock(
        ctx.threadId,
        Effect.suspend(() =>
          sessions.get(ctx.threadId) === ctx
            ? stopSessionInternal(ctx, exitKind, exit)
            : Effect.void,
        ),
      ).pipe(Effect.forkIn(adapterScope), Effect.asVoid);

    /**
     * Writes one answered prompt's tokens, and the session's reported cost
     * since the last line, so neither waits for the turn's end (a hold, a stop
     * or a restart would lose it). A steered prompt has an id of its own.
     */
    const recordMachinePromptUsage = (
      ctx: AcpSessionContext,
      sent: AcpMachinePromptSent,
      totals: UsageTokenTotals | null,
    ) =>
      Effect.gen(function* () {
        const costUsd = takeReportedCost(ctx);
        const record = options?.recordTurnUsage;
        if (!record || (totals === null && costUsd === null)) return;
        yield* record({
          atMs: yield* Clock.currentTimeMillis,
          sessionId: ctx.acpSessionId,
          turnId: sent.index <= 1 ? sent.turnId : `${sent.turnId}:${sent.index}`,
          model: sent.resolvedModel ?? ctx.session.model ?? "default",
          totals: totals ?? EMPTY_USAGE_TOTALS,
          costUsd,
        }).pipe(Effect.forkIn(adapterScope));
      });

    /**
     * The session's running cost spent since the last line written, when it
     * is known exactly; the baseline moves to where it now stands.
     */
    const takeReportedCost = (ctx: AcpSessionContext): number | null => {
      if (!ctx.costReportedThisTurn) return null;
      const costUsd =
        ctx.costBaselineUsd !== undefined && ctx.latestCostUsd !== undefined
          ? Math.max(0, ctx.latestCostUsd - ctx.costBaselineUsd)
          : null;
      ctx.costBaselineUsd = ctx.latestCostUsd;
      ctx.costReportedThisTurn = false;
      return costUsd;
    };

    /** The turn's one terminal event, after its reply and thought close in place. */
    const endMachineTurn = (
      ctx: AcpSessionContext,
      machine: AcpMachineSession,
      turnId: string,
      end: AcpTurnEnd<AcpTurnCompletedPayload>,
    ) =>
      Effect.gen(function* () {
        const id = TurnId.make(turnId);
        const data = machine.turns.get(turnId);
        machine.turns.delete(turnId);
        machine.watches.clear();
        const closedItem = yield* ctx.acp.closeAssistantSegmentNow;
        if (closedItem !== undefined) {
          yield* offerRuntimeEvent(
            makeAcpAssistantItemEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: id,
              itemId: closedItem,
              lifecycle: "item.completed",
            }),
          );
        }
        yield* closeReasoning(ctx);
        const planMarkdown = data?.planMode ? ctx.planMarkdown?.trim() : undefined;
        if (planMarkdown && end.kind === "answered" && end.outcome.state === "completed") {
          yield* offerRuntimeEvent({
            type: "turn.proposed.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: id,
            payload: { planMarkdown },
          });
        }
        if (ctx.activeTurnId === id) {
          ctx.activeTurnId = undefined;
          ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
        }
        const stamp = yield* makeEventStamp();
        const completedPayload: AcpTurnCompletedPayload | undefined =
          end.kind === "aborted"
            ? undefined
            : end.kind === "answered"
              ? end.outcome.answer
              : end.kind === "agentDone"
                ? { state: "completed", stopReason: null }
                : end.kind === "stopped"
                  ? { state: "cancelled", stopReason: "cancelled" }
                  : {
                      state: "failed",
                      stopReason: null,
                      errorMessage: `${descriptor.presentation.displayName} stopped before its work finished.`,
                    };
        if (ctx.activeTurnReplyTail.trim().length > 0) {
          pushRecentMessage(ctx, "assistant", ctx.activeTurnReplyTail);
        }
        if (completedPayload === undefined) {
          yield* offerRuntimeEvent({
            type: "turn.aborted",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: id,
            payload: { reason: "The session stopped." },
          });
        } else {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: id,
            payload: completedPayload,
          });
          const promptSuggestions = options?.promptSuggestions;
          if (
            completedPayload.state === "completed" &&
            data?.suggestNextMessage === true &&
            ctx.suggestionGeneration === data.suggestionGeneration &&
            promptSuggestions !== undefined
          ) {
            yield* startSuggestion(ctx, promptSuggestions, {
              turnId: id,
              model: data.model,
              completedEventId: stamp.eventId,
            });
          }
        }
        // Cost reported after the turn's last prompt answered (its own replies).
        const costUsd = takeReportedCost(ctx);
        ctx.costTurnOpen = false;
        const record = options?.recordTurnUsage;
        if (record && costUsd !== null && costUsd > 0) {
          yield* record({
            atMs: yield* Clock.currentTimeMillis,
            sessionId: ctx.acpSessionId,
            turnId: `${turnId}:after`,
            model: data?.resolvedModel ?? ctx.session.model ?? "default",
            totals: EMPTY_USAGE_TOTALS,
            costUsd,
          }).pipe(Effect.forkIn(adapterScope));
        }
      });

    /** A message for a machine agent: prepared here, started by the machine when its turn comes. */
    const sendTurnByMachine = (
      ctx: AcpSessionContext,
      machine: AcpMachineSession,
      input: Parameters<AcpAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        yield* dropSuggestion(ctx);
        const turnId = TurnId.make(crypto.randomUUID());
        const prepared = yield* prepareTurnPrompt(ctx, input);
        carryPromptPreface(ctx, turnId, prepared);
        const reply = yield* Deferred.make<AcpMachineReply>();
        const delivered = yield* Deferred.make<boolean>();
        const sendId = `send:${turnId}`;
        /** A send that never went out leaves the context it took for the next. */
        const keepContext = () => {
          if (prepared.contextPreamble !== undefined && ctx.pendingContextPreamble === undefined) {
            ctx.pendingContextPreamble = prepared.contextPreamble;
          }
          if (ctx.projectBriefCarrier?.turnId === turnId) requeueProjectBrief(ctx);
        };
        const userMessageText = (input.typed?.text ?? input.input ?? "").trim();
        machine.callers.set(sendId, {
          prompt: {
            parts: prepared.promptParts,
            configure: prepared.configure,
            model: prepared.model,
            resolvedModel: prepared.resolvedModel,
            preamble: prepared.contextPreamble,
            delivered,
          },
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
          ...(userMessageText.length > 0 ? { userMessageText } : {}),
          suggestNextMessage: input.suggestNextMessage === true,
          planMode: prepared.planMode,
          reply,
        });
        if (ctx.stopped) {
          machine.callers.delete(sendId);
          keepContext();
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        yield* postTurnEvent(ctx, { type: "send", sendId, turnId });
        const answer = yield* Deferred.await(reply);
        if ("rejected" in answer) {
          keepContext();
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // Returns once the prompt was written, or its setup failed first:
        // only a written prompt delivered the message and the context in
        // front of it (`undelivered`). A stop settles this too.
        const written = yield* Deferred.await(delivered);
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
          // A typed agent command left the thread's history and brief owed.
          ...(prepared.contextDeferred ? { contextDeferred: true as const } : {}),
          ...(written ? {} : { undelivered: true as const }),
        };
      });

    /** A message sent mid-turn to a machine agent: another prompt of the running turn. */
    const steerTurnByMachine: NonNullable<AcpAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const machine = ctx.machine;
        if (machine === undefined) {
          return yield* steerRejectedError(
            PROVIDER,
            descriptor.presentation.displayName,
            "no-active-turn",
          );
        }
        const text = input.input?.trim() ?? "";
        const parts = yield* promptContent(
          ctx,
          text.length > 0 ? text : undefined,
          input.attachments,
          "turn/steer",
        );
        const reply = yield* Deferred.make<AcpMachineReply>();
        const delivered = yield* Deferred.make<boolean>();
        const steerId = `steer:${crypto.randomUUID()}`;
        machine.callers.set(steerId, {
          prompt: {
            parts,
            configure: undefined,
            model: undefined,
            resolvedModel: undefined,
            preamble: undefined,
            delivered,
          },
          ...(text.length > 0 ? { userMessageText: text } : {}),
          planMode: undefined,
          reply,
        });
        if (ctx.stopped) {
          machine.callers.delete(steerId);
          return yield* steerRejectedError(
            PROVIDER,
            descriptor.presentation.displayName,
            "no-active-turn",
          );
        }
        yield* postTurnEvent(ctx, {
          type: "steer",
          steerId,
          expectedTurnId: input.expectedTurnId,
        });
        const answer = yield* Deferred.await(reply);
        if ("rejected" in answer) {
          return yield* steerRejectedError(
            PROVIDER,
            descriptor.presentation.displayName,
            answer.rejected,
          );
        }
        // Returns once the prompt was written to the agent: if the process
        // exited or the session stopped first, the steer never reached it.
        // Bounded so a stalled stdin pipe cannot block Stop behind this call.
        const written = yield* Deferred.await(delivered).pipe(
          Effect.timeoutOption(ACP_STEER_DELIVERY_TIMEOUT),
        );
        if (Option.isNone(written)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/steer",
            detail: `${descriptor.presentation.displayName} did not accept this message in time.`,
          });
        }
        if (!written.value) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/steer",
            detail: `${descriptor.presentation.displayName} stopped before this message could be sent.`,
          });
        }
        return {
          threadId: input.threadId,
          turnId: answer.accepted,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    /**
     * A message's prompt as the agent gets it: the thread's history and the
     * project's brief in front when owed, plan mode's prefix, the attachments.
     */
    const prepareTurnPrompt = (
      ctx: AcpSessionContext,
      input: Parameters<AcpAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = resolveModelId(model);

        // The agent runs a command (or a skill) only when the message starts
        // with it. A message is one only when the person's own typed text,
        // trimmed (never the context in front of it, never plain text or an
        // agent's words), starts with `/` and a name the session advertised
        // or a skill the status lists. It then goes alone, as typed: no plan prefix, and
        // the context the server put in front of it, the earlier conversation
        // and the project brief wait for the next message (`contextDeferred`
        // tells the server its debts stay).
        const typed = input.typed;
        const typedCommand =
          descriptor.agentCommands !== undefined && typed !== undefined
            ? slashCommandAtStart(typed.text.trim())
            : undefined;
        const sendsAgentCommand =
          typedCommand !== undefined && (yield* isAgentCommand(ctx, typedCommand));
        const userText =
          sendsAgentCommand && typed ? typed.text.trim() : (input.input?.trim() ?? "");
        const contextDeferred =
          sendsAgentCommand &&
          (typed?.context !== undefined || ctx.pendingContextPreamble !== undefined);
        // Prompt-command plan mode (Antigravity's `/plan`) is a text prefix.
        const lockedDown = ctx.lockdown !== undefined;
        const planMode =
          input.interactionMode === "plan" && !lockedDown && !sendsAgentCommand
            ? descriptor.planMode
            : undefined;
        const contextPreamble = sendsAgentCommand ? undefined : ctx.pendingContextPreamble;
        const projectBrief: ProjectBriefPreface = sendsAgentCommand
          ? { text: undefined, hash: ctx.projectBrief.hash }
          : ctx.projectBrief;
        const contextText =
          contextPreamble !== undefined
            ? withContextSeedPreamble(contextPreamble, userText)
            : userText;
        // The project's brief leads, as a paragraph of its own.
        const seededText =
          projectBrief.text !== undefined
            ? contextText.length > 0
              ? `${projectBrief.text}\n\n${contextText}`
              : projectBrief.text
            : contextText;
        const promptParts = yield* promptContent(
          ctx,
          seededText.length > 0 || planMode
            ? planMode
              ? `${planMode.promptPrefix}${seededText}`
              : seededText
            : undefined,
          input.attachments,
          "session/prompt",
        );
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        // The mode and model the message asks for, set before its prompt goes out.
        const configure = Effect.gen(function* () {
          yield* applyRequestedSessionConfiguration({
            runtime: ctx.acp,
            threadId: input.threadId,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            lockedDown,
            modelSelection:
              model === undefined ? undefined : { model, options: turnModelSelection?.options },
          });
          const turnModeId = lockedDown
            ? undefined
            : descriptor.sessionModeForTurn?.(input.interactionMode);
          const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
          if (turnModeId !== undefined && sessionId !== undefined) {
            yield* ctx.acp
              .request("session/set_mode", { sessionId, modeId: turnModeId })
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
                ),
              );
          }
        });
        return {
          model,
          resolvedModel,
          planMode,
          contextPreamble,
          projectBrief,
          promptParts,
          configure,
          contextDeferred,
        };
      });

    /** The turn carries the history and brief its prompt led with: they are not owed again. */
    const carryPromptPreface = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      prepared: Effect.Success<ReturnType<typeof prepareTurnPrompt>>,
    ) => {
      if (prepared.contextPreamble !== undefined) ctx.pendingContextPreamble = undefined;
      const projectBrief = prepared.projectBrief;
      if (projectBrief.text !== undefined) {
        ctx.projectBriefCarrier = {
          turnId,
          preface: projectBrief,
          hashBefore: ctx.projectBriefHash,
        };
        ctx.projectBrief = { text: undefined, hash: projectBrief.hash };
        ctx.projectBriefHash = projectBrief.hash;
      }
    };

    // The turn id is returned as soon as `session/prompt` is dispatched —
    // orchestration marks the turn accepted from that result, so it must
    // land before the streamed items and the completion, exactly as the
    // native drivers behave. The prompt itself runs in the session scope.
    const sendTurn: AcpAdapterShape["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (ctx) =>
        ctx.machine !== undefined
          ? sendTurnByMachine(ctx, ctx.machine, input)
          : // One turn start at a time per session: two sends racing here would
            // both see no prompt in flight and run their prompts interleaved.
            ctx.turnStartLock.withPermit(startTurn(ctx, input)),
      );

    const startTurn = (ctx: AcpSessionContext, input: Parameters<AcpAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        yield* dropSuggestion(ctx);
        if (ctx.promptFiber) {
          // ACP serializes prompts per session; a turn sent while one is in
          // flight starts after it, never interleaved with it.
          yield* Fiber.await(ctx.promptFiber);
        }
        // The reader catches up first, so a turn the agent began before this
        // message is open (and ended below) rather than taking its output.
        yield* ctx.acp.flushEvents();
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // A message sent while the agent runs a turn of its own ends that
        // turn here; the agent takes the message after it, as Claude does.
        if (ctx.agentTurn !== undefined) {
          yield* closeAgentTurn(ctx, { state: "completed" });
        }
        const turnId = TurnId.make(crypto.randomUUID());
        const prepared = yield* prepareTurnPrompt(ctx, input);
        const { planMode, model, resolvedModel, promptParts } = prepared;
        yield* prepared.configure;
        yield* dropSuggestion(ctx);
        const turnSuggestionGeneration = ctx.suggestionGeneration;
        ctx.activeTurnId = turnId;
        const prompt = {
          turnId,
          drained: yield* Deferred.make<void>(),
          closed: yield* Deferred.make<void>(),
        };
        ctx.openPrompt = prompt;
        resetTurnState(ctx);
        const userMessageText = (input.typed?.text ?? input.input ?? "").trim();
        if (userMessageText.length > 0) {
          pushRecentMessage(ctx, "user", userMessageText);
        }
        carryPromptPreface(ctx, turnId, prepared);
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        ctx.history.push({
          turnId,
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        });
        recordHistory(ctx);
        const promptText = promptParts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        const newestBefore = ctx.newestPosition;

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const runPrompt = Effect.gen(function* () {
          const promptMeta = descriptor.promptMeta?.(turnId);
          const exit = yield* Effect.exit(
            ctx.acp.prompt({
              prompt: promptParts,
              ...(promptMeta ? { _meta: { ...promptMeta } } : {}),
            }),
          );
          // Deltas travel through the notification fiber; make sure every one
          // queued before the prompt returned is out before the turn closes.
          // The reader may be past them already, held at a turn the agent
          // began after them (`beginAgentTurnInOrder`).
          yield* Effect.raceFirst(
            ctx.acp.flushEvents(prompt.closed),
            Deferred.await(prompt.drained),
          );
          // A turn that ends mid-thought (or on one) still settles its row.
          yield* closeReasoning(ctx);
          // Where the prompt landed, known before the turn reads as ended,
          // so a revert or a stop right after it keeps it.
          if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) {
            yield* recordPromptPosition(ctx, turnId, promptText, newestBefore);
          }
          if (Exit.isSuccess(exit)) {
            const result = exit.value;
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
            const planMarkdown = planMode ? ctx.planMarkdown?.trim() : undefined;
            if (planMarkdown && result.stopReason !== "cancelled") {
              yield* offerRuntimeEvent({
                type: "turn.proposed.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { planMarkdown },
              });
            }
            ctx.session = {
              ...ctx.session,
              updatedAt: yield* nowIso,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
            };
            if (ctx.activeTurnReplyTail.trim().length > 0) {
              pushRecentMessage(ctx, "assistant", ctx.activeTurnReplyTail);
            }
            const completedStamp = yield* makeEventStamp();
            const completedPayload = answeredTurnPayload(
              result.stopReason,
              ctx.activeTurnText,
              ctx.lastProviderStatus,
            );
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...completedStamp,
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: completedPayload,
            });
            const promptSuggestions = options?.promptSuggestions;
            if (
              completedPayload.state === "completed" &&
              input.suggestNextMessage === true &&
              ctx.suggestionGeneration === turnSuggestionGeneration &&
              promptSuggestions !== undefined
            ) {
              yield* startSuggestion(ctx, promptSuggestions, {
                turnId,
                model,
                completedEventId: completedStamp.eventId,
              });
            }
            yield* settleTurnUsage(ctx, turnId, resolvedModel, usageTotalsOf(result.usage));
            return;
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }
          // The agent may never have taken the prompt: the brief goes again.
          if (ctx.projectBriefCarrier?.turnId === turnId) requeueProjectBrief(ctx);
          const failure = Cause.squash(exit.cause);
          yield* notifyAuthRequired(failure);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: promptFailurePayload(ctx, failure),
          });
          // No result, so no tokens; a running cost the agent reported still counts.
          yield* settleTurnUsage(ctx, turnId, resolvedModel, null);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (ctx.activeTurnId === turnId) {
                ctx.activeTurnId = undefined;
                ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
              }
              if (ctx.openPrompt === prompt) ctx.openPrompt = undefined;
              yield* Deferred.succeed(prompt.closed, undefined);
            }),
          ),
        );
        ctx.promptFiber = yield* Effect.forkIn(runPrompt, ctx.scope);

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
          // A typed agent command left the thread's history and brief owed.
          ...(prepared.contextDeferred ? { contextDeferred: true as const } : {}),
        };
      });

    /**
     * A prompt that outlived `ACP_CANCEL_DEADLINE` after `session/cancel`:
     * the process is stopped and reaped first, so nothing it does lands after
     * the turn is reported cancelled.
     */
    const recycleStuckTurn = (ctx: AcpSessionContext, turnId: TurnId) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (sessions.get(ctx.threadId) !== ctx || ctx.activeTurnId !== turnId) return;
          yield* stopSessionInternal(ctx);
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              message: `${descriptor.presentation.displayName} did not stop in time, so it was restarted. The next message picks the conversation up again.`,
              warningKind: "cancel-timeout",
            },
          });
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
        }),
      );

    const interruptTurn: AcpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* dropSuggestion(ctx);
        const turnId = ctx.activeTurnId;
        const promptFiber = ctx.promptFiber;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        // The turn machine sends the cancel, arms the deadline and ends the turn.
        if (ctx.machine !== undefined) {
          yield* postTurnEvent(ctx, { type: "stopRequested" });
          return;
        }
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        // The agent's own turn has no prompt to wait on; its end notice
        // settles it, and the same deadline applies.
        const agentTurn = ctx.agentTurn?.turnId === turnId ? ctx.agentTurn : undefined;
        const settled =
          agentTurn !== undefined
            ? Deferred.await(agentTurn.ended)
            : promptFiber !== undefined
              ? Fiber.await(promptFiber).pipe(Effect.asVoid)
              : undefined;
        if (turnId !== undefined && settled !== undefined) {
          yield* settled.pipe(
            Effect.timeoutOption(ACP_CANCEL_DEADLINE),
            Effect.flatMap((outcome) =>
              Option.isSome(outcome) ? Effect.void : recycleStuckTurn(ctx, turnId),
            ),
            Effect.forkIn(adapterScope),
          );
        }
      });

    /**
     * A message sent mid-turn, added to the running turn: by the agent's own
     * steer (`descriptor.steer`), or as another prompt (`turnMachine`).
     */
    const steerTurn: AcpAdapterShape["steerTurn"] = descriptor.steer
      ? (input) =>
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const turnId = ctx.activeTurnId;
            const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
            if (turnId === undefined) {
              return yield* steerRejectedError(
                PROVIDER,
                descriptor.presentation.displayName,
                "no-active-turn",
              );
            }
            if (turnId !== input.expectedTurnId || !sessionId) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: `Expected active turn '${input.expectedTurnId}' but ${descriptor.presentation.displayName} is running '${turnId}'.`,
              });
            }
            const text = input.input?.trim() ?? "";
            const content = yield* promptContent(
              ctx,
              text.length > 0 ? text : undefined,
              input.attachments,
              "turn/steer",
            );
            // The text of every block: a file travels as a note naming its path.
            const steerText = content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n\n");
            yield* descriptor.steer!({ acp: ctx.acp, sessionId, text: steerText, content }).pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "turn/steer", cause),
              ),
            );
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          })
      : descriptor.turnMachine?.steer === true
        ? steerTurnByMachine
        : undefined;

    const respondToRequest: AcpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AcpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        if (pending.elicitation !== undefined) {
          const elicitation = pending.elicitation;
          yield* Effect.try({
            try: () => mcpElicitationResponse(elicitation, answers),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "elicitation/create",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: AcpAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    /**
     * Trims the turn list, and with `conversationHistory` rewinds the agent
     * to the first reverted message's prompt, so it forgets the reverted
     * turns. Without a known position for that prompt (a turn before this
     * cursor's history, or a prompt the agent couldn't place) the agent
     * keeps them, and the result says so. With `rollbackByNewSession` the
     * session ends instead (`forgetByNewSession`).
     */
    const rollbackThread: AcpAdapterShape["rollbackThread"] = (threadId, numTurns, options) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        const conversationHistory = descriptor.conversationHistory;
        if (conversationHistory === undefined && descriptor.rollbackByNewSession === true) {
          yield* withThreadLock(
            threadId,
            Effect.suspend(() =>
              sessions.get(threadId) === ctx ? forgetByNewSession(ctx) : Effect.void,
            ),
          );
          return { threadId, turns: ctx.turns, conversationRolledBack: true };
        }
        // The last turn's prompt position may still be on its way.
        if (ctx.activeTurnId === undefined && ctx.promptFiber !== undefined) {
          yield* Fiber.await(ctx.promptFiber).pipe(
            Effect.timeoutOption(ACP_HISTORY_POSITION_TIMEOUT),
          );
        }
        const target = options?.targetUserMessageId;
        const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
        const index =
          target === undefined ? -1 : ctx.history.findIndex((entry) => entry.messageId === target);
        const position = index < 0 ? undefined : ctx.history[index]?.position;
        if (
          conversationHistory === undefined ||
          sessionId === undefined ||
          position === undefined ||
          ctx.activeTurnId !== undefined
        ) {
          return { threadId, turns: ctx.turns, conversationRolledBack: false };
        }
        const rewound = yield* conversationHistory
          .rewind({ acp: ctx.acp, sessionId, position })
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("acp.history.rewind-failed", {
                provider: PROVIDER,
                threadId,
                position,
                cause: cause.message,
              }).pipe(Effect.as(false)),
            ),
          );
        if (rewound) {
          ctx.history.splice(index);
          // The agent now lists only the prompts before this one.
          ctx.newestPosition = position > 0 ? position - 1 : undefined;
          const carrier = ctx.projectBriefCarrier;
          if (
            carrier !== undefined &&
            !ctx.history.some((entry) => entry.turnId === carrier.turnId)
          ) {
            requeueProjectBrief(ctx);
          }
          recordHistory(ctx);
        }
        return { threadId, turns: ctx.turns, conversationRolledBack: rewound };
      });

    /**
     * For an agent that can't rewind (`rollbackByNewSession`): the session
     * ends. ProviderService then forgets its conversation in the thread's
     * binding, so the next message starts a new one seeded with the turns
     * kept. Work still going is stopped first as Stop does (a cancel ends the
     * agent's commands and subagents, Antigravity 1.5.10), and the agent gets
     * a moment to wind it down before its process ends.
     */
    const forgetByNewSession = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        // On the turn machine, Stop is its own path: it cancels the running
        // turn and the work it left, and ends the turn once.
        const machine = ctx.machine;
        const working = () =>
          ctx.activeTurnId !== undefined ||
          (machine !== undefined &&
            (workPending(machine.state) || machine.state.stopping !== undefined));
        if (working()) {
          yield* interruptTurn(ctx.threadId).pipe(Effect.ignore);
          yield* Effect.gen(function* () {
            while (working()) yield* Effect.sleep("50 millis");
          }).pipe(Effect.timeoutOption(ACP_REVERT_WIND_DOWN));
        }
        yield* stopSessionInternal(ctx);
      });

    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.flatMap(requireSession(threadId), (ctx) => stopSessionInternal(ctx)),
      );

    /**
     * A turn in flight counts as running, waiting on the user's answer or
     * approval included: that's what keeps the idle reaper from stopping it
     * (and closing the prompt) while the user is away.
     */
    const listSessions: AcpAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values(), (c) =>
          c.activeTurnId !== undefined && c.session.status === "ready"
            ? { ...c.session, status: "running" as const }
            : { ...c.session },
        ),
      );

    /** `ProviderAdapterShape.whenStopped`: the stopping session stays in `sessions` until its scope closed. */
    const whenStopped = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx === undefined ? Effect.void : Deferred.await(ctx.closed);
      });

    const hasSession: AcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // A snapshot per run: stopping a session removes it from the map.
    const stopAll: AcpAdapterShape["stopAll"] = () =>
      Effect.suspend(() =>
        Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
          discard: true,
        }),
      );

    /**
     * A launched subagent's steps, read from the agent's own records
     * (`subagents`), by its launching call's id. The newest page by default,
     * like other agents' transcripts.
     */
    const readSubagentTranscript = (subagents: AcpSubagents) =>
      ((threadId, input) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const read = yield* subagents.transcript({
            sessionId: ctx.acpSessionId,
            launchCallId: input.agentId,
          });
          if (read === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "readSubagentTranscript",
              detail: subagents.unrecordedMessage,
            });
          }
          const total = read.entries.length;
          const limit = input.limit !== undefined && input.limit > 0 ? input.limit : total;
          const offset = input.fromEnd
            ? Math.max(0, total - limit)
            : Math.min(input.offset ?? 0, total);
          const role = read.launch.role.trim();
          return {
            entries: read.entries.slice(offset, offset + limit),
            truncated: read.truncated || offset > 0 || offset + limit < total,
            offset,
            totalEntries: total,
            agent: {
              id: read.childId,
              ...(role ? { agentType: role, description: role } : {}),
              spawnDepth: 1,
              directInput: "unsupported" as const,
            },
          };
        })) satisfies NonNullable<AcpAdapterShape["readSubagentTranscript"]>;

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), (ctx) => stopSessionInternal(ctx), { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: descriptor.rollbackByNewSession ? "new-session" : "none",
        ...(descriptor.steer || descriptor.turnMachine?.steer === true
          ? { activeTurnSteering: "supported" as const }
          : {}),
        ...(descriptor.conversationHistory ? { nativeThreadFork: "supported" as const } : {}),
      },
      startSession,
      sendTurn,
      ...(steerTurn ? { steerTurn } : {}),
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      whenStopped,
      stopAll,
      noteBeforeStop: processes.beforeStop,
      confirmThreadStopped: processes.confirm,
      listProcesses: processes.owners,
      ...(descriptor.subagents
        ? { readSubagentTranscript: readSubagentTranscript(descriptor.subagents) }
        : {}),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies AcpAdapterShape;
  });
}
