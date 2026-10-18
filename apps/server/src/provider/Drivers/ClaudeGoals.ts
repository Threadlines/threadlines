/**
 * Claude's `/goal` mode, as Threadlines drives and reads it.
 *
 * A goal is a slash command: `/goal <condition>` arms a session Stop hook whose
 * evaluator keeps the turn going until the condition holds, `/goal clear`
 * disarms it. The CLI answers each command with a synthetic assistant message
 * tagged `local_command_run: { command: "goal", args }`: "Goal set: …" opens
 * the turn that works toward the goal, anything else (a refusal, "Goal
 * cleared: …", "No goal set") ends with a zero-turn result of its own.
 *
 * Local SDK sessions never stream the goal's progress (the CLI emits
 * `active_goal` only in its own cloud sessions), but every change lands in
 * the session transcript as a `goal_status` attachment: set, each failed
 * check with the evaluator's reason, met, impossible, and cleared. Folding
 * those records is how the adapter knows the goal's state, including goals
 * the model set itself and goals restored when a session resumes.
 *
 * Verified against Claude Code 2.1.301 through the Agent SDK.
 */
import type { RuntimeThreadGoalSnapshot } from "@threadlines/contracts";

/** The CLI's limit on a goal condition. */
export const CLAUDE_GOAL_MAX_CONDITION_CHARS = 4_000;

/** Arguments the CLI reads as "clear the goal" rather than as a condition. */
const CLAUDE_GOAL_CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

export function isClaudeGoalClearWord(text: string): boolean {
  return CLAUDE_GOAL_CLEAR_WORDS.has(text.trim().toLowerCase());
}

export const CLAUDE_GOAL_CLEAR_ARGS = "clear";

export function claudeGoalCommandText(args: string): string {
  return `/goal ${args}`;
}

