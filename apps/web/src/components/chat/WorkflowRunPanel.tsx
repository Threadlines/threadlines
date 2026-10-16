/**
 * A workflow run in the Agents tab: what the chat's run card opens. The
 * header names the run and carries Stop (or, once it ended, Save as command).
 * Four tabs under it: Agents (the agents by phase, and one agent's
 * transcript), Timeline (who ran when), Script, and Result.
 *
 * An agent's transcript is read from the run's own folder, through the run's
 * owner (workflowRunClient), so a run stays readable after a restart.
 */
import type {
  EnvironmentId,
  OrchestrationWorkflowRun,
  ThreadId,
  WorkflowAgent,
} from "@threadlines/contracts";
import { ChevronLeftIcon, ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { selectAgentsPanelWorkflow, type WorkflowRunSelection } from "../../agentsPanelStore";
import { formatDuration } from "../../session-logic";
import { Button } from "../ui/button";
import { moveBetweenTabs } from "../ui/page-tabs";
import { TickingText } from "../ui/TickingText";
import { SubagentTranscript, type SubagentTranscriptPageReader } from "./SubagentTranscript";
import { WorkflowAgentDot, type WorkflowRunViewTab } from "./WorkflowRunCard";
import { WorkflowRunFileView } from "./WorkflowRunFiles";
import { WorkflowRunTimeline } from "./WorkflowRunTimeline";
import { WorkflowSaveDialog } from "./WorkflowSaveDialog";
import { readWorkflowAgentTranscriptPage } from "./workflowRunClient";
import {
  formatWorkflowClock,
  formatWorkflowSpan,
  formatWorkflowTokens,
  pluralize,
  workflowAgentDisplayState,
  workflowAgentMeta,
  workflowAgentNowText,
  workflowPhaseGroups,
  workflowPhaseMeta,
  workflowRunElapsedMs,
  workflowRunEndWord,
  workflowRunSubtitle,
  workflowRunTitle,
} from "./workflowRunView";

const TABS: ReadonlyArray<{ readonly id: WorkflowRunViewTab; readonly label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "timeline", label: "Timeline" },
  { id: "script", label: "Script" },
  { id: "result", label: "Result" },
];

