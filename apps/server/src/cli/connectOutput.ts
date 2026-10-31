/**
 * What the `threadlines` command prints for each tool's result, and the exit
 * code it ends with (docs/design/outside-agents.md, "Exit codes"). Short
 * plain text: the status, then the newest reply when it waited. `--json`
 * prints the results as they came instead.
 */
import type {
  AgentsResult,
  OutsideThreadReadResult,
  OutsideThreadStartResult,
  OutsideThreadStopResult,
  OutsideThreadSummary,
  OutsideWaitingItem,
  OutsideWaitingOn,
  ProjectsResult,
  ThreadsListResult,
  ThreadWaitResult,
} from "../outsideAgents/connectTools.ts";
import { EXIT, type ExitCode } from "./connectExit.ts";

/** Every outcome a tool can answer that means Threadlines refused the call. */
const REFUSED_OUTCOMES: ReadonlySet<string> = new Set([
  "not_allowed",
  "not_found",
  "not_yours",
  "limit",
  "busy",
  "conflict",
  "unavailable_agent",
  "not_open",
  "invalid",
]);

/** The exit code for a call's outcome alone: worked, refused or failed. */
export function exitCodeForOutcome(outcome: string): ExitCode {
  if (outcome === "failed") return EXIT.failed;
  return REFUSED_OUTCOMES.has(outcome) ? EXIT.refused : EXIT.done;
}

/**
 * The exit code once a wait is over, from how the thread is now: it needs
 * the user, it failed or its newest turn was stopped or ended in an error, or
 * it's done.
 */
export function exitCodeForThread(thread: OutsideThreadSummary | undefined): ExitCode {
  if (thread === undefined) return EXIT.done;
  if (thread.status === "needs the user") return EXIT.needsUser;
  if (thread.status === "failed") return EXIT.failed;
  const ended = thread.lastTurn?.state;
  return ended === "interrupted" || ended === "error" ? EXIT.failed : EXIT.done;
}

/** Why a call was refused, in Threadlines' own words when it gave them. */
export function describeRefusal(result: {
  readonly outcome: string;
  readonly detail?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
}): string {
  // The server words `busy` for agents ("wait with thread_wait"); a person
  // at a shell gets the command to run instead.
  if (result.outcome !== "busy" && result.detail !== undefined && result.detail.trim().length > 0) {
    return result.detail;
  }
  switch (result.outcome) {
    case "not_allowed":
      return "Threadlines doesn't allow this command to do that. You can change what it may do in Threadlines > Settings > Connections > Agents.";
    case "not_found":
      return "Threadlines has no such thread or project that this command can see.";
    case "not_yours":
      return "This command can only send to or stop threads it started, unless you give it Work with all threads in Threadlines > Settings > Connections > Agents.";
    case "not_open":
      return "That question isn't open anymore. Read the thread to see what's waiting.";
    case "invalid":
      return "Those answers don't fit the question. Give one per question, in order.";
    case "limit":
      return result.retryAfterSeconds === undefined
        ? "Too many calls for now. Try again later."
        : `Too many calls for now. Try again in ${Math.ceil(result.retryAfterSeconds)} seconds.`;
    case "busy":
      return "The thread is working. Wait for it (threadlines thread wait), then send again.";
    case "conflict":
      return "That request id was already used for a different call.";
    case "unavailable_agent":
      return "That agent isn't ready in Threadlines. Run threadlines agents to see the ones that are.";
    case "failed":
      return "Threadlines couldn't do it.";
    default:
      return `Threadlines answered ${result.outcome}.`;
  }
}

