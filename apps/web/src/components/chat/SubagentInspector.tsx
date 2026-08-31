import type {
  EnvironmentId,
  ProviderSubagentTranscriptResult,
  ThreadId,
} from "@threadlines/contracts";
import { ArrowLeftIcon, BotIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import {
  formatSubagentDisplayName,
  isActiveSubagentStatus,
  type SubagentProgressItem,
  type WorkLogEntry,
} from "../../session-logic";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { useServerProviders } from "../../rpc/serverState";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { LiveNode } from "../ui/threadline";
import { normalizeSubagentInlineText, type SubagentDisplayDetails } from "./threadActivity";
import {
  formatSubagentMetaParts,
  resolveSubagentModelLabel,
  SubagentModelMeta,
} from "./subagentMeta";
import { SubagentTranscript } from "./SubagentTranscript";
import { sendSubagentInput } from "./subagentTranscriptClient";

interface SubagentInspectorProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  item: SubagentProgressItem;
  activityEntries?: ReadonlyArray<WorkLogEntry> | undefined;
  details: SubagentDisplayDetails;
  cwd?: string | undefined;
  /** `back` returns to a list the inspector was drilled into (the agents
   *  panel); `close` dismisses the surface entirely (the dialog). */
  dismissVariant?: "close" | "back";
  /** The provider can take a message straight to this agent (Codex). The
   *  composer only shows while the agent is live. */
  canSendInput?: boolean | undefined;
  onMessageThroughParent?: ((agentName: string) => void) | undefined;
  onClose: () => void;
}

/**
 * Chroma is for the states that want the reader: running, waiting on them, or
 * failed. Done and intentionally stopped work stay neutral -- receipts, not
 * alerts.
 */
