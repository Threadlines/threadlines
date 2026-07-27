import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { BotIcon, ClockIcon, XIcon } from "lucide-react";

import {
  formatSubagentDisplayName,
  isActiveSubagentStatus,
  type SubagentProgressItem,
} from "../../session-logic";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SubagentTranscript } from "./SubagentTranscript";

interface SubagentInspectorProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  item: SubagentProgressItem;
  details: {
    goal: string | null;
    metadata: ReadonlyArray<{ title: string; label: string }>;
  };
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
  onClose,
}: SubagentInspectorProps) {
  const displayName = formatSubagentDisplayName(item);
  const active = isActiveSubagentStatus(item.status);

  return (
    <section
      className="flex size-full min-h-0 flex-col"
      aria-label={`${displayName} subagent inspector`}
      data-subagent-inspector="true"
    >
      <header className="shrink-0 border-b border-border/65 px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-readable">
            <BotIcon className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-[13px] font-medium text-foreground">{displayName}</h2>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium",
                  statusClassName(item.status),
                )}
              >
                {item.statusLabel}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/65">
              <span className="inline-flex items-center gap-1">
                <ClockIcon className="size-2.5" aria-hidden="true" />
                {active
                  ? formatElapsedDurationLabel(item.createdAt)
                  : `Updated ${formatRelativeTimeLabel(item.updatedAt)}`}
              </span>
              {item.agentPath ? (
                <span className="max-w-full truncate font-mono" title={item.agentPath}>
                  {item.agentPath}
                </span>
              ) : null}
            </div>
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

        {details.goal ? (
          <div className="mt-2 border-t border-border/45 pt-2">
            <p className="text-[9px] font-medium tracking-[0.08em] text-muted-foreground/55 uppercase">
              Goal
            </p>
            <p className="mt-0.5 max-h-20 overflow-y-auto text-[11px] leading-4 text-foreground/80">
              {details.goal}
            </p>
          </div>
        ) : null}

        {details.metadata.length > 0 ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
            {details.metadata.map((chip) => (
              <span
                key={`${chip.title}:${chip.label}`}
                className="inline-flex max-w-full items-center gap-1 rounded border border-border/55 bg-background/55 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground/75"
                title={`${chip.title}: ${chip.label}`}
              >
                <span className="text-muted-foreground/50">{chip.title}</span>
                <span className="min-w-0 truncate">{chip.label}</span>
              </span>
            ))}
          </div>
        ) : null}

        {item.liveBody && active ? (
          <div className="mt-2 border-t border-border/45 pt-2" data-subagent-inspector-live="true">
            <p className="text-[9px] font-medium tracking-[0.08em] text-muted-foreground/55 uppercase">
              Latest activity
            </p>
            <p className="mt-0.5 line-clamp-3 text-[11px] leading-4 text-muted-foreground/80">
              {item.liveBody}
            </p>
          </div>
        ) : null}
      </header>

      <SubagentTranscript
        environmentId={environmentId}
        threadId={threadId}
        agentIds={[item.agentThreadId].filter((agentId): agentId is string => agentId !== null)}
        follow={active}
        scrollable
      />
    </section>
  );
}
