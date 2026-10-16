/**
 * Suggested commands in the chat (docs/terminal-command-runs.md): the Run
 * button on a shell code block in an agent's reply, the card an agent shows
 * with `ask_user_to_run`, how each run is going, and the compact row for the
 * message that hands a run's output back to its agent.
 *
 * ChatView provides the actions (CommandRunActionsContext); an assistant
 * message provides the block's scope (CodeBlockRunScopeContext). Without
 * either, code blocks render as before.
 */
import {
  type CommandDialect,
  type CommandRequestId,
  type CommandRunId,
  type CommandRunMode,
  type CommandRunSource,
  type MessageId,
  type OrchestrationCommandRequest,
  type OrchestrationCommandRun,
  type ThreadParticipantId,
} from "@threadlines/contracts";
import { commandRunDuration, commandRunIdOfOutputMessage } from "@threadlines/shared/commandRuns";
import {
  assessShellCommand,
  prepareShellCommand,
  type ShellCommandAssessment,
} from "@threadlines/shared/shellCommandSafety";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { createContext, memo, use, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What the chat can do with a suggested command; provided by ChatView. */
export interface CommandRunActions {
  /** The thread's server runs commands and the thread has a folder to run them in. */
  readonly supported: boolean;
  /** The shell family the server's terminal speaks. */
  readonly dialect: CommandDialect;
  /** The folder runs start in, shortened for display (e.g. `~/badcode`). */
  readonly cwdLabel: string | null;
  readonly runs: ReadonlyArray<OrchestrationCommandRun>;
  readonly startRun: (input: {
    readonly command: string;
    readonly mode: CommandRunMode;
    readonly source: CommandRunSource;
  }) => void;
  readonly sendOutput: (runId: CommandRunId) => void;
  readonly setRequestDismissed: (requestId: CommandRequestId, dismissed: boolean) => void;
  readonly showTerminal: (terminalId: string) => void;
  /** "Terminal 2" while the tab is open; null once it is closed. */
  readonly terminalLabel: (terminalId: string) => string | null;
  /** What the chat calls the agent: "Codex", or a room agent's name. */
  readonly agentLabel: (participantId: ThreadParticipantId | null) => string;
}

export const CommandRunActionsContext = createContext<CommandRunActions | null>(null);

/** The agent reply a code block sits in; only settled replies run commands. */
export interface CodeBlockRunScope {
  readonly messageId: MessageId;
  readonly participantId: ThreadParticipantId | null;
}

export const CodeBlockRunScopeContext = createContext<CodeBlockRunScope | null>(null);

function latestRun(
  runs: ReadonlyArray<OrchestrationCommandRun>,
  matches: (run: OrchestrationCommandRun) => boolean,
): OrchestrationCommandRun | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (matches(run)) return run;
  }
  return null;
}

function isRunActive(run: OrchestrationCommandRun | null): boolean {
  return (
    run !== null &&
    (run.status === "starting" || run.status === "running" || run.status === "waiting")
  );
}

const linkButtonClass =
  "h-auto px-0 py-0 text-[12.5px] font-medium text-foreground hover:bg-transparent hover:text-foreground/80";

function Separator() {
  return <span className="text-border">|</span>;
}

