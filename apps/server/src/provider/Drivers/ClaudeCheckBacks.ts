/**
 * Claude's check-backs: times it set itself to come back to the thread, with
 * ScheduleWakeup (one-shot, up to an hour out, exact time) or CronCreate (a
 * cron schedule, one-shot or repeating, run "around" its time).
 *
 * Claude reports the session's whole list at the end of every turn (the Stop
 * hook's `session_crons`: id, cron schedule, recurring, prompt clipped to
 * 1000 characters), with no times or reasons. The scheduling tools' own
 * results fill those in: ScheduleWakeup states its exact time, CronCreate
 * its job id, wording and durability. This module keeps what the tools said
 * and turns each reported list into check-backs, and tells a turn that a
 * fired check-back started from any other.
 */
import type { RuntimeCheckBack, TurnTrigger } from "@threadlines/contracts";
import { nextCronMatch } from "@threadlines/shared/cronSchedule";

/** One entry of the Stop hook's `session_crons`. */
export interface ClaudeSessionCron {
  readonly id: string;
  readonly schedule: string;
  readonly recurring: boolean;
  readonly prompt: string;
}

interface WakeupRecord {
  readonly prompt: string;
  readonly reason: string | undefined;
  readonly scheduledForMs: number;
}

interface CronRecord {
  readonly prompt: string;
  readonly schedule: string | undefined;
  readonly recurring: boolean;
  readonly durable: boolean;
}

/** What a session knows about its check-backs; one per session. */
export interface ClaudeCheckBackState {
  /** ScheduleWakeup calls, by the time they set. They have no job id until
   *  the session's list is matched against them. */
  wakeups: Array<WakeupRecord>;
  /** CronCreate jobs, by id. */
  readonly crons: Map<string, CronRecord>;
  /** When each reported job fires next, worked out once (see nextFireFor). */
  readonly nextFire: Map<string, { readonly ms: number; readonly exact: boolean }>;
  /** Full prompts of reported jobs, for telling a fired one by its prompt. */
  readonly prompts: Map<string, string>;
  /** The list as last reported to orchestration. */
  current: ReadonlyArray<RuntimeCheckBack>;
}

export function makeClaudeCheckBackState(): ClaudeCheckBackState {
  return { wakeups: [], crons: new Map(), nextFire: new Map(), prompts: new Map(), current: [] };
}

/** Longest reason or prompt a check-back carries. */
const DESCRIPTION_MAX_LENGTH = 160;
/** Claude clips a reported prompt and marks the cut: "… [+12 chars]". */
const CLIPPED_PROMPT_MARKER = /\s*… \[\+\d+ chars\]$/u;
const MINUTE_MS = 60_000;
/** How far a job's minute may sit from a wake-up's stated time and still be
 *  that wake-up (the cron fires on the minute the wake-up names). */
const WAKEUP_MATCH_WINDOW_MS = 2 * MINUTE_MS;

