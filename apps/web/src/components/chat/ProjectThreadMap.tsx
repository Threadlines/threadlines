import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { PULL_REQUEST_SETTLED_LIST_LIMIT, type ScopedProjectRef } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import {
  PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
  usePullRequestLists,
} from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  formatPullRequestSelection,
  linkThreadsToPullRequests,
  pullRequestEntryKey,
  pullRequestRepositoryScope,
  pullRequestsOnProjectRepositories,
  type PullRequestEntry,
} from "../pull-requests/pullRequests.logic";
import { mergeThreadLastSeenAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { riseDelay } from "../ThreadlinesFigure";
import { TooltipWrapper } from "../ui/tooltip";
import {
  deriveThreadMapLanes,
  deriveThreadMapMerges,
  formatThreadMapCaption,
  layoutThreadMap,
  type ThreadMapGroup,
  type ThreadMapLane,
  type ThreadMapRect,
  type ThreadMapTone,
} from "./ProjectThreadMap.logic";

/** The sidebar's status-dot colours, as text colour so SVG can draw with them. */
const TONE_CLASS: Readonly<Record<ThreadMapTone, string>> = {
  amber: "text-amber-500 dark:text-amber-300/90",
  red: "text-red-500 dark:text-red-400/90",
  violet: "text-violet-500 dark:text-violet-300/90",
  blue: "text-primary-graph",
  cyan: "text-cyan-500 dark:text-cyan-300/90",
  emerald: "text-emerald-500 dark:text-emerald-300/90",
};

const CAPTION_DOT_CLASS: Readonly<Record<ThreadMapGroup | "merged", string>> = {
  working: "bg-primary-graph",
  needsYou: "border-[1.5px] border-amber-500 dark:border-amber-300/90",
  finished: "bg-emerald-500 dark:bg-emerald-300/90",
  merged: "bg-violet-500 dark:bg-violet-300/90",
};

/** How often the week-long merge window is re-read against the clock. */
const MERGE_WINDOW_CLOCK_INTERVAL_MS = 60_000;

interface MapLane extends ThreadMapLane {
  readonly thread: SidebarThreadSummary;
}

interface MapLoop {
  readonly key: string;
  readonly entry: PullRequestEntry;
  /** The thread that was working this pull request, when one still is on record. */
  readonly thread: SidebarThreadSummary | null;
}

/**
 * What the map draws for one logical project: its threads that have a status
 * to show, and the pull requests that landed on its repository this week.
 */
function useProjectThreadMap(memberProjectRefs: readonly ScopedProjectRef[]) {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const seenThreadOverlays = useUiStateStore((store) => store.seenThreadOverlays);
  const threadSeedVisitedAtById = useUiStateStore((store) => store.threadSeedVisitedAtById);
  // Read, never fetched. The sidebar owns this listing and keeps it current on
  // its own slow poll; a second fetching observer here would re-run the host
  // tool across every repository each time a new thread is opened.
  const mergedPullRequests = usePullRequestLists({
    state: "merged",
    refetchIntervalMs: PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
    enabled: false,
  });
  const mergedKnown = !mergedPullRequests.isPending && !mergedPullRequests.isUnavailable;
  const mergedEntries = mergedPullRequests.entries;
  // "This week" moves, slowly: a merge ages out of the window on its own.
  const nowMs = useRelativeTimeTick(MERGE_WINDOW_CLOCK_INTERVAL_MS);

  return useMemo(() => {
    const memberKeys = new Set(memberProjectRefs.map(scopedProjectKey));
    const isMember = (item: Pick<SidebarThreadSummary, "environmentId" | "projectId">) =>
      memberKeys.has(scopedProjectKey(scopeProjectRef(item.environmentId, item.projectId)));
    const projectThreads = threads.filter(isMember);
    const threadByKey = new Map<string, SidebarThreadSummary>();
    const inputs = projectThreads.flatMap((thread) => {
      if (thread.archivedAt !== null) return [];
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      threadByKey.set(key, thread);
      // The same read state the sidebar merges, or finished work the user has
      // already looked at would come back as unread here.
      const lastVisitedAt = mergeThreadLastSeenAt({
        overlayAt: seenThreadOverlays[key]?.at,
        serverLastSeenAt: thread.lastSeenAt,
        seedAt: threadSeedVisitedAtById[key],
      });
      return [
        {
          key,
          title: thread.title,
          createdAt: thread.createdAt,
          activityAt: thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
          statusLabel:
            resolveThreadStatusPill({
              thread: { ...thread, ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}) },
            })?.label ?? null,
        },
      ];
    });
    const { lanes, counts } = deriveThreadMapLanes(inputs);

    const memberProjects = projects.filter((project) =>
      memberKeys.has(scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
    );
    const scopedMerges = mergedKnown
      ? pullRequestsOnProjectRepositories(mergedEntries, memberProjects)
      : [];
    const merges = deriveThreadMapMerges({
      entries: scopedMerges.map((entry) => ({
        key: pullRequestEntryKey(entry),
        repositoryScope: pullRequestRepositoryScope(entry),
        settledAt: entry.settledAt,
        entry,
      })),
      nowMs,
      listLimit: PULL_REQUEST_SETTLED_LIST_LIMIT,
    });
    // Looked up across every thread of the project, wrapped ones included: the
    // thread whose pull request merged is usually the one that got filed away.
    const threadsByPullRequest = linkThreadsToPullRequests(
      merges.loops.map((loop) => loop.entry),
      projectThreads,
      memberProjects,
    );

    return {
      hasAnyThread: projectThreads.length > 0,
      lanes: lanes.flatMap((lane): MapLane[] => {
        const thread = threadByKey.get(lane.key);
        return thread ? [{ ...lane, thread }] : [];
      }),
      loops: merges.loops.map((loop): MapLoop => ({
        key: loop.key,
        entry: loop.entry,
        thread: threadsByPullRequest.get(loop.key)?.[0] ?? null,
      })),
      caption: formatThreadMapCaption({
        hasAnyThread: projectThreads.length > 0,
        counts,
        merged: mergedKnown ? { count: merges.count, countIsFloor: merges.countIsFloor } : null,
      }),
    };
  }, [
    memberProjectRefs,
    mergedEntries,
    mergedKnown,
    nowMs,
    projects,
    seenThreadOverlays,
    threadSeedVisitedAtById,
    threads,
  ]);
}

