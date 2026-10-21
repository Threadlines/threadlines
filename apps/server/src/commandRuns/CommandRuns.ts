/**
 * Suggested commands (docs/terminal-command-runs.md): an agent asks the user
 * to run a command (`ask_user_to_run`), or the user clicks Run on a shell code
 * block in a reply. This service records the request, starts each run in a
 * free terminal tab or a new one, follows the tab's run updates into the
 * thread, and hands a run's output to the agent it was for: by itself when a
 * request's Run finishes, or when the user asks.
 *
 * The terminal does the running; orchestration keeps the record and decides
 * every send, so Stop, reverts, skips and rooms are respected in one place.
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  CommandRequestId,
  CommandRunError,
  type CommandDialect,
  type CommandRunProgress,
  type CommandRunSendOutputInput,
  type CommandRunSendOutputResult,
  type CommandRunStartInput,
  type CommandRunStartResult,
  type OrchestrationCommandRun,
  type OrchestrationThread,
  type ThreadId,
} from "@threadlines/contracts";
import {
  buildCommandOutputMessage,
  commandOutputMessageId,
  commandRunAwaitsAutoSend,
  isCommandRunSettled,
} from "@threadlines/shared/commandRuns";
import {
  assessShellCommand,
  MAX_SHELL_COMMAND_LENGTH,
  MAX_SHELL_COMMAND_LINES,
  shellCommandsInMarkdown,
} from "@threadlines/shared/shellCommandSafety";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { latchCallerTurn } from "../mcp/callerTurn.ts";
import type { McpInvocationScope } from "../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadCommandRepository } from "../persistence/Services/ProjectionThreadCommands.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager, type TerminalCommandRunUpdate } from "../terminal/Services/Manager.ts";

/** What `ask_user_to_run` hands back to the agent. */
export interface CommandRequestOutcome {
  readonly outcome: "shown" | "refused" | "not_allowed" | "off";
  readonly detail: string;
}

export interface CommandRunsShape {
  /** `ask_user_to_run`: show a command card in the caller's running turn. */
  readonly request: (
    scope: McpInvocationScope,
    input: { readonly command: string; readonly reason: string },
  ) => Effect.Effect<CommandRequestOutcome>;
  /**
   * A chat button: record the run and start it in a free terminal tab or a
   * new one. Says which tab when the start named tabs to reuse.
   */
  readonly start: (
    input: CommandRunStartInput,
  ) => Effect.Effect<CommandRunStartResult | undefined, CommandRunError>;
  /** "Send output": the run's output, as the user's message to its agent. */
  readonly sendOutput: (
    input: CommandRunSendOutputInput,
  ) => Effect.Effect<CommandRunSendOutputResult, CommandRunError>;
}

export class CommandRuns extends Context.Service<CommandRuns, CommandRunsShape>()(
  "threadlines/commandRuns/CommandRuns",
) {}

const MAX_REASON_LENGTH = 300;
const OFF_DETAIL =
  "Command requests are turned off in this Threadlines. Tell the user the command in your reply instead, and don't try again.";
const SIDE_DETAIL = "A side answer cannot ask the user to run commands.";
const GONE_DETAIL = "This thread is gone.";
const NOT_YOUR_TURN_DETAIL =
  "A command request shows in the turn that made it, and you are not working on a turn of this thread right now. Ask during your next turn.";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const failWith = (message: string) => new CommandRunError({ message });

