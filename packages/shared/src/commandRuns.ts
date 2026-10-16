/**
 * A thread's suggested commands (docs/terminal-command-runs.md): the requests
 * agents made with `ask_user_to_run` and the runs the user started from a
 * request card or a code block. The server's read model, its SQL projection
 * and the web store all apply events through these, and the server and the
 * web share the wording of the message that hands output back to an agent.
 */
import type {
  CommandRequestPublication,
  CommandRunProgress,
  CommandRunStart,
  CommandRunStatus,
  MessageId,
  OrchestrationCommandRequest,
  OrchestrationCommandRun,
} from "@threadlines/contracts";

/** Requests and runs a thread keeps, oldest dropped first. */
export const MAX_THREAD_COMMAND_REQUESTS = 200;
export const MAX_THREAD_COMMAND_RUNS = 200;

/** Statuses a run never leaves. */
const FINAL_RUN_STATUSES: ReadonlySet<CommandRunStatus> = new Set([
  "submitted",
  "finished",
  "cancelled",
  "interrupted",
  "failed",
]);

export function isCommandRunSettled(status: CommandRunStatus): boolean {
  return FINAL_RUN_STATUSES.has(status);
}

/** Output still due to go to its agent by itself. */
export function commandRunAwaitsAutoSend(
  run: Pick<OrchestrationCommandRun, "autoSend" | "outputSentAt">,
): boolean {
  return run.autoSend && run.outputSentAt === null;
}

export function applyCommandRequested(
  requests: ReadonlyArray<OrchestrationCommandRequest>,
  request: CommandRequestPublication,
  event: { readonly sequence: number; readonly occurredAt: string },
): ReadonlyArray<OrchestrationCommandRequest> {
  if (requests.some((entry) => entry.requestId === request.requestId)) return requests;
  return [
    ...requests,
    {
      ...request,
      dismissedAt: null,
      eventSequence: event.sequence,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    },
  ].slice(-MAX_THREAD_COMMAND_REQUESTS);
}

export function applyCommandRequestDismissed(
  requests: ReadonlyArray<OrchestrationCommandRequest>,
  change: { readonly requestId: string; readonly dismissed: boolean },
  occurredAt: string,
): ReadonlyArray<OrchestrationCommandRequest> {
  return requests.map((request) =>
    request.requestId === change.requestId
      ? { ...request, dismissedAt: change.dismissed ? occurredAt : null, updatedAt: occurredAt }
      : request,
  );
}

export function applyCommandRunStarted(
  runs: ReadonlyArray<OrchestrationCommandRun>,
  start: CommandRunStart,
  event: { readonly sequence: number; readonly occurredAt: string },
): ReadonlyArray<OrchestrationCommandRun> {
  const { occurredAt } = event;
  if (runs.some((run) => run.runId === start.runId)) return runs;
  return [
    ...runs,
    {
      ...start,
      status: "starting" as const,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      hasOutput: false,
      heldReason: null,
      outputSentAt: null,
      outputMessageId: null,
      eventSequence: event.sequence,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  ].slice(-MAX_THREAD_COMMAND_RUNS);
}

export function applyCommandRunProgress(
  runs: ReadonlyArray<OrchestrationCommandRun>,
  progress: CommandRunProgress,
  occurredAt: string,
): ReadonlyArray<OrchestrationCommandRun> {
  return runs.map((run) =>
    run.runId === progress.runId
      ? {
          ...run,
          ...(progress.status !== undefined ? { status: progress.status } : {}),
          ...(progress.startedAt !== undefined ? { startedAt: progress.startedAt } : {}),
          ...(progress.finishedAt !== undefined ? { finishedAt: progress.finishedAt } : {}),
          ...(progress.exitCode !== undefined ? { exitCode: progress.exitCode } : {}),
          ...(progress.error !== undefined ? { error: progress.error } : {}),
          ...(progress.hasOutput !== undefined ? { hasOutput: progress.hasOutput } : {}),
          ...(progress.autoSend !== undefined ? { autoSend: progress.autoSend } : {}),
          ...(progress.heldReason !== undefined ? { heldReason: progress.heldReason } : {}),
          ...(progress.outputSentAt !== undefined ? { outputSentAt: progress.outputSentAt } : {}),
          ...(progress.outputMessageId !== undefined
            ? { outputMessageId: progress.outputMessageId }
            : {}),
          updatedAt: occurredAt,
        }
      : run,
  );
}

// ---------------------------------------------------------------------------
// The message that hands a run's output to its agent.

const COMMAND_OUTPUT_MESSAGE_PREFIX = "command-output:";

/** The message id of a run's output: fixed for the automatic send, unique per manual one. */
export function commandOutputMessageId(runId: string, sendKey?: string): MessageId {
  return `${COMMAND_OUTPUT_MESSAGE_PREFIX}${runId}${sendKey === undefined ? "" : `:${sendKey}`}` as MessageId;
}

/** The run a command-output message carries, or null for any other message. */
export function commandRunIdOfOutputMessage(messageId: string): string | null {
  if (!messageId.startsWith(COMMAND_OUTPUT_MESSAGE_PREFIX)) return null;
  const rest = messageId.slice(COMMAND_OUTPUT_MESSAGE_PREFIX.length);
  const runId = rest.split(":")[0] ?? "";
  return runId.length > 0 ? runId : null;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** How long a run took, e.g. "14s" or "2m 5s"; null until it has both ends. */
export function commandRunDuration(
  run: Pick<OrchestrationCommandRun, "startedAt" | "finishedAt">,
): string | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  const elapsed = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(elapsed) ? formatDuration(elapsed) : null;
}

/** A fence that no run of backticks in the text can close early. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

/**
 * The user's message carrying a run's output, written for the agent: what
 * ran, where, how it ended, then the output itself in a fence.
 */
export function buildCommandOutputMessage(input: {
  readonly run: Pick<
    OrchestrationCommandRun,
    "command" | "cwd" | "mode" | "status" | "exitCode" | "startedAt" | "finishedAt"
  >;
  readonly output: string;
}): string {
  const { run } = input;
  const duration = commandRunDuration(run);
  const ending =
    run.mode === "insert"
      ? "I may have changed it before pressing Enter. This is what the terminal shows since it went in:"
      : run.status === "finished"
        ? `It finished${duration ? ` after ${duration}` : ""}${
            run.exitCode === null ? "" : ` with exit code ${run.exitCode}`
          }. Output:`
        : run.status === "interrupted"
          ? "It stopped before finishing (the terminal was closed or the command was interrupted). Output so far:"
          : "It is still running. Output so far:";
  const lead =
    run.mode === "insert"
      ? `I put this command in my terminal (in ${run.cwd}):`
      : `I ran this command in my terminal (in ${run.cwd}):`;
  const output = input.output.trim().length > 0 ? input.output : "(no output)";
  const fence = fenceFor(output);
  return [
    lead,
    "",
    `${fenceFor(run.command)}sh`,
    run.command,
    fenceFor(run.command),
    "",
    ending,
    "",
    `${fence}text`,
    output,
    fence,
  ].join("\n");
}
