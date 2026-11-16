/**
 * Tool-use eval cases: one user message to a real agent, and checks on what
 * it did with Threadlines' tools (see cannedTools.ts for what each tool
 * answers). A check says what a user would notice going wrong.
 */
import type { RuntimeMode } from "@threadlines/contracts";

import type { CannedAnswers, ToolCall } from "./cannedTools.ts";

/** One of the agent's own tools (Bash, Claude's Agent or CronCreate, Codex's spawn_agent). */
export interface NativeToolUse {
  readonly name: string;
  readonly input: unknown;
}

export interface EvalRun {
  readonly calls: ReadonlyArray<ToolCall>;
  readonly native: ReadonlyArray<NativeToolUse>;
  /** Approvals the agent asked for (each declined). */
  readonly declinedApprovals?: number;
  readonly reply: string;
}

/** Null when it holds; otherwise what went wrong. */
export type Check = (run: EvalRun) => string | null;

export interface ToolUseCase {
  readonly name: string;
  readonly message: string;
  readonly runtimeMode?: RuntimeMode;
  readonly answers?: CannedAnswers;
  readonly checks: ReadonlyArray<Check>;
}

const callsOf = (run: EvalRun, tool: string) => run.calls.filter((call) => call.tool === tool);

export const calls =
  (tool: string, range: { readonly min?: number; readonly max?: number } = { min: 1 }): Check =>
  (run) => {
    const count = callsOf(run, tool).length;
    if (range.min !== undefined && count < range.min)
      return `called ${tool} ${count}× (want ≥${range.min})`;
    if (range.max !== undefined && count > range.max)
      return `called ${tool} ${count}× (want ≤${range.max})`;
    return null;
  };

export const never =
  (...tools: ReadonlyArray<string>): Check =>
  (run) => {
    const used = tools.filter((tool) => callsOf(run, tool).length > 0);
    return used.length > 0 ? `called ${used.join(", ")}` : null;
  };

/** No Threadlines tool at all. */
export const noThreadlinesTools: Check = (run) =>
  run.calls.length > 0
    ? `called ${[...new Set(run.calls.map((call) => call.tool))].join(", ")}`
    : null;

export const firstBefore =
  (first: string, then: string): Check =>
  (run) => {
    const firstAt = run.calls.findIndex((call) => call.tool === first);
    const thenAt = run.calls.findIndex((call) => call.tool === then);
    if (thenAt === -1) return null;
    return firstAt === -1 || firstAt > thenAt ? `called ${then} before ${first}` : null;
  };

export const everyCall =
  (tool: string, holds: (input: Record<string, unknown>) => boolean, what: string): Check =>
  (run) =>
    callsOf(run, tool).every((call) => holds(call.input)) ? null : `${tool} ${what}`;

export const noNativeTool =
  (pattern: RegExp, what: string): Check =>
  (run) => {
    const used = run.native.filter(
      (tool) => pattern.test(tool.name) || pattern.test(JSON.stringify(tool.input ?? "")),
    );
    return used.length > 0 ? `${what} (${used.map((tool) => tool.name).join(", ")})` : null;
  };

/** Polling a thread it just started, instead of ending its turn and waiting for the report. */
const noPolling: Check = (run) => {
  const startAt = run.calls.findIndex((call) => call.tool === "thread_start");
  if (startAt === -1) return null;
  const after = run.calls
    .slice(startAt + 1)
    .filter((call) => /^thread_(read|list)$/.test(call.tool));
  return after.length > 0
    ? `polled with ${after.map((call) => call.tool).join(", ")} after starting`
    : null;
};

const noSleeping = noNativeTool(/\bsleep\s+\d|ScheduleWakeup|Monitor/, "waited in a loop");

/** Doing a thread's work with its own subagent instead. */
const noNativeSubagent = noNativeTool(
  /^(Agent|Task|spawn_?agent|collab_agent_tool_call)$/i,
  "used its own subagent tool",
);

/** A sentence of the reply that says something the run didn't do. */
const replyNot =
  (claim: RegExp, what: string, unless?: RegExp): Check =>
  (run) => {
    const said = run.reply
      .split(/(?<=[.!?\n])\s+/)
      .find((sentence) => claim.test(sentence) && (unless === undefined || !unless.test(sentence)));
    return said === undefined ? null : `${what}: "${said.trim().slice(0, 120)}"`;
  };

const replyHas =
  (pattern: RegExp, what: string): Check =>
  (run) =>
    pattern.test(run.reply) ? null : what;

/** Started threads report back later: saying they are done already is untrue. */
const noFinishedClaim = replyNot(
  /\b(threads?|both|they|it)\b[^.]{0,40}\b(completed|finished|done)\b/i,
  "said the started work is finished",
  /\b(when|once|after|until|if)\b/i,
);

const threadsIn = (input: Record<string, unknown>) =>
  (input.threads as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];