/** How the latest run of a command is going, with what the user can do next. */
const CommandRunStatusLine = memo(function CommandRunStatusLine(props: {
  readonly run: OrchestrationCommandRun;
  readonly actions: CommandRunActions;
}) {
  const { run, actions } = props;
  const terminal = actions.terminalLabel(run.terminalId);
  const agent = actions.agentLabel(run.participantId);
  const duration = commandRunDuration(run);
  const where = terminal ?? "its terminal";

  let dot: "running" | "success" | "failure" | null = null;
  let text: string;
  switch (run.status) {
    case "starting":
      dot = "running";
      text = "Opening a terminal";
      break;
    case "running":
      dot = "running";
      text = `Running in ${where}`;
      break;
    case "waiting":
      text = `In ${where}. Press Enter there to run it.`;
      break;
    case "submitted":
      text = `Ran in ${where}`;
      break;
    case "finished":
      dot = run.exitCode === null || run.exitCode === 0 ? "success" : "failure";
      text =
        run.exitCode === null || run.exitCode === 0
          ? `Finished in ${where}`
          : run.exitCode === 130
            ? `Stopped in ${where}`
            : `Exited with code ${run.exitCode} in ${where}`;
      if (duration !== null) text += ` · ${duration}`;
      break;
    case "cancelled":
      text = `Cleared from ${where} without running`;
      break;
    case "interrupted":
      text = "Stopped before it finished";
      break;
    case "failed":
      dot = "failure";
      text = `Couldn't start: ${run.error ?? "the terminal did not open"}`;
      break;
  }

  const sent = run.outputSentAt !== null;
  const canSend =
    !sent &&
    run.heldReason !== "agent-left" &&
    (run.status === "running" ||
      run.status === "waiting" ||
      run.status === "submitted" ||
      ((run.status === "finished" || run.status === "interrupted") && run.hasOutput));
  const autoSendPending = run.autoSend && !sent && run.status !== "finished";
  const held =
    run.heldReason === "stopped"
      ? `You pressed Stop, so it wasn't sent to ${agent}.`
      : run.heldReason === "agent-left"
        ? `${agent} left the room, so it wasn't sent.`
        : null;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted-foreground"
      data-command-run-status={run.status}
    >
      {dot !== null ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            dot === "running" && "bg-primary-graph",
            dot === "success" && "bg-success",
            dot === "failure" && "bg-destructive",
          )}
        />
      ) : null}
      <span className="min-w-0">{text}</span>
      {sent ? <span>· Sent to {agent}</span> : null}
      {held !== null && !sent ? <span>· {held}</span> : null}
      {autoSendPending && run.status === "running" ? (
        <span>· {agent} gets the output when it finishes</span>
      ) : null}
      {canSend && !(autoSendPending && run.status === "running") ? (
        <>
          <Separator />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={linkButtonClass}
            onClick={() => actions.sendOutput(run.runId)}
          >
            {run.status === "running" ? "Send output so far" : `Send output to ${agent}`}
          </Button>
        </>
      ) : null}
      {terminal !== null && run.status !== "failed" ? (
        <>
          <Separator />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={linkButtonClass}
            onClick={() => actions.showTerminal(run.terminalId)}
          >
            Show terminal
          </Button>
        </>
      ) : null}
    </div>
  );
});

/** Whether CautionLine has anything to say for this command. */
function hasCaution(assessment: ShellCommandAssessment): boolean {
  if (assessment.blocked !== null) return true;
  const caution = assessment.cautions[0];
  return (
    assessment.action === "insert" &&
    caution !== undefined &&
    (caution.tone === "warning" || caution.kind === "placeholder")
  );
}

/** Why a command waits for the user's Enter, when that is worth saying. */
function CautionLine(props: { readonly assessment: ShellCommandAssessment }) {
  const { assessment } = props;
  if (assessment.blocked !== null) {
    return (
      <p className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>{assessment.blocked.label}</span>
      </p>
    );
  }
  const caution = assessment.cautions[0];
  if (caution === undefined || assessment.action === "run") return null;
  if (caution.tone === "warning") {
    return (
      <p className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          <span className="font-medium text-foreground">{caution.label}</span> It goes into the
          terminal without pressing Enter, so you get the last look.
        </span>
      </p>
    );
  }
  if (caution.kind === "placeholder") {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        {caution.label.replace(/\.$/, "")}, then press Enter in the terminal.
      </p>
    );
  }
  return null;
}

/** Why the button puts the command in rather than running it. */
function insertReason(assessment: ShellCommandAssessment): string | undefined {
  const caution = assessment.cautions[0];
  if (assessment.action === "run" || caution === undefined) return undefined;
  return caution.kind === "multi-line"
    ? "More than one line, so it waits for you to press Enter."
    : `${caution.label} It waits for you to press Enter.`;
}

