import type {
  EnvironmentId,
  ProviderSubagentTranscriptResult,
  ThreadId,
} from "@threadlines/contracts";
import { BotIcon, XIcon } from "lucide-react";
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
import type { SubagentDisplayDetails } from "./ThreadActivityPopover";
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
  onClose: () => void;
}

function statusClassName(status: SubagentProgressItem["status"]): string {
  if (status === "completed") {
    return "bg-success/10 text-success";
  }
  if (status === "failed" || status === "interrupted") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-primary/10 text-primary-readable";
}

export function SubagentInspector({
  environmentId,
  threadId,
  item,
  details,
  cwd,
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
      <header className="shrink-0 border-b border-border/65 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-readable">
            <BotIcon className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-[13px] font-medium text-foreground">{displayName}</h2>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium",
                  statusClassName(item.status),
                )}
              >
                {active ? <LiveNode className="size-1.5" /> : null}
                {item.statusLabel}
              </span>
            </div>
            {details.goal ? (
              <button
                type="button"
                className="mt-1 block w-full text-left text-[12px] leading-4 text-foreground/85"
                aria-expanded={goalExpanded}
                title={details.title ?? details.goal}
                onClick={() => setGoalExpanded((value) => !value)}
                data-subagent-inspector-goal="true"
              >
                <span className={cn("block", goalExpanded ? undefined : "line-clamp-2")}>
                  {details.goal}
                </span>
              </button>
            ) : null}
            <div
              className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-muted-foreground/60"
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
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-mt-0.5 -mr-1 shrink-0 text-muted-foreground/70"
            aria-label="Close subagent inspector"
            onClick={onClose}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
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
