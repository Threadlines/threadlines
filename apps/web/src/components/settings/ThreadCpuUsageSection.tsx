import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  TERMINALS_PAGE_THREAD_ID,
  type EnvironmentId,
  type ServerThreadCpuUsageGroup,
  type ServerThreadCpuUsageResult,
} from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { formatBytes } from "../../lib/formatBytes";
import { usePageInUse } from "../../lib/pageAttention";
import { ensureLocalApi } from "../../localApi";
import { selectProjectByRef, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getDriverOption } from "./providerDriverMeta";
import { SettingsSection } from "./settingsLayout";

/** How often the section asks while it is on screen and the window is in use. */
const REFRESH_MS = 5_000;

const groupId = (group: ServerThreadCpuUsageGroup) =>
  group.kind === "thread"
    ? `thread:${group.threadId}`
    : group.kind === "shared"
      ? `shared:${group.provider}`
      : "threadlines";

/**
 * Busiest over the last minute first. The minute's average moves slowly, so
 * rows keep their places between refreshes unless one really overtakes
 * another; the latest instant value never reorders them.
 */
export function orderThreadCpuGroups(
  groups: ReadonlyArray<ServerThreadCpuUsageGroup>,
): ReadonlyArray<ServerThreadCpuUsageGroup> {
  return groups.toSorted(
    (left, right) =>
      right.avgCpuPercent - left.avgCpuPercent || groupId(left).localeCompare(groupId(right)),
  );
}

/** The command's program name: `/usr/bin/node build.js` reads `node`. */
function programName(command: string): string {
  const first =
    command
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^['"]|['"]$/g, "") ?? command;
  return first.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? first;
}

const formatCpu = (percent: number) => `${Math.round(percent)}%`;
const formatCores = (percent: number) => (percent / 100).toFixed(1);

function useThreadCpuUsage(active: boolean, refreshMs: number) {
  const [state, setState] = useState<{
    readonly data: ServerThreadCpuUsageResult | null;
    readonly error: string | null;
  }>({ data: null, error: null });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      ensureLocalApi()
        .server.getThreadCpuUsage()
        .then(
          (data) => {
            if (!cancelled) setState({ data, error: null });
          },
          (error: unknown) => {
            if (cancelled) return;
            setState((current) => ({
              data: current.data,
              error: error instanceof Error ? error.message : "Couldn't read CPU use.",
            }));
          },
        )
        .finally(() => {
          if (!cancelled) timer = setTimeout(read, refreshMs);
        });
    };
    read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, refreshMs]);
  return state;
}

/**
 * Whether `element` is on screen: false until the browser says so, true
 * where it can't tell.
 */
function useOnScreen(element: HTMLElement | null): boolean {
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return onScreen;
}

function GroupName({
  group,
  environmentId,
}: {
  group: ServerThreadCpuUsageGroup;
  environmentId: EnvironmentId | null;
}) {
  const navigate = useNavigate();
  const threadRef =
    group.kind === "thread" && environmentId !== null
      ? scopeThreadRef(environmentId, group.threadId)
      : null;
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef));
  const project = useStore((state) =>
    thread
      ? selectProjectByRef(state, {
          environmentId: thread.environmentId,
          projectId: thread.projectId,
        })
      : undefined,
  );

  if (group.kind === "threadlines") {
    return <span className="truncate font-medium text-foreground">Threadlines</span>;
  }
  if (group.kind === "shared") {
    const name = getDriverOption(group.provider)?.label ?? group.provider;
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="truncate text-muted-foreground">Shared by all its threads</span>
      </span>
    );
  }
  if (group.threadId === TERMINALS_PAGE_THREAD_ID) {
    return <span className="truncate font-medium text-foreground">Terminals page</span>;
  }
  if (!thread || !threadRef) {
    return (
      <span className="truncate font-medium text-muted-foreground">A thread not listed here</span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <button
        type="button"
        className="min-w-0 truncate text-left font-medium text-foreground hover:text-primary"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          })
        }
      >
        {thread.title}
      </button>
      {project ? <span className="truncate text-muted-foreground">{project.name}</span> : null}
    </span>
  );
}