/** How the CLI confirms a goal it armed. */
export function claudeGoalSetReplyText(condition: string): string {
  return `Goal set: ${condition}`;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export interface ClaudeGoalCommandReply {
  /** What followed `/goal`, as the CLI read it. */
  readonly args: string;
  readonly text: string;
}

/** The CLI's answer to a `/goal` command, from an SDK assistant message. */
export function claudeGoalCommandReply(message: unknown): ClaudeGoalCommandReply | undefined {
  const value = record(message);
  if (value?.type !== "assistant") return undefined;
  const run = record(value.local_command_run);
  if (run?.command !== "goal") return undefined;
  const content = record(value.message)?.content;
  const replyText = Array.isArray(content)
    ? content
        .map((block) => {
          const entry = record(block);
          return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
        })
        .join("")
    : typeof content === "string"
      ? content
      : "";
  return { args: typeof run.args === "string" ? run.args.trim() : "", text: replyText.trim() };
}

/** The zero-turn result that ends a `/goal` command which started no work. */
export function isClaudeGoalCommandResult(message: unknown): boolean {
  const value = record(message);
  return value?.type === "result" && value.local_command === "goal" && value.num_turns === 0;
}

export type ClaudeGoalRecord =
  | { readonly kind: "set"; readonly condition: string; readonly at?: string }
  | {
      readonly kind: "check-failed";
      readonly condition: string;
      readonly reason?: string;
      readonly at?: string;
    }
  | {
      readonly kind: "met" | "impossible";
      readonly condition: string;
      readonly reason?: string;
      readonly iterations?: number;
      readonly durationMs?: number;
      readonly tokens?: number;
      readonly at?: string;
    }
  | { readonly kind: "cleared"; readonly condition: string; readonly at?: string };

/** The transcript marker every goal record carries, for cheap prefiltering. */
export const CLAUDE_GOAL_TRANSCRIPT_MARKER = '"type":"goal_status"';

/** One transcript line as a goal record, or undefined for any other line. */
export function parseClaudeGoalTranscriptLine(line: string): ClaudeGoalRecord | undefined {
  if (!line.includes(CLAUDE_GOAL_TRANSCRIPT_MARKER)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = record(parsed);
  const attachment = record(entry?.attachment);
  if (entry?.type !== "attachment" || attachment?.type !== "goal_status") return undefined;
  const condition = text(attachment.condition);
  if (condition === undefined) return undefined;
  const at = text(entry.timestamp);
  const reason = text(attachment.reason);
  const base = { condition, ...(at !== undefined ? { at } : {}) };
  if (attachment.sentinel === true) {
    // A sentinel marks the hook being armed (met: false) or disarmed by a
    // clear or an unrecoverable error (met: true); neither is a verdict.
    return attachment.met === true ? { kind: "cleared", ...base } : { kind: "set", ...base };
  }
  if (attachment.met === true || attachment.failed === true) {
    const iterations = count(attachment.iterations);
    const durationMs = count(attachment.durationMs);
    const tokens = count(attachment.tokens);
    return {
      kind: attachment.met === true ? "met" : "impossible",
      ...base,
      ...(reason !== undefined ? { reason } : {}),
      ...(iterations !== undefined ? { iterations } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
    };
  }
  return { kind: "check-failed", ...base, ...(reason !== undefined ? { reason } : {}) };
}

/** Every goal record in a run of complete transcript lines, in order. */
export function parseClaudeGoalTranscript(contents: string): ReadonlyArray<ClaudeGoalRecord> {
  const records: Array<ClaudeGoalRecord> = [];
  let searchFrom = 0;
  while (true) {
    const markerIndex = contents.indexOf(CLAUDE_GOAL_TRANSCRIPT_MARKER, searchFrom);
    if (markerIndex < 0) break;
    const lineStart = contents.lastIndexOf("\n", markerIndex) + 1;
    const newline = contents.indexOf("\n", markerIndex);
    const lineEnd = newline < 0 ? contents.length : newline;
    const parsed = parseClaudeGoalTranscriptLine(contents.slice(lineStart, lineEnd));
    if (parsed !== undefined) records.push(parsed);
    searchFrom = lineEnd + 1;
  }
  return records;
}

/** What Threadlines knows of the session's goal. */
export interface ClaudeGoalState {
  readonly objective: string;
  readonly status: "active" | "complete" | "blocked";
  readonly setAt: string;
  readonly updatedAt: string;
  /** Checks the evaluator has run against this goal. */
  readonly checks: number;
  /** The evaluator's latest reason: why the goal is not met yet, or why it is done. */
  readonly lastCheck?: string;
  /** Tokens spent on the goal, known once it finishes. */
  readonly tokensUsed?: number;
  /** Time spent on the goal, known once it finishes. */
  readonly durationMs?: number;
}

/**
 * Fold one goal record into the session's goal. `now` stands in for records
 * without a timestamp. A record about a different condition than the tracked
 * one still wins: the transcript is the CLI's own account.
 */
export function applyClaudeGoalRecord(
  state: ClaudeGoalState | null,
  goalRecord: ClaudeGoalRecord,
  now: string,
): ClaudeGoalState | null {
  const at = goalRecord.at ?? now;
  const sameGoal = state !== null && state.objective === goalRecord.condition;
  switch (goalRecord.kind) {
    case "set":
      return {
        objective: goalRecord.condition,
        status: "active",
        setAt: at,
        updatedAt: at,
        checks: 0,
      };
    case "check-failed":
      return {
        objective: goalRecord.condition,
        status: "active",
        setAt: sameGoal ? state.setAt : at,
        updatedAt: at,
        checks: (sameGoal ? state.checks : 0) + 1,
        ...(goalRecord.reason !== undefined ? { lastCheck: goalRecord.reason } : {}),
      };
    case "met":
    case "impossible": {
      const checks = goalRecord.iterations ?? (sameGoal ? state.checks + 1 : 1);
      return {
        objective: goalRecord.condition,
        status: goalRecord.kind === "met" ? "complete" : "blocked",
        setAt: sameGoal ? state.setAt : at,
        updatedAt: at,
        checks,
        ...(goalRecord.reason !== undefined ? { lastCheck: goalRecord.reason } : {}),
        ...(goalRecord.tokens !== undefined ? { tokensUsed: goalRecord.tokens } : {}),
        ...(goalRecord.durationMs !== undefined ? { durationMs: goalRecord.durationMs } : {}),
      };
    }
    case "cleared":
      return null;
  }
}

export function sameClaudeGoalState(
  left: ClaudeGoalState | null,
  right: ClaudeGoalState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.objective === right.objective &&
    left.status === right.status &&
    left.setAt === right.setAt &&
    left.checks === right.checks &&
    left.lastCheck === right.lastCheck &&
    left.tokensUsed === right.tokensUsed &&
    left.durationMs === right.durationMs
  );
}

const MAX_LAST_CHECK_CHARS = 1_000;

/** The goal as the orchestration layer stores it. Elapsed time runs from the
 *  goal being set until now, or until it finished. */
export function claudeGoalSnapshot(
  state: ClaudeGoalState,
  nowMs: number,
): RuntimeThreadGoalSnapshot {
  const setAtMs = Date.parse(state.setAt);
  const elapsedMs =
    state.durationMs ?? (Number.isFinite(setAtMs) ? Math.max(0, nowMs - setAtMs) : 0);
  const lastCheck =
    state.lastCheck !== undefined && state.lastCheck.length > MAX_LAST_CHECK_CHARS
      ? `${state.lastCheck.slice(0, MAX_LAST_CHECK_CHARS - 1).trimEnd()}…`
      : state.lastCheck;
  return {
    objective: state.objective,
    status: state.status,
    tokenBudget: null,
    tokensUsed: state.tokensUsed ?? 0,
    timeUsedSeconds: Math.floor(elapsedMs / 1000),
    createdAt: state.setAt,
    updatedAt: state.updatedAt,
    checks: state.checks,
    ...(lastCheck !== undefined ? { lastCheck } : {}),
  };
}