/** Fixed-width columns, two spaces apart; the last column isn't padded. */
function columns(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatProjects(result: ProjectsResult): string {
  if (result.projects.length === 0) return "No projects this command can see.";
  return columns(
    result.projects.map((project) => [project.name, project.folder, project.projectId]),
  );
}

export function formatAgents(result: AgentsResult): string {
  const lines: string[] = [];
  for (const agent of result.agents) {
    lines.push(`${agent.name} (${agent.instanceId}), ${agent.billing}`);
    for (const model of agent.models) {
      const isDefault =
        result.default?.instanceId === agent.instanceId && result.default.model === model.model;
      lines.push(
        `  ${agent.instanceId}/${model.model}  ${model.name}${isDefault ? " (default)" : ""}`,
      );
    }
    if (agent.moreModels !== undefined && agent.moreModels > 0) {
      lines.push(`  and ${agent.moreModels} more`);
    }
  }
  for (const agent of result.unavailable) {
    lines.push(`${agent.name} (${agent.instanceId}) isn't ready: ${agent.reason}`);
  }
  return lines.length === 0 ? "No agents are ready in Threadlines." : lines.join("\n");
}

export function formatThreadList(result: ThreadsListResult): string {
  // Through the assistants door: threads still being set up, or whose setup failed.
  const starting = result.starting ?? [];
  if (result.threads.length === 0 && starting.length === 0) return "No threads.";
  return columns([
    ...starting.map((thread) => [thread.status, thread.project, thread.threadId, thread.title]),
    ...result.threads.map((thread) => [
      thread.status,
      thread.project,
      thread.threadId,
      thread.title,
    ]),
  ]);
}

const WAITING_ON_TEXT: Record<OutsideWaitingOn, string> = {
  approval: "It's waiting for an approval in Threadlines.",
  question: "It's waiting for an answer to a question in Threadlines.",
  plan: "It's waiting for its plan to be approved in Threadlines.",
};

/** One thing it waits on, on one line: Threadlines' words, then the agent's (clipped). */
const waitingLine = (item: OutsideWaitingItem) => {
  const said = item.detail ?? item.questions?.[0]?.question ?? item.title ?? null;
  return `  ${item.summary}${said === null ? "" : `: ${said.replace(/\s+/gu, " ")}`}`;
};

/** The thread's title and how it's doing, on one line, then what it waits on. */
function threadStatusLines(
  thread: OutsideThreadSummary,
  waitingOn: OutsideWaitingOn | undefined,
  waiting: ReadonlyArray<OutsideWaitingItem> = [],
): string[] {
  const ended = thread.lastTurn?.state;
  const how =
    thread.status === "idle" && ended === "interrupted"
      ? "stopped"
      : thread.status === "idle" && ended === "error"
        ? "idle, its last turn ended in an error"
        : thread.status;
  const lines = [`${thread.title} (${thread.threadId}): ${how}`];
  if (waitingOn !== undefined) {
    lines.push(WAITING_ON_TEXT[waitingOn], ...waiting.map(waitingLine));
  }
  return lines;
}

export function formatThreadRead(result: OutsideThreadReadResult): string {
  if (result.outcome === "starting") return result.detail ?? "It's still being set up.";
  const lines =
    result.thread === undefined
      ? []
      : threadStatusLines(result.thread, result.waitingOn, result.waiting);
  for (const message of result.messages) {
    lines.push("", `${message.author}:`, message.text);
  }
  if (result.more && result.next !== null) {
    lines.push("", `More messages follow. Read them with --after ${result.next}.`);
  }
  return lines.join("\n");
}

export function formatWait(result: ThreadWaitResult): string {
  if (result.thread === undefined) return result.detail ?? result.outcome;
  const lines = threadStatusLines(result.thread, result.waitingOn, result.waiting);
  if (result.outcome === "still_working") lines.push("It's still working.");
  if (result.reply !== undefined && result.reply !== null && result.reply.length > 0) {
    lines.push("", result.reply);
  }
  return lines.join("\n");
}

export function formatStart(result: OutsideThreadStartResult): string {
  const thread = result.thread;
  const setUp = result.outcome === "starting";
  if (thread === undefined) return setUp ? "Setting it up." : "Started.";
  const where = thread.workspace === "worktree" ? "its own worktree" : "the project folder";
  // Through the assistants door a start answers before its setup, and starts on its own after.
  return setUp
    ? `Setting up ${thread.title} (${thread.threadId}) in ${where}, on ${thread.model}, access ${thread.access}. It starts on its own once it's ready.`
    : `Started ${thread.title} (${thread.threadId}) in ${where}, on ${thread.model}, access ${thread.access}.`;
}

export function formatStop(result: OutsideThreadStopResult): string {
  return result.outcome === "not_running" ? "It wasn't running." : "Stopped.";
}
