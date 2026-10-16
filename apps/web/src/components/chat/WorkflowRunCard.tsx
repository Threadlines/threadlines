/**
 * A workflow run in the chat, where the call that launched it was.
 *
 * While it runs: its name, a clock and tokens, Stop, and its phases. A phase
 * that ended folds to one line; the live one lists its agents with the newest
 * thing each did. Past WORKFLOW_DOT_STRIP_THRESHOLD agents a phase draws them
 * as a strip of dots and gives a line only to the ones running or gone wrong.
 * Once it ends the card folds to a receipt.
 *
 * Everything here reads the run; workflowRunView.ts says how it reads.
 */
import type { OrchestrationWorkflowRun, WorkflowAgent } from "@threadlines/contracts";
import { CheckIcon, ChevronRightIcon, WorkflowIcon, XIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { TickingText } from "../ui/TickingText";
import {
  WORKFLOW_DOT_STRIP_THRESHOLD,
  formatWorkflowClock,
  formatWorkflowSpan,
  formatWorkflowTokens,
  pluralize,
  workflowAgentDisplayState,
  workflowAgentMeta,
  workflowAgentNowText,
  workflowAgentStepTool,
  workflowAgentsNeedingRows,
  workflowLargeNote,
  workflowPhaseGroups,
  workflowPhaseMeta,
  workflowRunElapsedMs,
  workflowRunEndNote,
  workflowRunEndWord,
  workflowRunSubtitle,
  workflowRunTitle,
  type WorkflowPhaseGroup,
} from "./workflowRunView";

/** Where a workflow opens in the Agents tab. */
export type WorkflowRunViewTab = "agents" | "timeline" | "script" | "result";

export interface WorkflowRunActions {
  /** Opens the run in the Agents tab, on a view or an agent. */
  readonly open: (taskId: string, target?: { tab?: WorkflowRunViewTab; agentId?: string }) => void;
  readonly stop: (taskId: string) => void;
  readonly save: (taskId: string) => void;
  /** What decides whether a run counts as large (workflowLargeNote). */
  readonly ultracode: boolean;
  readonly sizeGuideline: string | null;
}

export function WorkflowAgentDot({
  agent,
  className,
}: {
  readonly agent: WorkflowAgent;
  readonly className?: string;
}) {
  const state = workflowAgentDisplayState(agent);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block shrink-0 rounded-full",
        state === "running" && "bg-primary-graph",
        state === "retrying" && "bg-amber-500",
        state === "done" && "bg-muted-foreground/40",
        state === "failed" && "bg-destructive",
        // Never ran to its end (cut off by the run's end, or left out by the
        // script): not a failure.
        state === "skipped" && "bg-muted-foreground/25",
        state === "queued" && "border border-muted-foreground/45",
        className ?? "size-1.5",
      )}
    />
  );
}

function PhaseMark({ group }: { readonly group: WorkflowPhaseGroup }) {
  switch (group.state) {
    case "done":
      return <CheckIcon aria-hidden="true" className="size-3 text-muted-foreground" />;
    case "failed":
      return <XIcon aria-hidden="true" className="size-3 text-destructive" />;
    case "live":
      return <span aria-hidden="true" className="block size-1.5 rounded-full bg-primary-graph" />;
    case "waiting":
    case "skipped":
      return (
        <span
          aria-hidden="true"
          className="block size-1.5 rounded-full border border-muted-foreground/45"
        />
      );
  }
}