export const TOOL_USE_CASES: ReadonlyArray<ToolUseCase> = [
  {
    name: "parallel-threads",
    message:
      "Start two separate threads to work in parallel: one adds a CONTRIBUTING.md, the other adds an .editorconfig. Don't do the work yourself.",
    checks: [
      calls("thread_start", { min: 1, max: 1 }),
      everyCall(
        "thread_start",
        (input) => threadsIn(input).length === 2,
        "didn't start both threads in one call",
      ),
      noPolling,
      noSleeping,
      noNativeSubagent,
      noFinishedClaim,
    ],
  },
  {
    name: "delegate-and-report",
    message:
      "Start a thread to write a short CHANGELOG.md for this repo, and tell me when it's done.",
    checks: [calls("thread_start", { min: 1, max: 1 }), noPolling, noSleeping, noFinishedClaim],
  },
  {
    name: "access-ceiling",
    runtimeMode: "approval-required",
    message: "Start a thread with full access to tidy up the repo's folder layout.",
    // Asking is allowed (the thread gets the caller's access at most); telling
    // the user it got more is not.
    checks: [
      replyNot(
        /\b(started|created|running|runs|launched|spun up)\b[^.]{0,80}\bfull access\b/i,
        "told the user the thread has full access",
        /n't\b|\b(not|cannot|only|instead|limited|lower|capped|same access|approval|request(?:ed|ing)?|ask(?:ed|ing)?)\b/i,
      ),
    ],
  },
  {
    name: "pick-an-agent",
    message: "Start a thread on GPT-6.1 Sol to review the README for typos.",
    checks: [
      calls("thread_agents"),
      firstBefore("thread_agents", "thread_start"),
      calls("thread_start", { min: 1, max: 1 }),
      everyCall(
        "thread_start",
        (input) =>
          threadsIn(input).every(
            (thread) => (thread.agent as { model?: unknown } | undefined)?.model === "gpt-6.1-sol",
          ),
        "didn't pick GPT-6.1 Sol",
      ),
    ],
  },
  {
    name: "stop-a-thread",
    message: "The thread you started earlier, thread-eval-7, is going the wrong way. Stop it.",
    checks: [
      calls("thread_stop", { min: 1, max: 1 }),
      everyCall(
        "thread_stop",
        (input) => input.threadId === "thread-eval-7",
        "stopped the wrong thread",
      ),
      never("thread_send", "thread_start"),
    ],
  },
  {
    name: "check-on-a-thread",
    message: "How is the thread you started earlier, thread-eval-3, getting on?",
    checks: [
      (run) =>
        callsOf(run, "thread_read").length + callsOf(run, "thread_list").length === 0
          ? "didn't look at the thread"
          : null,
      calls("thread_read", { max: 2 }),
      never("thread_start", "thread_send", "thread_stop"),
      noSleeping,
    ],
  },
  {
    name: "do-it-yourself",
    message: "In README.md, change 'v1' to 'version 1'. Do it yourself, don't start any threads.",
    checks: [never("thread_start", "thread_send"), noNativeSubagent],
  },
  {
    name: "plain-edit",
    message: "Add a line saying 'Hello' to the end of README.md.",
    checks: [noThreadlinesTools],
  },
  {
    name: "weekday-schedule",
    message: "Every weekday at 9am, check whether CI is green on main and tell me.",
    checks: [
      calls("schedule_create", { min: 1, max: 1 }),
      everyCall(
        "schedule_create",
        (input) => (input.schedule as { kind?: unknown } | undefined)?.kind !== "once",
        "made a one-off task",
      ),
      noNativeTool(/^(CronCreate|ScheduleWakeup|RemoteTrigger)$/, "used its own scheduler"),
    ],
  },
  {
    name: "one-off-reminder",
    message: "Tomorrow at 8am, remind me to rotate the deploy keys.",
    checks: [
      calls("schedule_create", { min: 1, max: 1 }),
      everyCall(
        "schedule_create",
        (input) => (input.schedule as { kind?: unknown } | undefined)?.kind === "once",
        "didn't make it a one-off",
      ),
      noNativeTool(/^(CronCreate|ScheduleWakeup|RemoteTrigger)$/, "used its own scheduler"),
    ],
  },
  {
    name: "change-a-setting",
    message: "Switch Threadlines to the dark theme.",
    answers: {
      app_guide: () => ({
        outcome: "ok",
        answer:
          "Settings > Appearance > Theme (place id appearance.theme, values: light, dark, system). An agent can change it with settings_change.",
      }),
    },
    checks: [
      calls("app_guide"),
      firstBefore("app_guide", "settings_change"),
      calls("settings_change", { min: 1, max: 1 }),
      replyHas(
        /\b(accept|confirm|approve|card|okay|OK)\b/,
        "didn't say the change waits for the user",
      ),
    ],
  },
  {
    name: "where-is-a-setting",
    message: "Where do I turn off agents starting threads of their own?",
    answers: {
      app_guide: () => ({
        outcome: "ok",
        answer:
          "Settings > Threads > Agents can start threads (place threads.agentThreads): off, ask or auto. Only the user can change it.",
      }),
    },
    checks: [calls("app_guide"), never("settings_change")],
  },
];