function clip(text: string): string | undefined {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length > DESCRIPTION_MAX_LENGTH
    ? `${flat.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
    : flat;
}

function promptMatches(full: string, reported: string): boolean {
  const clipped = reported.replace(CLIPPED_PROMPT_MARKER, "");
  return clipped === reported ? full === reported : full.startsWith(clipped);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Remember what a scheduling tool call set, from its input and its
 * structured result (`tool_use_result`). Other tools are ignored.
 */
export function recordClaudeScheduleTool(
  state: ClaudeCheckBackState,
  call: { readonly toolName: string; readonly input: unknown; readonly result: unknown },
): void {
  const input = asRecord(call.input) ?? {};
  const result = asRecord(call.result);
  if (!result) return;
  if (call.toolName === "ScheduleWakeup") {
    // `stop: true` ends a dynamic loop and cancels its pending wake-ups.
    if (result.stopped === true) {
      state.wakeups = [];
      return;
    }
    const prompt = asString(input.prompt);
    const scheduledForMs = result.scheduledFor;
    if (!prompt || typeof scheduledForMs !== "number" || !Number.isFinite(scheduledForMs)) return;
    state.wakeups = [
      ...state.wakeups.filter((wakeup) => wakeup.scheduledForMs !== scheduledForMs),
      { prompt, reason: asString(input.reason), scheduledForMs },
    ];
    return;
  }
  if (call.toolName === "CronCreate") {
    const id = asString(result.id);
    const prompt = asString(input.prompt);
    if (!id || !prompt) return;
    state.crons.set(id, {
      prompt,
      schedule: asString(result.humanSchedule),
      recurring: result.recurring === true,
      durable: result.durable === true,
    });
  }
}

/**
 * When a reported job fires next. A wake-up's stated time is exact. A cron
 * job's is worked out from its schedule in Claude's time zone, once: a
 * one-shot keeps the first answer (it is never moved to a later day while
 * Claude runs it late), a repeating job moves on once its time has passed.
 */
function nextFireFor(
  state: ClaudeCheckBackState,
  cron: ClaudeSessionCron,
  wakeup: WakeupRecord | undefined,
  nowMs: number,
  timeZone: string | undefined,
): { readonly ms: number; readonly exact: boolean } | undefined {
  if (wakeup) return { ms: wakeup.scheduledForMs, exact: true };
  const known = state.nextFire.get(cron.id);
  if (known && (!cron.recurring || known.ms > nowMs)) return known;
  // A job first seen right after it was set: its next match after "just
  // before now" is the one Claude will run. A repeating job whose time has
  // come moves on past that time, even within the same minute.
  const after = known ? Math.max(known.ms, nowMs - MINUTE_MS) : nowMs - MINUTE_MS;
  const next = nextCronMatch(cron.schedule, new Date(after), timeZone);
  return next ? { ms: next.getTime(), exact: false } : undefined;
}

/** The wake-up a reported one-shot job is: same prompt, firing at its time. */
function wakeupFor(
  state: ClaudeCheckBackState,
  cron: ClaudeSessionCron,
  nowMs: number,
  timeZone: string | undefined,
): WakeupRecord | undefined {
  if (cron.recurring || state.crons.has(cron.id)) return undefined;
  const candidates = state.wakeups.filter((wakeup) => promptMatches(wakeup.prompt, cron.prompt));
  if (candidates.length <= 1) return candidates[0];
  const due = nextCronMatch(cron.schedule, new Date(nowMs - MINUTE_MS), timeZone)?.getTime();
  if (due === undefined) return candidates[0];
  return candidates
    .filter((wakeup) => Math.abs(wakeup.scheduledForMs - due) <= WAKEUP_MATCH_WINDOW_MS)
    .concat(candidates)[0];
}

/**
 * The session's check-backs from Claude's reported job list, soonest first.
 * Forgets what it knew about jobs no longer reported.
 */
export function claudeCheckBacksFromSessionCrons(
  state: ClaudeCheckBackState,
  sessionCrons: ReadonlyArray<ClaudeSessionCron>,
  nowMs: number,
  timeZone: string | undefined,
): ReadonlyArray<RuntimeCheckBack> {
  const checkBacks: Array<RuntimeCheckBack> = [];
  const reportedIds = new Set<string>();
  const usedWakeups = new Set<WakeupRecord>();
  for (const cron of sessionCrons) {
    reportedIds.add(cron.id);
    const record = state.crons.get(cron.id);
    const wakeup = wakeupFor(state, cron, nowMs, timeZone);
    if (wakeup) usedWakeups.add(wakeup);
    const fire = nextFireFor(state, cron, wakeup, nowMs, timeZone);
    if (!fire) continue;
    state.nextFire.set(cron.id, fire);
    const prompt = record?.prompt ?? wakeup?.prompt ?? cron.prompt;
    state.prompts.set(cron.id, prompt);
    const description = clip(wakeup?.reason ?? prompt);
    const schedule = cron.recurring ? record?.schedule : undefined;
    checkBacks.push({
      id: cron.id,
      scheduledFor: new Date(fire.ms).toISOString(),
      exact: fire.exact,
      recurring: cron.recurring,
      ...(schedule ? { schedule } : {}),
      ...(description ? { description } : {}),
      // A job neither set by a CronCreate nor a wake-up this session saw came
      // from disk (a durable job the CLI restored): it outlives the session.
      durable: record ? record.durable : wakeup === undefined,
    });
  }
  for (const id of [...state.nextFire.keys()]) {
    if (!reportedIds.has(id)) {
      state.nextFire.delete(id);
      state.prompts.delete(id);
      state.crons.delete(id);
    }
  }
  // A wake-up no reported job is any more has fired or was cancelled.
  state.wakeups = state.wakeups.filter(
    (wakeup) => usedWakeups.has(wakeup) || wakeup.scheduledForMs > nowMs,
  );
  return checkBacks.toSorted((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
}

/**
 * What started a turn Claude began with no message from Threadlines: the
 * check-back whose prompt Claude submitted (the full prompt, else its
 * clipped form; the soonest due on a tie), or an unnamed check-back when
 * Claude says the prompt is a scheduled one. Undefined for any other turn
 * (a background task waking it, say).
 */
export function claudeCheckBackTrigger(
  state: ClaudeCheckBackState,
  prompt: string,
  source: string | undefined,
  nowMs: number,
): TurnTrigger | undefined {
  const candidates = state.current.filter((checkBack) => {
    const full = state.prompts.get(checkBack.id);
    return full !== undefined && (full === prompt || promptMatches(prompt, full));
  });
  const fired = candidates.toSorted(
    (left, right) =>
      Math.abs(Date.parse(left.scheduledFor) - nowMs) -
      Math.abs(Date.parse(right.scheduledFor) - nowMs),
  )[0];
  if (fired) {
    return {
      kind: "check-back",
      checkBackId: fired.id,
      scheduledFor: fired.scheduledFor,
      recurring: fired.recurring,
    };
  }
  return source === "loop_wakeup" || source === "schedule_wakeup"
    ? { kind: "check-back" }
    : undefined;
}