function AgentRow({
  agent,
  running,
  onOpen,
}: {
  readonly agent: WorkflowAgent;
  readonly running: boolean;
  readonly onOpen: (() => void) | null;
}) {
  const now = workflowAgentNowText(agent);
  const tool = workflowAgentStepTool(agent);
  const state = workflowAgentDisplayState(agent);
  const content = (
    <>
      <span className="flex h-4 items-center">
        <WorkflowAgentDot agent={agent} />
      </span>
      <span className="truncate font-medium text-foreground/80">
        {agent.label}
        {(agent.attempt ?? 1) > 1 ? (
          <span className="font-normal text-muted-foreground"> (retry {agent.attempt! - 1})</span>
        ) : null}
      </span>
      <TickingText
        active={running && agent.state === "running"}
        compute={() => workflowAgentMeta(agent, Date.now())}
        className="truncate font-mono text-[10.5px] text-muted-foreground tabular-nums"
      />
      <span
        className={cn(
          "truncate",
          state === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {tool ? <span className="font-medium text-foreground/75">{tool} </span> : null}
        {now}
      </span>
    </>
  );
  const className =
    "col-span-full grid min-w-0 grid-cols-subgrid items-center gap-x-2 text-left text-[12px] leading-5";
  return onOpen ? (
    <button
      type="button"
      className={cn(className, "rounded-sm outline-none hover:bg-foreground/[0.03] focus-ring")}
      onClick={onOpen}
      title={`${agent.label}: ${now ?? ""}`}
      data-workflow-agent-row={agent.index}
    >
      {content}
    </button>
  ) : (
    <div className={className} data-workflow-agent-row={agent.index}>
      {content}
    </div>
  );
}

function PhaseAgents({
  group,
  running,
  onOpenAgent,
}: {
  readonly group: WorkflowPhaseGroup;
  readonly running: boolean;
  readonly onOpenAgent: ((agentId: string) => void) | null;
}) {
  const strip = group.agents.length > WORKFLOW_DOT_STRIP_THRESHOLD;
  const rows = strip ? workflowAgentsNeedingRows(group.agents) : group.agents;
  return (
    <div className="ml-[7px] border-l border-border/60 py-0.5 pl-3">
      {strip ? (
        <div
          className="flex max-w-[34rem] flex-wrap gap-1 py-1"
          role="img"
          aria-label={`${group.done} of ${group.agents.length} agents done`}
          data-workflow-dot-strip="true"
        >
          {group.agents.map((agent) => (
            <span key={agent.index} title={`${agent.label}: ${workflowAgentNowText(agent) ?? ""}`}>
              <WorkflowAgentDot agent={agent} className="size-2" />
            </span>
          ))}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="grid min-w-0 grid-cols-[0.375rem_minmax(5rem,9.5rem)_fit-content(8.5rem)_minmax(0,1fr)] gap-x-2">
          {rows.map((agent) => (
            <AgentRow
              key={agent.index}
              agent={agent}
              running={running}
              onOpen={onOpenAgent && agent.agentId ? () => onOpenAgent(agent.agentId!) : null}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlainAction({
  label,
  onClick,
  tone,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly tone?: "danger";
}) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-sm text-[12px] leading-5 text-muted-foreground outline-none transition-colors duration-150 focus-ring",
        tone === "danger" ? "hover:text-destructive" : "hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export const WorkflowRunCard = memo(function WorkflowRunCard({
  run,
  actions,
}: {
  readonly run: OrchestrationWorkflowRun;
  readonly actions: WorkflowRunActions | null;
}) {
  const running = run.status === "running";
  const groups = useMemo(() => workflowPhaseGroups(run, Date.now()), [run]);
  // A phase opens by itself while it is live; the reader's own choice wins.
  const [openPhases, setOpenPhases] = useState<Readonly<Record<string, boolean>>>({});
  const title = workflowRunTitle(run);
  const subtitle = workflowRunSubtitle(run);
  const endWord = workflowRunEndWord(run);
  const endNote = workflowRunEndNote(run);
  const largeNote = actions
    ? workflowLargeNote({
        run,
        ultracode: actions.ultracode,
        sizeGuideline: actions.sizeGuideline,
      })
    : null;
  const onOpenAgent = actions
    ? (agentId: string) => actions.open(run.taskId, { tab: "agents", agentId })
    : null;
  const finishedAgents = run.agents.length;

  return (
    <section
      className="min-w-0 py-0.5"
      aria-label={`Workflow: ${title}`}
      data-workflow-run={run.taskId}
      data-workflow-run-status={run.status}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <WorkflowIcon
          aria-hidden="true"
          className="relative top-[2px] size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{title}</span>
        {endWord ? (
          <span
            className={cn(
              "shrink-0 text-[12px]",
              run.status === "failed" || run.status === "lost"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {endWord}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-baseline gap-3">
          <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {running ? (
              <TickingText
                active
                compute={() => formatWorkflowClock(workflowRunElapsedMs(run, Date.now()))}
              />
            ) : (
              <>
                {formatWorkflowSpan(workflowRunElapsedMs(run, Date.now()))}
                {finishedAgents > 0 ? ` · ${pluralize(finishedAgents, "agent")}` : ""}
              </>
            )}
            {run.totalTokens > 0 ? ` · ${formatWorkflowTokens(run.totalTokens)}` : ""}
            {!running && run.totalToolCalls > 0
              ? ` · ${pluralize(run.totalToolCalls, "step")}`
              : ""}
          </span>
          {running && actions ? (
            <PlainAction label="Stop" tone="danger" onClick={() => actions.stop(run.taskId)} />
          ) : null}
        </span>
      </div>
      {subtitle && running ? (
        <p className="ml-[22px] truncate text-[12px] leading-5 text-muted-foreground">{subtitle}</p>
      ) : null}

      {running ? (
        <div className="mt-1 space-y-px pl-1.5">
          {groups.map((group) => {
            const key = group.phase ? String(group.phase.index) : "loose";
            const open = openPhases[key] ?? group.state === "live";
            const canOpen = group.agents.length > 0;
            return (
              <div key={key} data-workflow-phase={key} data-workflow-phase-state={group.state}>
                <button
                  type="button"
                  disabled={!canOpen}
                  aria-expanded={canOpen ? open : undefined}
                  className="group/phase grid w-full min-w-0 grid-cols-[0.75rem_minmax(0,auto)_minmax(0,1fr)_0.75rem] items-center gap-x-2 rounded-sm text-left text-[12.5px] leading-6 outline-none focus-ring enabled:hover:bg-foreground/[0.03]"
                  onClick={() => setOpenPhases((current) => ({ ...current, [key]: !open }))}
                >
                  <span className="flex items-center justify-center">
                    <PhaseMark group={group} />
                  </span>
                  <span
                    className={cn(
                      "truncate font-medium",
                      group.state === "waiting" ? "text-muted-foreground" : "text-foreground/85",
                    )}
                  >
                    {group.title}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-muted-foreground tabular-nums">
                    {workflowPhaseMeta(group)}
                  </span>
                  {canOpen ? (
                    <ChevronRightIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3 text-muted-foreground/60 transition-transform duration-150 group-hover/phase:text-muted-foreground",
                        open && "rotate-90",
                      )}
                    />
                  ) : null}
                </button>
                {open && canOpen ? (
                  <PhaseAgents group={group} running={running} onOpenAgent={onOpenAgent} />
                ) : null}
              </div>
            );
          })}
          {groups.length === 0 ? (
            <p className="ml-[22px] text-[12px] leading-5 text-muted-foreground">
              Starting its first agents…
            </p>
          ) : null}
        </div>
      ) : (
        <p className="ml-[22px] flex min-w-0 flex-wrap items-center gap-x-3 text-[12px] leading-5 text-muted-foreground">
          {groups.map((group) => (
            <span
              key={group.phase ? group.phase.index : "loose"}
              className="inline-flex items-center gap-1"
            >
              <PhaseMark group={group} />
              {group.title} {group.agents.length}
            </span>
          ))}
          {endNote ? <span className="min-w-0 truncate">{endNote}</span> : null}
        </p>
      )}

      {largeNote || actions ? (
        <div className="ml-[22px] mt-1 flex min-w-0 flex-wrap items-center gap-x-3.5">
          {largeNote ? (
            <span className="text-[12px] leading-5 text-amber-600 dark:text-amber-400">
              {largeNote}
            </span>
          ) : null}
          {actions ? (
            <>
              <PlainAction
                label={running ? "Open in panel" : "Open"}
                onClick={() => actions.open(run.taskId)}
              />
              {!run.hiddenScript ? (
                <PlainAction
                  label="View script"
                  onClick={() => actions.open(run.taskId, { tab: "script" })}
                />
              ) : null}
              {!running && !run.hiddenScript ? (
                <PlainAction label="Save as command…" onClick={() => actions.save(run.taskId)} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