/**
 * A shell code block in a settled agent reply: what its button would send,
 * and the latest run of it. Null when the block is not a command this chat
 * can run (not a shell fence, the other shell's dialect, a session transcript).
 */
function useCodeBlockCommand(code: string, language: string | undefined) {
  const actions = use(CommandRunActionsContext);
  const scope = use(CodeBlockRunScopeContext);
  const prepared = useMemo(() => prepareShellCommand(code, language), [code, language]);
  if (
    actions === null ||
    !actions.supported ||
    scope === null ||
    prepared === null ||
    prepared.dialect !== actions.dialect
  ) {
    return null;
  }
  const run = latestRun(
    actions.runs,
    (entry) =>
      entry.source.kind === "message" &&
      entry.source.messageId === scope.messageId &&
      entry.command === prepared.text,
  );
  return { actions, scope, prepared, run };
}

/** The Run (or Put in terminal) button beside a code block's copy button. */
export const CodeBlockRunButton = memo(function CodeBlockRunButton(props: {
  readonly code: string;
  readonly language: string | undefined;
}) {
  const command = useCodeBlockCommand(props.code, props.language);
  if (command === null || command.prepared.blocked !== null) return null;
  const { actions, scope, prepared, run } = command;
  const mode: CommandRunMode = prepared.action;
  const busy = isRunActive(run);
  const label =
    mode === "run"
      ? run === null
        ? "Run in terminal"
        : "Run again"
      : run === null
        ? "Put in terminal"
        : "Put in again";
  const reason = insertReason(prepared);
  const buttonProps = {
    type: "button" as const,
    variant: "ghost" as const,
    size: "xs" as const,
    disabled: busy,
    className: "chat-markdown-run-button",
    "data-command-run-mode": mode,
    onClick: () =>
      actions.startRun({
        command: prepared.text,
        mode,
        source: { kind: "message", messageId: scope.messageId },
      }),
  };
  const content = (
    <>
      {mode === "run" ? <PlayIcon aria-hidden /> : <TerminalIcon aria-hidden />}
      {label}
    </>
  );
  if (reason === undefined) return <Button {...buttonProps}>{content}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup>
        <p>{reason}</p>
      </TooltipPopup>
    </Tooltip>
  );
});

/** Under a code block: why it waits for Enter, and how its latest run went. */
export const CodeBlockRunNotes = memo(function CodeBlockRunNotes(props: {
  readonly code: string;
  readonly language: string | undefined;
}) {
  const command = useCodeBlockCommand(props.code, props.language);
  if (command === null) return null;
  const { actions, prepared, run } = command;
  const caution = hasCaution(prepared);
  if (run === null && !caution) return null;
  return (
    <div className="chat-markdown-run-notes mt-1 flex flex-col gap-0.5 px-0.5">
      {caution ? <CautionLine assessment={prepared} /> : null}
      {run !== null ? <CommandRunStatusLine run={run} actions={actions} /> : null}
    </div>
  );
});

