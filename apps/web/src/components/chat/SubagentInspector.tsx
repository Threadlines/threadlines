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
} from "../../session-logic";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { useServerProviders } from "../../rpc/serverState";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { LiveNode } from "../ui/threadline";
import type { SubagentDisplayDetails } from "./threadActivity";
import {
  formatSubagentMetaParts,
  resolveSubagentModelLabel,
  SubagentModelMeta,
} from "./subagentMeta";
import { SubagentTranscript } from "./SubagentTranscript";

interface SubagentInspectorProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  item: SubagentProgressItem;
  details: SubagentDisplayDetails;
  cwd?: string | undefined;
  /** `back` returns to a list the inspector was drilled into (the agents
   *  panel); `close` dismisses the surface entirely (the dialog). */
  dismissVariant?: "close" | "back";
  onClose: () => void;
}

/**
 * Chroma is for the states that want the reader: running, waiting on them, or
 * failed. "Done" is the ordinary outcome of every agent that ever ran, so it
 * reads as muted text with no fill behind it -- a receipt, not an alert.
 */
function statusClassName(status: SubagentProgressItem["status"]): string {
  if (status === "completed") {
    return "text-muted-foreground/55";
  }
  if (status === "failed" || status === "interrupted") {
    return "bg-destructive/10 text-destructive";
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
  details,
  cwd,
  dismissVariant = "close",
  onClose,
}: SubagentInspectorProps) {
  const [providerAgent, setProviderAgent] = useState<ProviderSubagentTranscriptResult["agent"]>();
  const [goalExpanded, setGoalExpanded] = useState(false);
  const providers = useServerProviders();
  const displayName = formatSubagentDisplayName(item);
  const active = isActiveSubagentStatus(item.status);
  const transcriptAgentId = item.transcriptAgentId ?? item.agentThreadId;
  const handleAgentResolved = useCallback((agent: ProviderSubagentTranscriptResult["agent"]) => {
    setProviderAgent(agent);
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
        {goal ? (
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
        fallbackBody={item.liveBody}
        onAgentResolved={handleAgentResolved}
        scrollable
      />
    </section>
  );
}