const AGENT_STATE_WORDS: Readonly<Record<ReturnType<typeof workflowAgentDisplayState>, string>> = {
  queued: "waiting to start",
  running: "running",
  retrying: "running again",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

function agentDetailMeta(agent: WorkflowAgent, nowMs: number): string {
  const parts: Array<string> = [AGENT_STATE_WORDS[workflowAgentDisplayState(agent)]];
  if (agent.model) parts.push(agent.model);
  const timing = workflowAgentMeta(agent, nowMs);
  if (timing) parts.push(timing);
  if (agent.tokens !== undefined && agent.tokens > 0)
    parts.push(formatWorkflowTokens(agent.tokens));
  if ((agent.attempt ?? 1) > 1) {
    parts.push(`attempt ${agent.attempt}${agent.retryReason ? ` (${agent.retryReason})` : ""}`);
  }
  if (agent.isolation === "worktree") parts.push("own copy of the repo");
  return parts.join(" · ");
}

function AgentList({
  run,
  onOpenAgent,
}: {
  readonly run: OrchestrationWorkflowRun;
  readonly onOpenAgent: (agentId: string) => void;
}) {
  const running = run.status === "running";
  const groups = useMemo(() => workflowPhaseGroups(run, Date.now()), [run]);
  if (run.agents.length === 0) {
    return <p className="px-3 py-6 text-[12px] text-muted-foreground">No agents yet.</p>;
  }
  return (
    <div className="py-1">
      {groups.map((group) => (
        <section
          key={group.phase ? group.phase.index : "loose"}
          aria-label={group.title}
          className="pb-1"
        >
          <div className="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1">
            <span className="truncate text-[11.5px] font-semibold text-muted-foreground">
              {group.title}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">
              {workflowPhaseMeta(group)}
            </span>
          </div>
          <ul>
            {group.agents.map((agent) => {
              const now = workflowAgentNowText(agent);
              const openable = agent.agentId !== undefined;
              return (
                <li key={agent.index}>
                  <button
                    type="button"
                    disabled={!openable}
                    className="group/workflow-agent grid w-full min-w-0 grid-cols-[0.375rem_minmax(0,1fr)_auto_0.75rem] items-center gap-x-2 px-3 py-1 text-left outline-none focus-ring enabled:hover:bg-foreground/[0.03]"
                    onClick={() => agent.agentId && onOpenAgent(agent.agentId)}
                    data-workflow-panel-agent={agent.index}
                  >
                    <WorkflowAgentDot agent={agent} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-foreground/85">
                        {agent.label}
                      </span>
                      {now ? (
                        <span
                          className={cn(
                            "block truncate text-[11.5px]",
                            agent.state === "failed" ? "text-destructive" : "text-muted-foreground",
                          )}
                        >
                          {now}
                        </span>
                      ) : null}
                    </span>
                    <TickingText
                      active={running && agent.state === "running"}
                      compute={() =>
                        agent.startedAt === undefined
                          ? ""
                          : formatDuration(
                              Math.max(
                                0,
                                (agent.state === "running"
                                  ? Date.now()
                                  : agent.startedAt + (agent.durationMs ?? 0)) - agent.startedAt,
                              ),
                            )
                      }
                      className="font-mono text-[10.5px] text-muted-foreground tabular-nums"
                    />
                    {openable ? (
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="size-3 text-muted-foreground/40 group-hover/workflow-agent:text-muted-foreground"
                      />
                    ) : (
                      <span />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AgentDetail({
  environmentId,
  threadId,
  run,
  agent,
  cwd,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: OrchestrationWorkflowRun;
  readonly agent: WorkflowAgent;
  readonly cwd: string | undefined;
  readonly onBack: () => void;
}) {
  const running = agent.state === "running";
  const readPage = useCallback<SubagentTranscriptPageReader>(
    (page) =>
      readWorkflowAgentTranscriptPage({
        environmentId,
        threadId,
        taskId: run.taskId,
        agentId: page.agentId,
        ...(page.limit !== undefined ? { limit: page.limit } : {}),
        ...(page.offset !== undefined ? { offset: page.offset } : {}),
        ...(page.fromEnd !== undefined ? { fromEnd: page.fromEnd } : {}),
      }),
    [environmentId, run.taskId, threadId],
  );
  const agentIds = useMemo(() => (agent.agentId ? [agent.agentId] : []), [agent.agentId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-workflow-agent-detail={agent.index}>
      <div className="shrink-0 px-3 pt-2 pb-1.5">
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-sm text-[11.5px] text-muted-foreground outline-none hover:text-foreground focus-ring"
          onClick={onBack}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-3" />
          All agents
        </button>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <WorkflowAgentDot agent={agent} />
          <span className="min-w-0 truncate text-[13.5px] font-semibold">{agent.label}</span>
        </div>
        <TickingText
          active={running && run.status === "running"}
          compute={() => agentDetailMeta(agent, Date.now())}
          className="mt-0.5 block truncate font-mono text-[10.5px] text-muted-foreground tabular-nums"
        />
        {agent.error ? (
          <p
            className={cn(
              "mt-1 text-[12px]",
              agent.state === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {agent.error}
          </p>
        ) : null}
      </div>
      {agentIds.length > 0 ? (
        <SubagentTranscript
          key={agent.agentId}
          environmentId={environmentId}
          threadId={threadId}
          agentIds={agentIds}
          readPage={readPage}
          follow={running}
          scrollable
          cwd={cwd}
          objective={agent.instructionsPreview ?? null}
          fallbackBody={agent.resultPreview ?? null}
          liveStep={running ? (agent.lastStep ?? null) : null}
          className="min-h-0 flex-1"
        />
      ) : (
        <p className="px-3 py-6 text-[12px] text-muted-foreground">
          This agent has not started yet.
        </p>
      )}
    </div>
  );
}

export function WorkflowRunPanel({
  environmentId,
  threadId,
  run,
  selection,
  cwd,
  onBack,
  onStop,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: OrchestrationWorkflowRun;
  readonly selection: WorkflowRunSelection;
  readonly cwd: string | undefined;
  readonly onBack: () => void;
  readonly onStop: (taskId: string) => void;
}) {
  const running = run.status === "running";
  const title = workflowRunTitle(run);
  const subtitle = workflowRunSubtitle(run);
  const endWord = workflowRunEndWord(run);
  const [saveOpen, setSaveOpen] = useState(false);
  // The chat's "Save as command…" opens the panel asking for the dialog.
  useEffect(() => {
    if (selection.saving && !running) setSaveOpen(true);
  }, [running, selection.saving]);
  const onSaveOpenChange = (open: boolean) => {
    setSaveOpen(open);
    if (!open && selection.saving) selectAgentsPanelWorkflow({ ...selection, saving: false });
  };
  const select = (next: Partial<WorkflowRunSelection>) =>
    selectAgentsPanelWorkflow({ ...selection, saving: false, ...next });
  const agent =
    selection.agentId !== null
      ? run.agents.find((entry) => entry.agentId === selection.agentId)
      : undefined;
  const openAgent = (agentId: string) => select({ tab: "agents", agentId });
  const panelId = `workflow-run-${run.taskId}`;

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-rail"
      aria-label={`Workflow: ${title}`}
      data-agents-panel="workflow"
      data-workflow-panel-run={run.taskId}
    >
      <div className="shrink-0 border-b border-border px-2 pt-1.5 pb-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Back to agents"
            onClick={onBack}
          >
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
          </Button>
          <WorkflowIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="min-w-0 truncate text-[13px] font-semibold">{title}</h2>
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
          <span className="ml-auto flex shrink-0 items-center">
            {running ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onStop(run.taskId)}
              >
                Stop workflow
              </Button>
            ) : !run.hiddenScript ? (
              <Button type="button" variant="ghost" size="xs" onClick={() => setSaveOpen(true)}>
                Save as command…
              </Button>
            ) : null}
          </span>
        </div>
        {/* Wraps between facts, never inside one: the panel can be narrow. */}
        <div className="mt-0.5 flex flex-wrap pl-8 font-mono text-[10.5px] whitespace-pre text-muted-foreground tabular-nums">
          <span>
            {running ? (
              <TickingText
                active
                compute={() => formatWorkflowClock(workflowRunElapsedMs(run, Date.now()))}
              />
            ) : (
              formatWorkflowSpan(workflowRunElapsedMs(run, Date.now()))
            )}
          </span>
          <span>{` · ${pluralize(run.agents.length, "agent")}`}</span>
          {run.totalTokens > 0 ? (
            <span>{` · ${formatWorkflowTokens(run.totalTokens)}`}</span>
          ) : null}
          {run.totalToolCalls > 0 ? (
            <span>{` · ${pluralize(run.totalToolCalls, "step")}`}</span>
          ) : null}
        </div>
        {subtitle ? (
          <p className="mt-0.5 line-clamp-2 pl-8 text-[12px] text-muted-foreground">{subtitle}</p>
        ) : null}
        {run.status !== "running" && run.status !== "completed" && run.summary ? (
          <p className="mt-0.5 line-clamp-2 pl-8 text-[12px] text-destructive">{run.summary}</p>
        ) : null}
      </div>
      <div
        role="tablist"
        aria-label="Workflow views"
        className="flex shrink-0 gap-4 border-b border-border px-3"
      >
        {TABS.map((tab) => {
          const active = selection.tab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              className={cn(
                "-mb-px border-b-2 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-ring",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => select({ tab: tab.id, agentId: null })}
              onKeyDown={moveBetweenTabs}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {selection.tab === "agents" ? (
          agent ? (
            <AgentDetail
              environmentId={environmentId}
              threadId={threadId}
              run={run}
              agent={agent}
              cwd={cwd}
              onBack={() => select({ agentId: null })}
            />
          ) : (
            <AgentList run={run} onOpenAgent={openAgent} />
          )
        ) : null}
        {selection.tab === "timeline" ? (
          <WorkflowRunTimeline run={run} onOpenAgent={openAgent} />
        ) : null}
        {selection.tab === "script" || selection.tab === "result" ? (
          <WorkflowRunFileView
            environmentId={environmentId}
            threadId={threadId}
            run={run}
            file={selection.tab}
            cwd={cwd}
          />
        ) : null}
      </div>
      {!running && !run.hiddenScript ? (
        <WorkflowSaveDialog
          open={saveOpen}
          onOpenChange={onSaveOpenChange}
          environmentId={environmentId}
          threadId={threadId}
          taskId={run.taskId}
        />
      ) : null}
    </section>
  );
}