function hitStyle(rect: ThreadMapRect, width: number, height: number) {
  return {
    left: `${(rect.x / width) * 100}%`,
    top: `${(rect.y / height) * 100}%`,
    width: `${(rect.width / width) * 100}%`,
    height: `${(rect.height / height) * 100}%`,
  };
}

/**
 * The new-thread screen's drawing of the project being started in: the main
 * line, this week's merged pull requests looping above it, and a branch below
 * for each thread that is running, blocked or freshly finished. Each end is a
 * button that opens what it stands for. Draws itself in once and then holds
 * still.
 */
export function ProjectThreadMap({
  memberProjectRefs,
}: {
  memberProjectRefs: readonly ScopedProjectRef[];
}) {
  const navigate = useNavigate();
  const map = useProjectThreadMap(memberProjectRefs);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const gradientId = useId().replaceAll(":", "");
  const layout = useMemo(
    () => layoutThreadMap({ lanes: map.lanes, loops: map.loops }),
    [map.lanes, map.loops],
  );
  const laneByKey = new Map(map.lanes.map((lane) => [lane.key, lane] as const));
  const loopByKey = new Map(map.loops.map((loop) => [loop.key, loop] as const));

  const openThread = (thread: SidebarThreadSummary) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const hover = (key: string) => ({
    onPointerEnter: () => setActiveKey(key),
    onPointerLeave: () => setActiveKey((current) => (current === key ? null : current)),
    onFocus: () => setActiveKey(key),
    onBlur: () => setActiveKey((current) => (current === key ? null : current)),
  });

  return (
    <div
      className="no-thread-rise mb-6 flex w-full flex-col items-center"
      data-testid="project-thread-map"
      style={riseDelay("0.05s")}
    >
      <div
        className="relative w-full max-w-[340px]"
        style={{ aspectRatio: `${layout.width} / ${layout.height}` }}
      >
        <div className="pointer-events-none absolute -inset-x-14 -inset-y-8 rounded-full bg-primary-graph/[0.05] blur-2xl dark:bg-primary-graph/[0.07]" />
        <svg
          aria-hidden="true"
          className="relative block size-full overflow-visible"
          fill="none"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id={`${gradientId}-main`}
              x1="0"
              x2="80"
              y1="0"
              y2="0"
            >
              <stop offset="0" stopColor="var(--muted-foreground)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--muted-foreground)" stopOpacity="0.45" />
            </linearGradient>
            {layout.nextThread ? (
              <linearGradient
                gradientUnits="userSpaceOnUse"
                id={`${gradientId}-next`}
                x1={layout.nextThread.startX}
                x2={layout.nextThread.tip.x}
                y1="0"
                y2="0"
              >
                <stop offset="0" stopColor="var(--muted-foreground)" stopOpacity="0.4" />
                <stop offset="1" stopColor="var(--primary-graph)" stopOpacity="0.85" />
              </linearGradient>
            ) : null}
            {layout.lanes.map((lane, index) => {
              const tone = laneByKey.get(lane.key)?.tone;
              return tone ? (
                <linearGradient
                  gradientUnits="userSpaceOnUse"
                  // By position, not by key: a thread key carries a colon.
                  id={`${gradientId}-lane-${index}`}
                  key={lane.key}
                  x1={lane.startX}
                  x2={lane.tip.x}
                  y1="0"
                  y2="0"
                >
                  <stop offset="0" stopColor="var(--muted-foreground)" stopOpacity="0.35" />
                  <stop className={TONE_CLASS[tone]} offset="1" stopColor="currentColor" />
                </linearGradient>
              ) : null;
            })}
          </defs>
          <g strokeLinecap="round" strokeWidth="1.4">
            <path
              className="no-thread-line"
              d={layout.mainPath}
              pathLength={1}
              stroke={`url(#${gradientId}-main)`}
              style={riseDelay("0.2s")}
            />
            {layout.loops.map((loop, index) => (
              <path
                className="no-thread-line text-muted-foreground/35"
                d={loop.path}
                key={loop.key}
                pathLength={1}
                stroke="currentColor"
                strokeWidth={activeKey === loop.key ? 2 : 1.4}
                style={{ ...riseDelay(`${0.45 + index * 0.1}s`), animationDuration: "0.7s" }}
              />
            ))}
            {layout.nextThread ? (
              <path
                className="no-thread-line"
                d={layout.nextThread.path}
                pathLength={1}
                stroke={`url(#${gradientId}-next)`}
                style={{ ...riseDelay("0.75s"), animationDuration: "0.7s" }}
              />
            ) : null}
            {layout.lanes.map((lane, index) => {
              const group = laneByKey.get(lane.key)?.group;
              return (
                <path
                  className={cn(
                    "no-thread-line",
                    group === "finished" && "text-muted-foreground/35",
                  )}
                  d={lane.path}
                  key={lane.key}
                  pathLength={1}
                  stroke={
                    group === "finished" ? "currentColor" : `url(#${gradientId}-lane-${index})`
                  }
                  strokeWidth={activeKey === lane.key ? 2 : 1.4}
                  style={{ ...riseDelay(`${0.75 + index * 0.1}s`), animationDuration: "0.7s" }}
                />
              );
            })}
          </g>
          {layout.loops.map((loop, index) => (
            <circle
              className={cn("no-thread-node", TONE_CLASS.violet)}
              cx={loop.dot.x}
              cy={loop.dot.y}
              fill="currentColor"
              key={loop.key}
              r={activeKey === loop.key ? 3.4 : 2.6}
              style={riseDelay(`${0.9 + index * 0.1}s`)}
            />
          ))}
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx={layout.end.x}
            cy={layout.end.y}
            fill="currentColor"
            r="2.6"
            style={riseDelay("0.9s")}
          />
          {/* Nothing to draw yet: the branch the next thread will take, which
              is the app's mark. Decorative, and gone once a real thread has a
              lane. Its halo is the one repeating animation this screen has
              always had, on the figure this map replaces. */}
          {layout.nextThread ? (
            <>
              <circle
                className="no-thread-halo text-primary-graph"
                cx={layout.nextThread.tip.x}
                cy={layout.nextThread.tip.y}
                fill="currentColor"
                r="5"
              />
              <circle
                className="no-thread-node text-primary-graph"
                cx={layout.nextThread.tip.x}
                cy={layout.nextThread.tip.y}
                fill="currentColor"
                r="3"
                style={riseDelay("1.3s")}
              />
            </>
          ) : null}
          {layout.lanes.map((lane, index) => {
            const source = laneByKey.get(lane.key);
            if (!source) return null;
            const active = activeKey === lane.key;
            return (
              <g
                className={cn("no-thread-node", TONE_CLASS[source.tone])}
                key={lane.key}
                style={riseDelay(`${1.2 + index * 0.1}s`)}
              >
                {source.group === "working" ? (
                  <>
                    <circle
                      cx={lane.tip.x}
                      cy={lane.tip.y}
                      fill="currentColor"
                      opacity="0.18"
                      r={active ? 7.5 : 6}
                    />
                    <circle cx={lane.tip.x} cy={lane.tip.y} fill="currentColor" r="3.2" />
                  </>
                ) : source.group === "needsYou" ? (
                  <>
                    {active ? (
                      <circle
                        cx={lane.tip.x}
                        cy={lane.tip.y}
                        fill="currentColor"
                        opacity="0.16"
                        r="7"
                      />
                    ) : null}
                    <circle
                      cx={lane.tip.x}
                      cy={lane.tip.y}
                      fill="var(--background)"
                      r="3.8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                  </>
                ) : (
                  <circle
                    cx={lane.tip.x}
                    cy={lane.tip.y}
                    fill="currentColor"
                    r={active ? 3.8 : 3}
                  />
                )}
              </g>
            );
          })}
        </svg>
        {layout.loops.map((loop) => {
          const source = loopByKey.get(loop.key);
          if (!source) return null;
          const { entry, thread } = source;
          const landed = entry.settledAt
            ? `merged ${formatRelativeTimeLabel(entry.settledAt)}`
            : "merged";
          return (
            <TooltipWrapper
              key={loop.key}
              side="top"
              tooltip={
                <p>
                  <span className="font-mono text-muted-foreground">#{entry.number}</span>{" "}
                  {entry.title} <span className="text-muted-foreground">· {landed}</span>
                </p>
              }
            >
              <button
                aria-label={`Open ${thread ? thread.title : `pull request #${entry.number}`}, pull request #${entry.number} ${landed}`}
                className="absolute cursor-pointer rounded-sm focus-ring"
                data-testid="project-thread-map-merge"
                onClick={() => {
                  if (thread) {
                    openThread(thread);
                    return;
                  }
                  void navigate({
                    to: "/pull-requests",
                    search: {
                      state: "merged",
                      pr: formatPullRequestSelection({
                        environmentId: entry.environmentId,
                        projectId: entry.projectId,
                        repository: entry.repository,
                        number: entry.number,
                      }),
                    },
                  });
                }}
                style={hitStyle(loop.hit, layout.width, layout.height)}
                type="button"
                {...hover(loop.key)}
              />
            </TooltipWrapper>
          );
        })}
        {layout.lanes.map((lane) => {
          const source = laneByKey.get(lane.key);
          if (!source) return null;
          return (
            <TooltipWrapper
              key={lane.key}
              side="right"
              tooltip={
                <p>
                  {source.title}{" "}
                  <span className={TONE_CLASS[source.tone]}>
                    {source.statusLabel.toLowerCase()}
                  </span>
                </p>
              }
            >
              <button
                aria-label={`Open ${source.title}, ${source.statusLabel.toLowerCase()}`}
                className="absolute cursor-pointer rounded-sm focus-ring"
                data-testid="project-thread-map-thread"
                onClick={() => openThread(source.thread)}
                style={hitStyle(lane.hit, layout.width, layout.height)}
                type="button"
                {...hover(lane.key)}
              />
            </TooltipWrapper>
          );
        })}
      </div>
      <p className="mt-2 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {map.caption.map((part) => (
          <span className="inline-flex items-center gap-1.5" key={part.group}>
            {part.group === "none" ? null : (
              <span
                aria-hidden="true"
                className={cn("size-[7px] shrink-0 rounded-full", CAPTION_DOT_CLASS[part.group])}
              />
            )}
            {part.text}
          </span>
        ))}
      </p>
    </div>
  );
}