function statusClassName(status: SubagentProgressItem["status"]): string {
  if (status === "completed") {
    return "text-muted-foreground/55";
  }
  if (status === "failed") {
    return "bg-destructive/10 text-destructive";
  }
  if (status === "interrupted") {
    return "bg-muted text-muted-foreground/70";
  }
  if (status === "waiting") {
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
  return "bg-primary/10 text-primary-readable";
}

export function SubagentInspector({
  environmentId,
  threadId,
  item,
  activityEntries,
  details,
  cwd,
  dismissVariant = "close",
  canSendInput = false,
  onMessageThroughParent,
  onClose,
}: SubagentInspectorProps) {
  const [providerAgent, setProviderAgent] = useState<ProviderSubagentTranscriptResult["agent"]>();
  const [transcriptInstruction, setTranscriptInstruction] = useState<string | null>(null);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const providers = useServerProviders();
  const displayName = formatSubagentDisplayName(item);
  const active = isActiveSubagentStatus(item.status);
  const transcriptAgentId = item.transcriptAgentId ?? item.agentThreadId;
  const directInput = !canSendInput
    ? "unsupported"
    : providerAgent === undefined
      ? "checking"
      : (providerAgent.directInput ?? "unknown");
  const handleAgentResolved = useCallback((agent: ProviderSubagentTranscriptResult["agent"]) => {
    setProviderAgent(agent);
  }, []);
  const handleInstructionResolved = useCallback((text: string | null) => {
    setTranscriptInstruction(text);
  }, []);
  // The spawning tool call rarely names the model a Claude agent runs on; the
  // provider's own record of the agent does.
  const model = item.model ?? providerAgent?.model ?? null;
  const modelLabel = resolveSubagentModelLabel(providers, model);
  const hasModelMeta = Boolean(modelLabel ?? item.reasoningEffort);
  // Codex's native spawn activity does not carry the prompt, but its stored
  // child thread exposes that prompt as the provider description/preview.
  const providerGoal = providerAgent?.description?.trim() || null;
  const goal = details.goal ?? providerGoal;
  const goalTitle = details.title ?? providerGoal ?? undefined;
  // The instruction block below already carries this text, in full and
  // unclamped, so the header does not say it a second time. Comparing the
  // rendered text rather than the provider covers both shapes: a Codex child
  // whose block is standing in the objective, and a Claude child whose leading
  // message is the prompt the objective was derived from.
  const goalShownInTranscript =
    goal !== null &&
    transcriptInstruction !== null &&
    normalizeSubagentInlineText(transcriptInstruction).includes(goal);
  const metaParts = formatSubagentMetaParts(item, {
    context: details.context,
    elapsed: active
      ? formatElapsedDurationLabel(item.createdAt)
      : `Updated ${formatRelativeTimeLabel(item.updatedAt)}`,
  });

  return (
    <section
      className="flex size-full min-h-0 flex-col"
      aria-label={`${displayName} subagent inspector`}
      data-subagent-inspector="true"
    >
      {/* The way back rides on the title line rather than owning a column beside
          it: everything under the title then starts on the panel's own 12px
          gutter instead of hanging off a 44px indent. */}
      <header className="shrink-0 border-b border-border/65 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {dismissVariant === "back" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-ml-1 shrink-0 text-muted-foreground/70"
              aria-label="Back to agents"
              onClick={onClose}
            >
              <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-readable">
              <BotIcon className="size-3" aria-hidden="true" />
            </span>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {displayName}
          </h2>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium",
              statusClassName(item.status),
            )}
            data-subagent-inspector-status="true"
          >
            {active ? <LiveNode className="size-1.5" /> : null}
            {item.statusLabel}
          </span>
          {dismissVariant === "close" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mr-1 shrink-0 text-muted-foreground/70"
              aria-label="Close subagent inspector"
              onClick={onClose}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {goal && !goalShownInTranscript ? (
          <button
            type="button"
            className="mt-1 block w-full text-left text-[12px] leading-4 text-foreground/85"
            aria-expanded={goalExpanded}
            title={goalTitle}
            onClick={() => setGoalExpanded((value) => !value)}
            data-subagent-inspector-goal="true"
          >
            <span className={cn("block", goalExpanded ? undefined : "line-clamp-2")}>{goal}</span>
          </button>
        ) : null}
        <div
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-muted-foreground/60"
          data-subagent-inspector-meta="true"
        >
          <SubagentModelMeta modelLabel={modelLabel} reasoningEffort={item.reasoningEffort} />
          {metaParts.map((part, index) => (
            <span key={part} className="inline-flex items-center gap-1.5">
              {index > 0 || hasModelMeta ? (
                <span className="text-muted-foreground/30">·</span>
              ) : null}
              <span className="max-w-full truncate">{part}</span>
            </span>
          ))}
        </div>
        {item.agentPath ? (
          <p
            className="mt-0.5 max-w-full truncate font-mono text-[10px] text-muted-foreground/45"
            title={item.agentPath}
          >
            {item.agentPath}
          </p>
        ) : null}
      </header>

      <SubagentTranscript
        environmentId={environmentId}
        threadId={threadId}
        agentIds={transcriptAgentId === null ? [] : [transcriptAgentId]}
        follow={active}
        cwd={cwd}
        objective={goal}
        fallbackBody={item.liveBody}
        terminalNotice={
          item.status === "interrupted"
            ? { label: "Stopped before completion", createdAt: item.updatedAt }
            : null
        }
        activityEntries={activityEntries}
        onAgentResolved={handleAgentResolved}
        onInstructionResolved={handleInstructionResolved}
        scrollable
      />
      {active && transcriptAgentId !== null ? (
        directInput === "available" ? (
          <SubagentInputComposer
            environmentId={environmentId}
            threadId={threadId}
            agentId={transcriptAgentId}
            agentName={displayName}
          />
        ) : directInput === "parentOnly" ? (
          <div
            className="shrink-0 border-t border-border/65 px-3 py-2"
            data-subagent-input-parent-only="true"
          >
            <p className="text-[12px] leading-5 text-muted-foreground">
              This agent only accepts messages from its parent.
            </p>
            {onMessageThroughParent ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="mt-1 -ml-2 text-[12px]"
                onClick={() => onMessageThroughParent(displayName)}
              >
                Message through parent
              </Button>
            ) : null}
          </div>
        ) : directInput === "unknown" ? (
          <p
            className="shrink-0 border-t border-border/65 px-3 py-2 text-[12px] leading-5 text-muted-foreground"
            data-subagent-input-unknown="true"
          >
            Direct message availability could not be confirmed.
          </p>
        ) : directInput === "checking" ? (
          <p
            className="shrink-0 border-t border-border/65 px-3 py-2 text-[12px] leading-5 text-muted-foreground"
            data-subagent-input-checking="true"
          >
            Checking whether this agent accepts direct messages…
          </p>
        ) : null
      ) : null}
    </section>
  );
}

/**
 * One line to the agent itself, under its transcript. Enter sends, Shift+Enter
 * breaks a line. The reply lands in the transcript above like any other turn,
 * so there is nothing else to show here but a failure.
 */
function SubagentInputComposer({
  environmentId,
  threadId,
  agentId,
  agentName,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentId: string;
  agentName: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();

  const submit = useCallback(async () => {
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendSubagentInput({ environmentId, threadId, agentId, text: trimmed });
      setText("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Could not send.");
    } finally {
      setSending(false);
    }
  }, [agentId, environmentId, sending, threadId, trimmed]);

  return (
    <form
      className="shrink-0 border-t border-border/65 px-3 py-2"
      data-subagent-input-composer="true"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message this agent"
          className="min-h-5 flex-1 resize-none bg-transparent text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/45 disabled:opacity-60"
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={`Message ${agentName}`}
          rows={1}
          value={text}
        />
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={trimmed.length === 0 || sending}
          className="shrink-0 text-[12px]"
        >
          Send
        </Button>
      </div>
      {error ? (
        <p className="mt-1 text-[11px] leading-4 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
