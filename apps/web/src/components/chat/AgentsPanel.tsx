import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { XIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";

import type { SubagentProgressItem } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { LiveNode } from "../ui/threadline";
import { SubagentInspector } from "./SubagentInspector";
import { deriveSubagentDisplayDetails, type ThreadBackgroundRunItem } from "./threadActivity";
import {
  buildAgentBranches,
  formatAgentsHeaderMeta,
  type AgentBranch,
  type AgentBranchStatus,
} from "./agentsPanel.logic";

export interface AgentsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagents: ReadonlyArray<SubagentProgressItem>;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** Drives the trunk hue and the provenance chip, e.g. `codex`. */
  providerLabel?: string | null | undefined;
  /** Working directory, used to resolve file references in agent prose. */
  threadCwd?: string | null | undefined;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onClose?: (() => void) | undefined;
}

/** The trunk takes the provider's own hue so the panel reads as that
 *  provider's work; anything else falls back to the hairline colour. */
function trunkColor(providerLabel: string | null | undefined): string {
  const provider = providerLabel?.trim().toLowerCase();
  if (provider?.includes("claude")) {
    return "var(--provider-claude)";
  }
  if (provider?.includes("codex")) {
    return "var(--provider-codex)";
  }
  return "var(--border)";
}

const TRUNK_STYLE: CSSProperties = {
  background:
    "linear-gradient(to bottom, color-mix(in oklab, var(--agents-trunk) 38%, transparent), color-mix(in oklab, var(--agents-trunk) 10%, transparent) 72%, transparent)",
};

const ARM_STYLE: CSSProperties = {
  background: "color-mix(in oklab, var(--agents-trunk) 26%, transparent)",
};

function BranchNode({ status }: { status: AgentBranchStatus }) {
  if (status === "running") {
    return <LiveNode className="size-2" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-2 shrink-0 rounded-full",
        status === "waiting" && "bg-amber-500",
        status === "failed" && "bg-destructive",
        status === "completed" && "bg-muted-foreground/35",
      )}
    />
  );
}

function BranchRow({
  branch,
  onSelect,
  onStop,
}: {
  branch: AgentBranch;
  onSelect: (branch: AgentBranch) => void;
  onStop: (branch: AgentBranch) => void;
}) {
  const interactive =
    branch.kind === "subagent" ? branch.transcriptAvailable : branch.terminalId !== null;
  const meta = branch.meta.join(" · ");
  const ariaLabel =
    branch.kind === "subagent"
      ? `Open ${branch.name} transcript`
      : `${branch.terminalVisible ? "Close" : "Open"} ${branch.name} terminal`;

  const body = (
    <>
      <span className="mt-1 flex shrink-0 items-center">
        <BranchNode status={branch.status} />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground/90">
            {branch.name}
          </span>
          {branch.tag ? (
            <span
              className="shrink-0 font-mono text-[10px] leading-4 text-muted-foreground/50"
              data-agent-branch-tag="true"
            >
              {branch.tag}
            </span>
          ) : null}
          {meta ? (
            <span
              className="max-w-[45%] shrink-0 truncate font-mono text-[10px] leading-4 text-muted-foreground/55 tabular-nums"
              data-agent-branch-meta="true"
              title={meta}
            >
              {meta}
            </span>
          ) : null}
        </span>
        {branch.task ? (
          <span
            className="mt-0.5 block truncate text-[12px] leading-4 text-muted-foreground/80"
            data-agent-branch-task="true"
            title={branch.task}
          >
            {branch.task}
          </span>
        ) : null}
        {branch.output ? (
          <span
            className={cn(
              "mt-0.5 block truncate text-[11px] leading-4",
              branch.status === "running" ? "text-primary-readable/75" : "text-muted-foreground/55",
            )}
            data-agent-branch-output="true"
            title={branch.output}
          >
            {branch.output}
          </span>
        ) : null}
      </span>
    </>
  );

  const canStop = branch.kind === "run" && branch.run.canStop;
  const rowClassName = cn(
    "grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 py-4 pl-[calc(1.875rem+var(--branch-indent))] text-left",
    // Keep the head line clear of the stop control parked in the corner.
    canStop ? "pr-12" : "pr-3",
  );

  return (
    <li
      className="relative"
      style={{ ["--branch-indent"]: `${branch.depth * 12}px` } as CSSProperties}
      data-agent-branch="true"
      data-agent-branch-kind={branch.kind}
      data-agent-branch-status={branch.status}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[1.375rem] left-4 h-0.5 w-[calc(0.875rem+var(--branch-indent))] rounded-full"
        style={ARM_STYLE}
      />
      {interactive ? (
        <button
          type="button"
          className={cn(rowClassName, "transition-colors hover:bg-foreground/[0.03] focus-ring")}
          aria-label={ariaLabel}
          aria-pressed={branch.kind === "run" ? branch.terminalVisible : undefined}
          onClick={() => onSelect(branch)}
        >
          {body}
        </button>
      ) : (
        <div className={rowClassName}>{body}</div>
      )}
      {canStop ? (
        <button
          type="button"
          className="absolute top-3.5 right-2 rounded-[var(--app-radius-badge)] px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground/55 transition-colors hover:text-destructive focus-ring"
          aria-label={`Stop ${branch.name}`}
          data-agent-branch-stop="true"
          onClick={() => onStop(branch)}
        >
          stop
        </button>
      ) : null}
    </li>
  );
}