function GroupRow({
  group,
  environmentId,
  expanded,
  onToggle,
}: {
  group: ServerThreadCpuUsageGroup;
  environmentId: EnvironmentId | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const busiest = group.topProcesses[0];
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li data-testid="thread-cpu-row" data-group={groupId(group)}>
      <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_3.5rem_4.5rem] items-center gap-x-2 px-3 py-2 text-[13px] sm:px-4">
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:invisible"
          aria-label={expanded ? "Hide its processes" : "Show its processes"}
          aria-expanded={expanded}
          disabled={group.topProcesses.length === 0}
          onClick={onToggle}
        >
          <Chevron className="size-3.5" />
        </button>
        <div className="flex min-w-0 flex-col">
          <GroupName group={group} environmentId={environmentId} />
          {busiest ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {programName(busiest.command)}
              {group.processCount > 1 ? ` + ${group.processCount - 1} more` : ""}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">Ended</span>
          )}
        </div>
        <span className="text-right font-mono tabular-nums text-foreground">
          {formatCpu(group.avgCpuPercent)}
        </span>
        <span className="text-right font-mono tabular-nums text-muted-foreground">
          {formatCpu(group.cpuPercent)}
        </span>
        <span className="text-right font-mono tabular-nums text-muted-foreground">
          {group.rssBytes > 0 ? formatBytes(group.rssBytes) : "–"}
        </span>
      </div>
      {expanded ? (
        <ul className="pb-2">
          {group.topProcesses.map((process) => (
            <li
              key={process.pid}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_3.5rem_4.5rem] items-center gap-x-2 px-3 py-1 text-xs sm:px-4"
            >
              <span aria-hidden="true" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="truncate pl-2 font-mono text-[11px] text-muted-foreground">
                      {process.command}
                    </span>
                  }
                />
                <TooltipPopup
                  side="top"
                  className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
                >
                  {process.command} (pid {process.pid})
                </TooltipPopup>
              </Tooltip>
              <span aria-hidden="true" />
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatCpu(process.cpuPercent)}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(process.rssBytes)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * CPU by thread, at the top of Settings > Diagnostics: where this computer's
 * CPU goes, by thread. Asks the server every few seconds only while it is on
 * screen and someone is using the window, so the server's sampler winds down
 * when nobody looks.
 */
export function ThreadCpuUsageSection({
  refreshMs = REFRESH_MS,
}: {
  /** How often to ask; tests shorten it. */
  refreshMs?: number;
} = {}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const onScreen = useOnScreen(element);
  // In use, not just in front: a window left focused in front of an empty
  // chair would otherwise keep the server's sampler going for hours.
  const inUse = usePageInUse();
  const { data, error } = useThreadCpuUsage(onScreen && inUse, refreshMs);
  const environmentId = usePrimaryEnvironmentId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const groups = data ? orderThreadCpuGroups(data.groups) : [];
  const ownCores = groups.reduce((total, group) => total + group.cpuPercent, 0);
  const serverError = data ? (Option.getOrNull(data.error)?.message ?? null) : null;
  const summary = data
    ? data.machineCpuPercent === null
      ? `Measuring. This computer has ${data.coreCount} cores.`
      : `${formatCores(data.machineCpuPercent)} of ${data.coreCount} cores busy, ${formatCores(ownCores)} of them from Threadlines and its agents.`
    : null;

  return (
    <SettingsSection
      place="diagnostics.cpuByThread"
      description={summary ?? "Which threads are using this computer's CPU, over the last minute."}
    >
      <div ref={setElement}>
        {error !== null || serverError !== null ? (
          <div className="px-4 pt-3 text-xs text-destructive sm:px-5" role="alert">
            {serverError ?? error}
          </div>
        ) : null}
        {data === null ? (
          <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
            {error === null ? "Reading processes…" : null}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
            Nothing measured yet.
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_3.5rem_4.5rem] gap-x-2 border-b border-group-divider px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground sm:px-4">
              <span aria-hidden="true" />
              <span className="font-semibold">Where</span>
              <Tooltip>
                <TooltipTrigger
                  render={<span className="text-right font-semibold">1&nbsp;min</span>}
                />
                <TooltipPopup side="top">
                  Average over the last minute. 100% is one full core.
                </TooltipPopup>
              </Tooltip>
              <span className="text-right font-semibold">Now</span>
              <span className="text-right font-semibold">Memory</span>
            </div>
            <ul className="divide-y divide-border/60">
              {groups.map((group) => {
                const id = groupId(group);
                return (
                  <GroupRow
                    key={id}
                    group={group}
                    environmentId={environmentId}
                    expanded={expanded.has(id)}
                    onToggle={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (!next.delete(id)) next.add(id);
                        return next;
                      })
                    }
                  />
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
