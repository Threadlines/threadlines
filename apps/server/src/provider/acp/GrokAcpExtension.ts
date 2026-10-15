/**
 * GrokAcpExtension — xAI's ACP extensions to Grok Build, as schemas and pure
 * mappings onto Threadlines' runtime events. The descriptor in
 * `GrokAcpSupport.ts` registers them.
 *
 * Grok sends every extension with a leading underscore (`_x.ai/...`); older
 * builds used `x.ai/...`, so both spellings are handled. Payload shapes come
 * from grok-build's source and from recorded Grok 1.0.41-1.0.60 sessions.
 *
 * @module provider/acp/GrokAcpExtension
 */
import {
  type ProviderUserInputAnswers,
  RuntimeTaskId,
  type UserInputQuestion,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";

import type { AcpExtensionRuntimeEvent, AcpTurnOutcome } from "./AcpProviderDescriptor.ts";

/** Both spellings of one xAI method, current first. */
export const xaiMethods = (name: string) => [`_x.ai/${name}`, `x.ai/${name}`] as const;

/**
 * Our own prompts carry this prefix in their `promptId`; Grok's own turns
 * (waking for finished background work) carry theirs (`task-completed-…`,
 * `subagent-completed-…`).
 */
export const GROK_PROMPT_ID_PREFIX = "threadlines-";

export const grokPromptId = (turnId: string) => `${GROK_PROMPT_ID_PREFIX}${turnId}`;

const isOwnPromptId = (promptId: string) => promptId.startsWith(GROK_PROMPT_ID_PREFIX);

const Text = Schema.String;
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text Grok attached to a failed turn (`agent_result`): a string, or an object with a message. */
function agentResultText(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmpty(value);
  if (isRecord(value))
    return nonEmpty(value.message) ?? nonEmpty(value.text) ?? nonEmpty(value.error);
  return undefined;
}

// ── Questions (`_x.ai/ask_user_question`) ────────────────────────────

const GrokQuestionOption = Schema.Struct({
  label: Text,
  description: OptionalText,
});

const GrokQuestion = Schema.Struct({
  question: Text,
  options: Schema.Array(GrokQuestionOption),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
  multi_select: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const GrokAskUserQuestionRequest = Schema.Struct({
  sessionId: Schema.optional(Text),
  toolCallId: Schema.optional(Text),
  questions: Schema.Array(GrokQuestion),
  mode: Schema.optional(Text),
});
export type GrokAskUserQuestionRequest = typeof GrokAskUserQuestionRequest.Type;

/**
 * Grok's questions as question cards. A question's text is its id: Grok keys
 * the answers by it. One with no choices gets a single "OK".
 */
export function grokUserInputQuestions(
  request: GrokAskUserQuestionRequest,
): ReadonlyArray<UserInputQuestion> {
  return request.questions.flatMap((question) => {
    const text = nonEmpty(question.question);
    if (text === undefined) return [];
    const options = question.options.flatMap((option) => {
      const label = nonEmpty(option.label);
      return label === undefined
        ? []
        : [{ label, description: nonEmpty(option.description) ?? label }];
    });
    return [
      {
        id: text,
        header: "Question",
        question: text,
        multiSelect: question.multiSelect === true || question.multi_select === true,
        options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
      },
    ];
  });
}

export type GrokAskUserQuestionReply =
  | {
      readonly outcome: "accepted";
      readonly answers: Record<string, ReadonlyArray<string>>;
      readonly annotations?: Record<string, { readonly notes: string }>;
    }
  | { readonly outcome: "cancelled" };

/**
 * The user's answers in Grok's shape: the chosen labels per question, and
 * text that matches no choice as Grok's "Other" with the text as its note.
 * No answers at all (a stop, a closed card) cancels.
 */
export function grokAskUserQuestionReply(
  request: GrokAskUserQuestionRequest,
  answers: ProviderUserInputAnswers,
): GrokAskUserQuestionReply {
  const replyAnswers: Record<string, ReadonlyArray<string>> = {};
  const annotations: Record<string, { readonly notes: string }> = {};
  for (const question of request.questions) {
    const text = nonEmpty(question.question);
    if (text === undefined) continue;
    const raw = answers[text];
    const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
      const trimmed = nonEmpty(value);
      return trimmed === undefined ? [] : [trimmed];
    });
    if (values.length === 0) continue;
    const labels = new Set(question.options.map((option) => option.label.trim()));
    const chosen = values.filter((value) => labels.has(value));
    const typed = values.filter((value) => !labels.has(value) && value !== "OK");
    if (typed.length > 0) annotations[text] = { notes: typed.join("\n") };
    replyAnswers[text] =
      typed.length > 0 ? [...chosen, "Other"] : chosen.length > 0 ? chosen : ["OK"];
  }
  if (Object.keys(replyAnswers).length === 0) return { outcome: "cancelled" };
  return {
    outcome: "accepted",
    answers: replyAnswers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

// ── Plan approval (`_x.ai/exit_plan_mode`) ───────────────────────────

export const GrokExitPlanModeRequest = Schema.Struct({
  sessionId: Schema.optional(Text),
  toolCallId: Schema.optional(Text),
  planContent: OptionalText,
});
export type GrokExitPlanModeRequest = typeof GrokExitPlanModeRequest.Type;

export function grokPlanMarkdown(request: GrokExitPlanModeRequest): string {
  return nonEmpty(request.planContent) ?? "# Plan\n\n(Grok did not send the plan text.)";
}

/**
 * The answer once the plan card holds the plan: leave plan mode and wait.
 * `approved` would start building without the user (Grok runs an
 * implementation turn on it), and an error reply makes Grok treat the client
 * as gone and stay in plan mode. The user builds from the card, which sends
 * the next message.
 */
export const GROK_PLAN_CAPTURED_REPLY = { outcome: "abandoned" } as const;

// ── MCP server questions (`_x.ai/mcp/elicit`) ────────────────────────

/** An MCP server's question that has no card yet: declined, so the turn goes on. */
export const GROK_MCP_ELICIT_REPLY = { outcome: "cancel" } as const;

// ── Session notifications ────────────────────────────────────────────

/** `{sessionId, update}` on `_x.ai/session_notification`, `_x.ai/session/update` and the task methods. */
export const GrokSessionNotification = Schema.Struct({
  sessionId: Text,
  update: Schema.Record(Schema.String, Schema.Unknown),
});
export type GrokSessionNotification = typeof GrokSessionNotification.Type;

export const GROK_SESSION_NOTIFICATION_METHODS = [
  ...xaiMethods("session_notification"),
  ...xaiMethods("session/update"),
] as const;

export const GrokQueueChanged = Schema.Struct({
  sessionId: Text,
  runningPromptId: Schema.optional(Schema.NullOr(Text)),
});
export type GrokQueueChanged = typeof GrokQueueChanged.Type;

export const GrokPromptComplete = Schema.Struct({
  sessionId: Text,
  promptId: Schema.optional(Schema.NullOr(Text)),
  stopReason: Schema.optional(Schema.NullOr(Text)),
  agentResult: Schema.optional(Schema.Unknown),
});
export type GrokPromptComplete = typeof GrokPromptComplete.Type;

/** A turn Grok started itself began: `queue/changed` names a running prompt that isn't ours. */
export function grokAgentTurnStarted(notification: GrokQueueChanged): boolean {
  const running = nonEmpty(notification.runningPromptId);
  return running !== undefined && !isOwnPromptId(running);
}

/** How Grok's `stop_reason` and `agent_result` read as a turn's end. */
export function grokTurnOutcome(stopReason: unknown, agentResult: unknown): AcpTurnOutcome {
  const reason = nonEmpty(stopReason);
  const text = agentResultText(agentResult);
  if (reason === "cancelled") return { state: "cancelled", stopReason: reason };
  if (reason === "error" || reason === "rate_limit" || reason === "refusal") {
    return {
      state: "failed",
      stopReason: reason,
      errorMessage:
        text ??
        (reason === "rate_limit"
          ? "Grok hit its usage limit. Check your plan's usage on grok.com."
          : "Grok stopped with an error."),
    };
  }
  return { state: "completed", ...(reason ? { stopReason: reason } : {}) };
}

export type GrokTurnEnd =
  | { readonly _tag: "OwnPrompt"; readonly outcome: AcpTurnOutcome }
  | { readonly _tag: "AgentTurn"; readonly outcome: AcpTurnOutcome };

/** A `turn_completed` update: the end of our prompt, or of a turn Grok started itself. */
export function grokTurnEndFromUpdate(
  notification: GrokSessionNotification,
): GrokTurnEnd | undefined {
  const update = notification.update;
  if (update.sessionUpdate !== "turn_completed") return undefined;
  const promptId = nonEmpty(update.prompt_id) ?? nonEmpty(update.promptId);
  const outcome = grokTurnOutcome(update.stop_reason ?? update.stopReason, update.agent_result);
  if (promptId !== undefined && isOwnPromptId(promptId)) return { _tag: "OwnPrompt", outcome };
  return { _tag: "AgentTurn", outcome };
}

/** `prompt_complete` is sent for our prompts only; it repeats `turn_completed`. */
export function grokOwnPromptOutcome(notification: GrokPromptComplete): AcpTurnOutcome | undefined {
  const promptId = nonEmpty(notification.promptId);
  if (promptId === undefined || !isOwnPromptId(promptId)) return undefined;
  return grokTurnOutcome(notification.stopReason, notification.agentResult);
}

// ── Background work: shells and subagents ────────────────────────────

const taskId = (value: string) => RuntimeTaskId.make(value);

/** What Grok runs in the background, so the thread can say what it waits on. */
export interface GrokBackgroundWork {
  /** Background shells and monitors, from Grok's latest `background_tasks` snapshot. */
  readonly shells: ReadonlyMap<string, { readonly description?: string }>;
  /** Subagents spawned and not finished. */
  readonly subagents: ReadonlyMap<string, { readonly description?: string }>;
}

export const emptyGrokBackgroundWork = (): GrokBackgroundWork => ({
  shells: new Map(),
  subagents: new Map(),
});

/** The replace-all task snapshot for the work Grok runs now. */
export function grokTaskSnapshot(work: GrokBackgroundWork): AcpExtensionRuntimeEvent {
  return {
    type: "task.snapshot.updated",
    payload: {
      tasks: [
        ...Array.from(work.shells, ([id, shell]) => ({
          taskId: taskId(id),
          taskType: "local_bash",
          kind: "command" as const,
          ...(shell.description ? { description: shell.description } : {}),
        })),
        ...Array.from(work.subagents, ([id, agent]) => ({
          taskId: taskId(id),
          taskType: "agent",
          kind: "agent" as const,
          ...(agent.description ? { description: agent.description } : {}),
        })),
      ],
    },
  };
}

export interface GrokBackgroundChange {
  readonly work: GrokBackgroundWork;
  readonly events: ReadonlyArray<AcpExtensionRuntimeEvent>;
}

/**
 * Folds one update on this session into the background work, with the task
 * and subagent events it means. Undefined when the update is about neither.
 * Task edges defer to the snapshot for the pending count: a killed task gets
 * no `task_completed`, and only the snapshot then says it is gone.
 */
export function grokBackgroundChange(
  work: GrokBackgroundWork,
  update: Readonly<Record<string, unknown>>,
): GrokBackgroundChange | undefined {
  const kind = update.sessionUpdate;
  if (kind === "background_tasks") {
    const tasks = Array.isArray(update.tasks) ? update.tasks : [];
    const shells = new Map<string, { readonly description?: string }>();
    for (const task of tasks) {
      if (!isRecord(task)) continue;
      const id = nonEmpty(task.task_id);
      const status = nonEmpty(task.status);
      if (id === undefined || (status !== undefined && status !== "running")) continue;
      const description = nonEmpty(task.description) ?? nonEmpty(task.command);
      shells.set(id, description ? { description } : {});
    }
    const next = { ...work, shells };
    return { work: next, events: [grokTaskSnapshot(next)] };
  }
  if (kind === "task_backgrounded") {
    const id = nonEmpty(update.task_id) ?? nonEmpty(update.tool_call_id);
    if (id === undefined) return undefined;
    const description = nonEmpty(update.description) ?? nonEmpty(update.command);
    const toolUseId = nonEmpty(update.tool_call_id);
    const shells = new Map(work.shells).set(id, description ? { description } : {});
    const next = { ...work, shells };
    return {
      work: next,
      events: [
        {
          type: "task.started",
          payload: {
            taskId: taskId(id),
            taskType: "local_bash",
            isBackgrounded: true,
            pendingCountManagedBySnapshot: true,
            ...(description ? { description } : {}),
            ...(toolUseId ? { toolUseId } : {}),
          },
        },
        grokTaskSnapshot(next),
      ],
    };
  }
  if (kind === "task_completed") {
    const snapshot = isRecord(update.task_snapshot) ? update.task_snapshot : {};
    const id = nonEmpty(snapshot.task_id) ?? nonEmpty(update.task_id);
    if (id === undefined) return undefined;
    const exitCode = snapshot.exit_code;
    const status =
      snapshot.explicitly_killed === true
        ? ("stopped" as const)
        : typeof exitCode === "number" && exitCode !== 0
          ? ("failed" as const)
          : ("completed" as const);
    const summary = nonEmpty(snapshot.description) ?? nonEmpty(snapshot.command);
    const shells = new Map(work.shells);
    shells.delete(id);
    const next = { ...work, shells };
    return {
      work: next,
      events: [
        {
          type: "task.completed",
          payload: {
            taskId: taskId(id),
            status,
            taskType: "local_bash",
            pendingCountManagedBySnapshot: true,
            ...(summary ? { summary } : {}),
          },
        },
        grokTaskSnapshot(next),
      ],
    };
  }
  if (kind === "subagent_spawned") {
    const id = nonEmpty(update.subagent_id);
    if (id === undefined) return undefined;
    const description = nonEmpty(update.description);
    const subagentType = nonEmpty(update.subagent_type);
    const childSessionId = nonEmpty(update.child_session_id);
    const model = nonEmpty(update.model);
    const subagents = new Map(work.subagents).set(id, description ? { description } : {});
    const next = { ...work, subagents };
    return {
      work: next,
      events: [
        {
          type: "task.started",
          payload: {
            taskId: taskId(id),
            taskType: "agent",
            isBackgrounded: true,
            spawnDepth: 1,
            pendingCountManagedBySnapshot: true,
            ...(description ? { description } : {}),
            ...(subagentType ? { subagentType } : {}),
          },
        },
        {
          type: "subagent.metadata.updated",
          payload: {
            callId: id,
            ...(childSessionId ? { agentThreadId: childSessionId } : {}),
            treeDepth: 1,
            isBackgrounded: true,
            status: "running",
            ...(description ? { taskName: description } : {}),
            ...(subagentType ? { agentRole: subagentType } : {}),
            ...(model ? { model, modelSource: "provider" as const } : {}),
          },
        },
        grokTaskSnapshot(next),
      ],
    };
  }
  if (kind === "subagent_progress") {
    const id = nonEmpty(update.subagent_id);
    if (id === undefined) return undefined;
    const description = work.subagents.get(id)?.description ?? "Subagent";
    const tools = Array.isArray(update.tools_used) ? update.tools_used : [];
    const lastToolName = nonEmpty(tools.at(-1));
    return {
      work,
      events: [
        {
          type: "task.progress",
          payload: {
            taskId: taskId(id),
            description,
            ...(lastToolName ? { lastToolName } : {}),
          },
        },
      ],
    };
  }
  if (kind === "subagent_finished") {
    const id = nonEmpty(update.subagent_id);
    if (id === undefined) return undefined;
    const outcome = nonEmpty(update.status);
    const status =
      outcome === "failed"
        ? ("failed" as const)
        : outcome === "cancelled"
          ? ("stopped" as const)
          : ("completed" as const);
    const result =
      status === "completed"
        ? nonEmpty(update.output)
        : (nonEmpty(update.error) ?? nonEmpty(update.output));
    const subagents = new Map(work.subagents);
    subagents.delete(id);
    const next = { ...work, subagents };
    return {
      work: next,
      events: [
        {
          type: "task.completed",
          payload: {
            taskId: taskId(id),
            status,
            taskType: "agent",
            pendingCountManagedBySnapshot: true,
            ...(result ? { summary: result.slice(0, 2000) } : {}),
          },
        },
        {
          type: "subagent.metadata.updated",
          payload: {
            callId: id,
            status:
              status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted",
            ...(result ? { resultBody: result } : {}),
          },
        },
        grokTaskSnapshot(next),
      ],
    };
  }
  return undefined;
}

// ── Rewind and fork ───────────────────────────────────────────────────

const OptionalCount = Schema.optional(Schema.NullOr(Schema.Number));

const GrokRewindPoint = Schema.Struct({
  promptIndex: OptionalCount,
  prompt_index: OptionalCount,
  promptPreview: OptionalText,
  prompt_preview: OptionalText,
});
const GrokRewindPoints = Schema.Struct({
  rewindPoints: Schema.optional(Schema.NullOr(Schema.Array(GrokRewindPoint))),
  rewind_points: Schema.optional(Schema.NullOr(Schema.Array(GrokRewindPoint))),
});
const decodeGrokRewindPoints = Schema.decodeUnknownOption(GrokRewindPoints);

const comparableText = (text: string) => text.replace(/\s+/gu, " ").trim();
const TRUNCATION = /(?:…|\.\.\.)$/u;

/**
 * Where a prompt Threadlines sent sits among `_x.ai/rewind/points` (one per
 * prompt Grok was sent; a message steered into a turn adds none), by its
 * text: Grok's preview is the prompt's head (its first line, Grok 1.0.52),
 * so a point after `after` (the newest position listed before the prompt
 * went out) matches when the sent text starts with it. Exactly one match is
 * the answer; none or several is no answer. Also the newest position
 * listed, for the next prompt's `after`.
 */
export function grokPromptPosition(
  points: unknown,
  promptText: string,
  after: number | undefined,
): { readonly position: number | undefined; readonly newest: number | undefined } {
  const decoded = decodeGrokRewindPoints(points);
  if (decoded._tag === "None") return { position: undefined, newest: undefined };
  const listed = decoded.value.rewindPoints ?? decoded.value.rewind_points ?? [];
  const positions = listed.flatMap((point) => {
    const position = point.promptIndex ?? point.prompt_index;
    return typeof position === "number" && Number.isInteger(position) && position >= 0
      ? [position]
      : [];
  });
  const newest = positions.length > 0 ? Math.max(...positions) : undefined;
  const sent = comparableText(promptText);
  if (!sent) return { position: undefined, newest };
  const matches = listed
    .flatMap((point) => {
      const position = point.promptIndex ?? point.prompt_index;
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return [];
      const head = comparableText(point.promptPreview ?? point.prompt_preview ?? "")
        .replace(TRUNCATION, "")
        .trimEnd();
      return head.length > 0 && sent.startsWith(head) && (after === undefined || position > after)
        ? [position]
        : [];
    })
    .toSorted((left, right) => left - right);
  // Two candidates mean one wasn't accounted for (an earlier turn's lookup
  // failed and both prompts open alike): placing either could rewind too far.
  if (matches.length > 1) return { position: undefined, newest };
  return { position: matches[0], newest };
}

const GrokRewindResult = Schema.Struct({ success: Schema.optional(Schema.NullOr(Schema.Boolean)) });
const decodeGrokRewindResult = Schema.decodeUnknownOption(GrokRewindResult);

/**
 * Whether `_x.ai/rewind/execute` says it rewound. Only a plain yes counts:
 * an answer in another shape must not read as a rewind that never happened.
 */
export function grokRewound(result: unknown): boolean {
  const decoded = decodeGrokRewindResult(result);
  return decoded._tag === "Some" && decoded.value.success === true;
}

const GrokForkResult = Schema.Struct({ newSessionId: Schema.String });
const decodeGrokForkResult = Schema.decodeUnknownOption(GrokForkResult);

/** The copy `_x.ai/session/fork` made, by id. */
export function grokForkedSessionId(result: unknown): string | undefined {
  const decoded = decodeGrokForkResult(result);
  return decoded._tag === "Some" && decoded.value.newSessionId.trim()
    ? decoded.value.newSessionId.trim()
    : undefined;
}