/** The shell family this server's terminal speaks. */
export function serverCommandDialect(platform: NodeJS.Platform = process.platform): CommandDialect {
  return platform === "win32" ? "powershell" : "posix";
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const commandRows = yield* ProjectionThreadCommandRepository;
  const terminals = yield* TerminalManager;
  const settings = yield* ServerSettingsService;

  /** The thread each run of this process belongs to; run updates carry only the run id. */
  const runThreads = new Map<string, ThreadId>();

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed((): OrchestrationThread | undefined => undefined),
    );

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.enableCommandRequests),
    Effect.orElseSucceed(() => false),
  );

  const request: CommandRunsShape["request"] = (scope, input) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return { outcome: "off" as const, detail: OFF_DETAIL };
      if (scope.side !== undefined) return { outcome: "not_allowed" as const, detail: SIDE_DETAIL };
      const command = input.command.replace(/\r\n?/g, "\n").trim();
      const reason = input.reason.trim();
      if (command.length === 0) {
        return { outcome: "refused" as const, detail: "Give the command to run." };
      }
      if (reason.length === 0) {
        return {
          outcome: "refused" as const,
          detail: "Say in one short sentence why the user needs to run it.",
        };
      }
      if (reason.length > MAX_REASON_LENGTH) {
        return {
          outcome: "refused" as const,
          detail: `Keep the reason under ${MAX_REASON_LENGTH} characters.`,
        };
      }
      if (
        command.length > MAX_SHELL_COMMAND_LENGTH ||
        command.split("\n").length > MAX_SHELL_COMMAND_LINES
      ) {
        return {
          outcome: "refused" as const,
          detail: `Keep the command under ${MAX_SHELL_COMMAND_LENGTH} characters and ${MAX_SHELL_COMMAND_LINES} lines; put longer scripts in a file and ask to run that.`,
        };
      }
      const dialect = serverCommandDialect();
      const assessment = assessShellCommand(command, dialect);
      if (assessment.blocked !== null) {
        return {
          outcome: "refused" as const,
          detail: `${assessment.blocked.label} Write it with plain characters.`,
        };
      }

      const latched = yield* latchCallerTurn(readThread, scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: GONE_DETAIL };
      if ("notYours" in latched) {
        return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN_DETAIL };
      }

      const requestId = CommandRequestId.make(randomUUID());
      const dispatched = yield* engine
        .dispatch({
          type: "thread.command-request.create",
          commandId: CommandId.make(`command-request:${requestId}`),
          threadId: scope.threadId,
          request: {
            requestId,
            turnId: latched.turnId,
            participantId: scope.participantId,
            command,
            reason,
            dialect,
          },
          createdAt: yield* nowIso,
        })
        .pipe(Effect.result);
      if (dispatched._tag === "Failure") {
        return {
          outcome: "refused" as const,
          detail:
            "The turn ended before the request could be shown. Ask again in your next turn if you still need it.",
        };
      }
      const oneClick = assessment.action === "run";
      return {
        outcome: "shown" as const,
        detail: oneClick
          ? "Shown to the user as a card with Run, Put in terminal and Skip. Nothing runs until they choose. If they click Run, the output comes back to you as a message when the command finishes. If you can't go on without it, say in a sentence what you're waiting for and end your turn."
          : `Shown to the user as a card. It can't run with one click (${assessment.cautions
              .map((caution) => caution.label.replace(/\.$/, "").toLowerCase())
              .join(
                "; ",
              )}), so the user puts it in the terminal, checks it and presses Enter, then sends you the output when they're done. If you can't go on without it, say in a sentence what you're waiting for and end your turn.`,
      };
    });

  const dispatchProgress = (
    threadId: ThreadId,
    progress: CommandRunProgress,
    key: string,
    output?: string,
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.command-run.update",
        commandId: CommandId.make(`command-run:${progress.runId}:${key}`),
        threadId,
        progress,
        ...(output !== undefined ? { output } : {}),
        createdAt: yield* nowIso,
      });
    });

  /**
   * Sends a run's output to its agent. `knownOutput` is the output in hand
   * when a run just ended; otherwise it is read from the record (a run that
   * ended) or the open terminal (a run still going, or an insert).
   */
  const deliver = (
    threadId: ThreadId,
    runId: string,
    automatic: boolean,
    knownOutput?: string,
  ): Effect.Effect<CommandRunSendOutputResult, CommandRunError> =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      const run = thread?.commandRuns?.find((entry) => entry.runId === runId);
      if (thread === undefined || run === undefined) {
        return yield* failWith("That command is no longer part of this thread.");
      }
      let output: string | null = knownOutput ?? null;
      if (output === null && run.hasOutput) {
        output = yield* commandRows
          .getRunOutput({ threadId, runId })
          .pipe(Effect.orElseSucceed(() => null));
      }
      if (output === null) {
        output = yield* terminals.readCommandRunOutput(runId);
      }
      if (output === null) {
        return yield* failWith("Its terminal is closed, so the output is gone.");
      }
      const sendKey = automatic ? undefined : randomUUID().slice(0, 8);
      const messageId = commandOutputMessageId(runId, sendKey);
      yield* engine
        .dispatch({
          type: "thread.command-run.deliver-output",
          commandId: CommandId.make(messageId),
          threadId,
          runId: run.runId,
          automatic,
          message: { messageId, text: buildCommandOutputMessage({ run, output }) },
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((error) => failWith(error.message)));
      return { messageId };
    });

  /** An automatic send the thread refused stays visible as held, so it can be sent by hand. */
  const deliverAutomatically = (threadId: ThreadId, runId: string, knownOutput?: string) =>
    deliver(threadId, runId, true, knownOutput).pipe(
      Effect.catch((error) =>
        /left the room/.test(error.message)
          ? dispatchProgress(
              threadId,
              {
                runId: runId as OrchestrationCommandRun["runId"],
                autoSend: false,
                heldReason: "agent-left",
              },
              "held",
            ).pipe(Effect.ignore)
          : Effect.logWarning("command output was not sent", {
              threadId,
              runId,
              error: error.message,
            }),
      ),
      Effect.asVoid,
    );

  const onRunUpdate = (update: TerminalCommandRunUpdate) =>
    Effect.gen(function* () {
      // Runs of this process only; an update after its run ended (a late
      // "running") finds nothing here and changes nothing.
      const threadId = runThreads.get(update.runId);
      if (threadId === undefined) return;
      const runId = update.runId as OrchestrationCommandRun["runId"];
      switch (update.type) {
        case "running":
        case "waiting":
          yield* dispatchProgress(
            threadId,
            { runId, status: update.type, startedAt: update.at },
            update.type,
          );
          return;
        case "submitted":
          yield* dispatchProgress(threadId, { runId, status: "submitted" }, "submitted");
          return;
        case "cancelled":
          runThreads.delete(update.runId);
          yield* dispatchProgress(
            threadId,
            { runId, status: "cancelled", finishedAt: update.at },
            "cancelled",
          );
          return;
        case "failed":
          runThreads.delete(update.runId);
          yield* dispatchProgress(
            threadId,
            { runId, status: "failed", finishedAt: update.at, error: update.error },
            "failed",
          );
          return;
        case "interrupted":
          runThreads.delete(update.runId);
          yield* dispatchProgress(
            threadId,
            {
              runId,
              status: "interrupted",
              ...(update.startedAt !== null ? { startedAt: update.startedAt } : {}),
              finishedAt: update.at,
              hasOutput: update.output !== null,
            },
            "ended",
            update.output ?? undefined,
          );
          return;
        case "finished": {
          runThreads.delete(update.runId);
          yield* dispatchProgress(
            threadId,
            {
              runId,
              status: "finished",
              // Also here: a quick command can end before its "running" update.
              ...(update.startedAt !== null ? { startedAt: update.startedAt } : {}),
              finishedAt: update.at,
              exitCode: update.exitCode,
              hasOutput: true,
            },
            "ended",
            update.output,
          );
          const thread = yield* readThread(threadId);
          const run = thread?.commandRuns?.find((entry) => entry.runId === runId);
          if (run !== undefined && commandRunAwaitsAutoSend(run)) {
            yield* deliverAutomatically(threadId, runId, update.output);
          }
          return;
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("command run update was not recorded", { runId: update.runId, cause }),
      ),
    );

  const start: CommandRunsShape["start"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* readThread(input.threadId);
      if (thread === undefined || thread.deletedAt !== null) {
        return yield* failWith("This thread is gone.");
      }
      const assessment = assessShellCommand(input.command, input.dialect);
      if (assessment.blocked !== null) return yield* failWith(assessment.blocked.label);
      if (input.mode === "run" && assessment.action !== "run") {
        return yield* failWith(
          "This command needs a last look, so it can only go into the terminal for you to press Enter.",
        );
      }

      // The run takes its turn and agent from its card or reply, and only
      // ever runs what that card or reply shows.
      let origin: {
        turnId: OrchestrationCommandRun["turnId"];
        participantId: OrchestrationCommandRun["participantId"];
      };
      if (input.source.kind === "request") {
        const requestId = input.source.requestId;
        const found = (thread.commandRequests ?? []).find((entry) => entry.requestId === requestId);
        if (found === undefined || found.dismissedAt !== null) {
          return yield* failWith("That request is no longer open.");
        }
        if (found.command !== input.command) {
          return yield* failWith("The command doesn't match the request.");
        }
        origin = { turnId: found.turnId, participantId: found.participantId };
      } else {
        const messageId = input.source.messageId;
        const message = thread.messages.findLast((entry) => entry.id === messageId);
        if (message === undefined || message.role !== "assistant" || message.turnId == null) {
          return yield* failWith("That reply is no longer part of this thread.");
        }
        const shown = shellCommandsInMarkdown(message.text, input.dialect).some(
          (block) => block.text === input.command,
        );
        if (!shown) return yield* failWith("The command doesn't match the reply.");
        origin = { turnId: message.turnId, participantId: message.participantId ?? null };
      }

      // The terminal picks the tab (a free one, or a new one) and records the
      // run there before anything in it changes, so its updates find it.
      let recorded = false;
      const started = yield* terminals
        .startCommandRun(
          {
            threadId: input.threadId,
            terminalId: input.terminalId,
            ...(input.reuseTerminalIds !== undefined
              ? { reuseTerminalIds: input.reuseTerminalIds }
              : {}),
            runId: input.runId,
            mode: input.mode,
            dialect: input.dialect,
            command: input.command,
            cwd: input.cwd,
            ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.cols !== undefined ? { cols: input.cols } : {}),
            ...(input.rows !== undefined ? { rows: input.rows } : {}),
          },
          (terminalId) =>
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.command-run.start",
                  commandId: CommandId.make(`command-run-start:${input.runId}`),
                  threadId: input.threadId,
                  run: {
                    runId: input.runId,
                    terminalId,
                    mode: input.mode,
                    dialect: input.dialect,
                    command: input.command,
                    source: input.source,
                    turnId: origin.turnId,
                    participantId: origin.participantId,
                    cwd: input.cwd,
                    autoSend: input.source.kind === "request" && input.mode === "run",
                  },
                  createdAt: yield* nowIso,
                })
                .pipe(Effect.mapError((error) => failWith(error.message)));
              recorded = true;
              runThreads.set(input.runId, input.threadId);
            }),
        )
        .pipe(Effect.result);
      if (started._tag === "Success") {
        return input.reuseTerminalIds !== undefined ? { terminalId: started.success } : undefined;
      }
      const message = started.failure.message;
      if (!recorded) return yield* failWith(message);
      runThreads.delete(input.runId);
      yield* dispatchProgress(
        input.threadId,
        { runId: input.runId, status: "failed", finishedAt: yield* nowIso, error: message },
        "failed",
      ).pipe(Effect.ignore);
      return yield* failWith(message);
    });

  const sendOutput: CommandRunsShape["sendOutput"] = (input) =>
    deliver(input.threadId, input.runId, false);

  yield* Effect.acquireRelease(terminals.subscribeCommandRuns(onRunUpdate), (unsubscribe) =>
    Effect.sync(unsubscribe),
  );

  // A restart ends every terminal: runs it cut off are marked so, and output
  // that finished but never went to its agent goes now (the send is keyed by
  // the run, so one already made is not made twice).
  yield* Effect.gen(function* () {
    const stored = yield* commandRows.listAllRuns();
    for (const { threadId, run } of stored) {
      if (!isCommandRunSettled(run.status)) {
        yield* dispatchProgress(
          threadId,
          { runId: run.runId, status: "interrupted", finishedAt: yield* nowIso },
          "ended",
        ).pipe(Effect.ignore);
      } else if (run.status === "finished" && commandRunAwaitsAutoSend(run)) {
        yield* deliverAutomatically(threadId, run.runId);
      }
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("command run recovery failed", { cause })),
    Effect.forkScoped,
  );

  return { request, start, sendOutput } satisfies CommandRunsShape;
});

export const layer = Layer.effect(CommandRuns, make);