/** The card an agent shows with `ask_user_to_run`. */
export const CommandRequestRow = memo(function CommandRequestRow(props: {
  readonly request: OrchestrationCommandRequest;
}) {
  const { request } = props;
  const actions = use(CommandRunActionsContext);
  const assessment = useMemo(
    () => assessShellCommand(request.command, request.dialect),
    [request.command, request.dialect],
  );
  if (actions === null) return null;
  const agent = actions.agentLabel(request.participantId);
  const run = latestRun(
    actions.runs,
    (entry) => entry.source.kind === "request" && entry.source.requestId === request.requestId,
  );
  const runnable =
    actions.supported && request.dialect === actions.dialect && assessment.blocked === null;
  const start = (mode: CommandRunMode) =>
    actions.startRun({
      command: request.command,
      mode,
      source: { kind: "request", requestId: request.requestId },
    });

  if (request.dismissedAt !== null) {
    return (
      <div
        className="flex min-w-0 items-center gap-2 px-1 text-[12.5px] text-muted-foreground"
        data-command-request-id={request.requestId}
        data-command-request-state="skipped"
      >
        <TerminalIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          Skipped <code className="font-mono text-[12px]">{request.command.split("\n")[0]}</code>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={linkButtonClass}
          onClick={() => actions.setRequestDismissed(request.requestId, false)}
        >
          Undo
        </Button>
      </div>
    );
  }

  const oneClick = assessment.action === "run";
  const showButtons = runnable && !isRunActive(run) && (run === null || run.status === "failed");
  return (
    <div
      className="surface-group flex flex-col gap-2 px-3.5 py-3"
      data-command-request-id={request.requestId}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium text-foreground">
        <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{agent} needs you to run a command</span>
      </div>
      <p className="text-[12.5px] text-muted-foreground">{request.reason}</p>
      <pre className="overflow-x-auto rounded-md bg-background/60 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-foreground">
        {request.command}
      </pre>
      {actions.cwdLabel !== null && runnable ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          in {actions.cwdLabel} · opens a new terminal tab
        </p>
      ) : null}
      <CautionLine assessment={assessment} />
      {!runnable && assessment.blocked === null ? (
        <p className="text-[12.5px] text-muted-foreground">
          {request.dialect === actions.dialect
            ? "Copy it into a terminal to run it."
            : "It's written for another shell than this computer's terminal, so copy it instead."}
        </p>
      ) : null}
      {run !== null ? <CommandRunStatusLine run={run} actions={actions} /> : null}
      {showButtons ? (
        <div className="flex flex-wrap items-center gap-2">
          {oneClick ? (
            <Button type="button" variant="outline" size="xs" onClick={() => start("run")}>
              <PlayIcon aria-hidden />
              Run
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="xs" onClick={() => start("insert")}>
            <TerminalIcon aria-hidden />
            Put in terminal
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => actions.setRequestDismissed(request.requestId, true)}
          >
            Skip
          </Button>
          <span className="ml-auto text-[12.5px] text-muted-foreground">
            {oneClick
              ? `${agent} gets the output when it finishes`
              : `You send ${agent} the output when you're done`}
          </span>
        </div>
      ) : runnable && run !== null && !isRunActive(run) ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={linkButtonClass}
            onClick={() => start(oneClick ? "run" : "insert")}
          >
            {oneClick ? "Run again" : "Put in again"}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

/** Whether a user message is the output of a run, handed back to its agent. */
export function isCommandOutputMessage(messageId: string): boolean {
  return commandRunIdOfOutputMessage(messageId) !== null;
}

/**
 * The message that handed a run's output to its agent: one line saying what
 * ran and how it went; the full text the agent got opens below it.
 */
export const CommandOutputMessage = memo(function CommandOutputMessage(props: {
  readonly messageId: string;
  readonly text: string;
  readonly renderText: (text: string) => ReactNode;
  readonly footer?: ReactNode;
}) {
  const actions = use(CommandRunActionsContext);
  const [open, setOpen] = useState(false);
  const runId = commandRunIdOfOutputMessage(props.messageId);
  const run =
    runId === null ? null : (actions?.runs.find((entry) => entry.runId === runId) ?? null);
  const command = run?.command ?? null;
  const duration = run !== null ? commandRunDuration(run) : null;
  const summary =
    run === null
      ? "Sent command output"
      : run.mode === "insert"
        ? "Sent the terminal's output"
        : run.status === "finished"
          ? run.exitCode === null || run.exitCode === 0
            ? `Finished${duration ? ` after ${duration}` : ""}`
            : `Exited with code ${run.exitCode}`
          : run.status === "running"
            ? "Output so far"
            : "Stopped before it finished";
  return (
    <div className="flex min-w-0 flex-col gap-1" data-command-output-message={runId ?? undefined}>
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 text-left text-[13.5px] text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate">
          {command !== null ? (
            <>
              You ran <code className="font-mono text-[12.5px]">{command.split("\n")[0]}</code>
            </>
          ) : (
            "Command output"
          )}
        </span>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">· {summary}</span>
      </button>
      {open ? <div className="min-w-0">{props.renderText(props.text)}</div> : null}
      {props.footer}
    </div>
  );
});