export const AgentsPanel = memo(function AgentsPanel({
  environmentId,
  threadId,
  subagents,
  backgroundRuns,
  providerLabel,
  threadCwd,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
  onClose,
}: AgentsPanelProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const branches = useMemo(
    () => buildAgentBranches({ subagents, backgroundRuns, providerLabel }),
    [backgroundRuns, providerLabel, subagents],
  );
  const headerMeta = useMemo(() => formatAgentsHeaderMeta({ subagents }), [subagents]);
  const anyRunning = branches.some((branch) => branch.status === "running");
  const selectedSubagent = subagents.find((item) => item.agentThreadId === selectedAgentId) ?? null;

  const handleSelect = useCallback(
    (branch: AgentBranch) => {
      if (branch.kind === "run") {
        if (branch.terminalId) {
          onToggleBackgroundRunTerminal(branch.terminalId);
        }
        return;
      }
      if (branch.item.agentThreadId) {
        setSelectedAgentId(branch.item.agentThreadId);
      }
    },
    [onToggleBackgroundRunTerminal],
  );

  const handleStop = useCallback(
    (branch: AgentBranch) => {
      if (branch.kind === "run") {
        onStopBackgroundRun(branch.run);
      }
    },
    [onStopBackgroundRun],
  );

  const handleBack = useCallback(() => {
    setSelectedAgentId(null);
  }, []);

  if (selectedSubagent) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-rail" data-agents-panel="drill-in">
        <SubagentInspector
          environmentId={environmentId}
          threadId={threadId}
          item={selectedSubagent}
          details={deriveSubagentDisplayDetails(selectedSubagent)}
          cwd={threadCwd ?? undefined}
          dismissVariant="back"
          onClose={handleBack}
        />
      </div>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-rail"
      aria-label="Agents"
      data-agents-panel="tree"
    >
      <div className="drag-region shrink-0 border-b border-border">
        <div className="flex h-12 items-center gap-2 px-4 py-2 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
          {anyRunning ? <LiveNode className="size-1.5" /> : null}
          <h2
            aria-label="Agents"
            className="min-w-0 truncate text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase"
          >
            Agents <span className="text-muted-foreground/35">·</span> this turn
          </h2>
          <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground/55 tabular-nums">
            {headerMeta}
          </span>
          {onClose ? (
            // Always visible: once the turn ends the header's activity chip
            // disappears, and this X is the only way left to close the panel.
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mr-1 shrink-0"
              aria-label="Close agents panel"
              onClick={onClose}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ ["--agents-trunk"]: trunkColor(providerLabel) } as CSSProperties}
      >
        {branches.length === 0 ? (
          <p
            className="px-4 py-6 text-[12px] text-muted-foreground/55"
            data-agents-panel-empty="true"
          >
            No agents on this turn.
          </p>
        ) : (
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 left-4 w-0.5 rounded-full"
              style={TRUNK_STYLE}
            />
            <ul className="relative divide-y divide-border/60">
              {branches.map((branch) => (
                <BranchRow
                  key={branch.key}
                  branch={branch}
                  onSelect={handleSelect}
                  onStop={handleStop}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
});
