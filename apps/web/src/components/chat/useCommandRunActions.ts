/**
 * What the chat's command buttons do (docs/terminal-command-runs.md): start a
 * run in a free terminal tab or a new one, send a run's output to its agent,
 * skip a request, and bring a run's tab forward. ChatView builds this once per
 * thread and provides it through CommandRunActionsContext.
 */
import {
  CommandRunId,
  MAX_TERMINAL_REUSE_IDS,
  type CommandDialect,
  type EnvironmentId,
  type OrchestrationCommandRun,
  type ThreadId,
  type ThreadParticipantId,
} from "@threadlines/contracts";
import { shortenHomePath } from "@threadlines/shared/path";
import { projectScriptRuntimeEnv } from "@threadlines/shared/projectScripts";
import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentDescriptor } from "~/environments/primary/context";
import { useSavedEnvironmentRuntimeStore } from "~/environments/runtime/catalog";
import { newCommandId, randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { CommandRunActions } from "./CommandRuns";

/** A new run's terminal starts at this size; the drawer fits it once it shows. */
const RUN_TERMINAL_COLS = 120;
const RUN_TERMINAL_ROWS = 30;
const EMPTY_RUNS: ReadonlyArray<OrchestrationCommandRun> = [];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function useCommandRunActions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly runs: ReadonlyArray<OrchestrationCommandRun> | undefined;
  /** Where the thread's terminals start: its checkout, or the project. */
  readonly cwd: string | null;
  readonly projectCwd: string | null;
  readonly worktreePath: string | null;
  /** Open terminal tabs, in the drawer's order. */
  readonly terminalIds: ReadonlyArray<string>;
  /** Opens the drawer on a tab and puts the keyboard in it. */
  readonly focusTerminal: (terminalId: string) => void;
  readonly agentLabel: (participantId: ThreadParticipantId | null) => string;
}): CommandRunActions {
  const {
    environmentId,
    threadId,
    cwd,
    projectCwd,
    worktreePath,
    terminalIds,
    focusTerminal,
    agentLabel,
  } = input;
  const runs = input.runs ?? EMPTY_RUNS;
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.descriptor ?? null),
  );
  const descriptor = primary !== null && primary.environmentId === environmentId ? primary : saved;
  const dialect: CommandDialect = descriptor?.platform.os === "windows" ? "powershell" : "posix";
  const supported =
    descriptor?.capabilities.commandRuns === true &&
    environmentId !== null &&
    threadId !== null &&
    cwd !== null;
  const followsInserts = descriptor?.capabilities.followsInsertedCommands === true;

  const startRun = useCallback<CommandRunActions["startRun"]>(
    ({ command, mode, source }) => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api?.commandRuns || threadId === null || cwd === null) return;
      const terminalId = `terminal-${randomUUID()}`;
      void api.commandRuns
        .start({
          threadId,
          runId: CommandRunId.make(randomUUID()),
          // The server takes the first free tab of these, or opens this new one.
          terminalId,
          reuseTerminalIds: terminalIds.slice(0, MAX_TERMINAL_REUSE_IDS),
          mode,
          dialect,
          command,
          source,
          cwd,
          ...(worktreePath !== null ? { worktreePath } : {}),
          // The same environment the drawer gives this tab, so opening it
          // later never restarts its shell.
          ...(projectCwd !== null
            ? { env: projectScriptRuntimeEnv({ project: { cwd: projectCwd }, worktreePath }) }
            : {}),
          cols: RUN_TERMINAL_COLS,
          rows: RUN_TERMINAL_ROWS,
        })
        .then(
          (started) => focusTerminal(started?.terminalId ?? terminalId),
          (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  mode === "run" ? "Could not run the command" : "Could not put the command in",
                description: errorText(error, "The terminal did not open."),
              }),
            );
          },
        );
    },
    [cwd, dialect, environmentId, focusTerminal, projectCwd, terminalIds, threadId, worktreePath],
  );

  const sendOutput = useCallback<CommandRunActions["sendOutput"]>(
    (runId) => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api?.commandRuns || threadId === null) return;
      void api.commandRuns.sendOutput({ threadId, runId }).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send the output",
            description: errorText(error, "The output did not go out."),
          }),
        );
      });
    },
    [environmentId, threadId],
  );

  const setRequestDismissed = useCallback<CommandRunActions["setRequestDismissed"]>(
    (requestId, dismissed) => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api || threadId === null) return;
      void api.orchestration
        .dispatchCommand({
          type: "thread.command-request.dismiss",
          commandId: newCommandId(),
          threadId,
          requestId,
          dismissed,
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: dismissed ? "Could not skip the command" : "Could not bring the command back",
              description: errorText(error, "Try again."),
            }),
          );
        });
    },
    [environmentId, threadId],
  );

  const terminalLabel = useCallback<CommandRunActions["terminalLabel"]>(
    (terminalId) => {
      const index = terminalIds.indexOf(terminalId);
      return index < 0 ? null : `Terminal ${index + 1}`;
    },
    [terminalIds],
  );

  return useMemo(
    () => ({
      supported,
      followsInserts,
      dialect,
      cwdLabel: cwd === null ? null : shortenHomePath(cwd),
      runs,
      startRun,
      sendOutput,
      setRequestDismissed,
      showTerminal: focusTerminal,
      terminalLabel,
      agentLabel,
    }),
    [
      agentLabel,
      cwd,
      dialect,
      focusTerminal,
      followsInserts,
      runs,
      sendOutput,
      setRequestDismissed,
      startRun,
      supported,
      terminalLabel,
    ],
  );
}
