/**
 * The workflow view's Timeline tab: one bar per agent across the run, grouped
 * by phase, so it shows what ran at once, what waited, and which agent the
 * run's end waited on. While the run goes on it redraws every few seconds
 * (discrete steps, not an animation).
 */
import type { OrchestrationWorkflowRun } from "@threadlines/contracts";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { formatDuration } from "../../session-logic";
import { workflowAgentDisplayState, workflowTimelineLayout } from "./workflowRunView";

const LIVE_REDRAW_MS = 5_000;

export function WorkflowRunTimeline({
  run,
  onOpenAgent,
}: {
  readonly run: OrchestrationWorkflowRun;
  readonly onOpenAgent: (agentId: string) => void;
}) {
  const running = run.status === "running";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowMs(Date.now()), LIVE_REDRAW_MS);
    return () => clearInterval(id);
  }, [running]);
  const layout = useMemo(() => workflowTimelineLayout(run, nowMs), [run, nowMs]);
  const hasBars = layout.groups.some((group) => group.bars.length > 0);

  if (!hasBars) {
    return <p className="px-3 py-6 text-[12px] text-muted-foreground">No agent has started yet.</p>;
  }

  return (
    <div className="px-3 py-3 text-[12px]" data-workflow-timeline="true">
      {layout.groups.map((group) =>
        group.bars.length === 0 ? null : (
          <div key={group.key} className="mb-2">
            <div className="pb-1 text-[11.5px] font-semibold text-muted-foreground">
              {group.title}
            </div>
            {group.bars.map((bar) => {
              const state = workflowAgentDisplayState(bar.agent);
              const label = `${bar.agent.label}: ${state}${
                bar.durationMs !== null ? `, ${formatDuration(bar.durationMs)}` : ""
              }`;
              return (
                <button
                  key={bar.agent.index}
                  type="button"
                  disabled={!bar.agent.agentId}
                  className="grid h-[22px] w-full min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-2 rounded-sm text-left outline-none focus-ring enabled:hover:bg-foreground/[0.03]"
                  title={label}
                  aria-label={label}
                  onClick={() => bar.agent.agentId && onOpenAgent(bar.agent.agentId)}
                >
                  <span className="truncate text-foreground/80">{bar.agent.label}</span>
                  <span className="relative h-2.5">
                    {bar.waitLeft !== null && bar.waitWidth !== null ? (
                      <span
                        aria-hidden="true"
                        className="absolute top-1 h-px border-t border-dashed border-muted-foreground/40"
                        style={{ left: `${bar.waitLeft}%`, width: `${bar.waitWidth}%` }}
                      />
                    ) : null}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute top-0 h-2.5 rounded-[3px]",
                        state === "running" && "bg-primary-graph",
                        state === "retrying" && "bg-amber-500",
                        state === "failed" && "bg-destructive/70",
                        state === "skipped" && "bg-foreground/15",
                        state === "done" && "bg-foreground/30",
                      )}
                      style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        ),
      )}
      <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-2">
        <span />
        <span className="relative mt-1 h-4 border-t border-border">
          {layout.ticks.map((tick) => (
            <span
              key={tick.label}
              className="absolute top-0.5 font-mono text-[10.5px] text-muted-foreground tabular-nums"
              style={{
                left: `${tick.at}%`,
                transform: tick.at === 0 ? undefined : "translateX(-50%)",
              }}
            >
              {tick.label}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
