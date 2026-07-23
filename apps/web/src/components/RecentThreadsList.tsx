import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { selectActiveAndRecentThreads } from "../lib/threadSort";
import {
  selectGeneralChatsProjectAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";

interface RecentThreadsListProps {
  limit?: number;
  testId: string;
  className?: string;
}

export function RecentThreadsList({ limit = 3, testId, className }: RecentThreadsListProps) {
  const navigate = useNavigate();
  const { orderedProjects } = useHandleNewThread();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const recentThreads = useMemo(
    () => selectActiveAndRecentThreads(threads, limit),
    [limit, threads],
  );
  const projectByScopedKey = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [orderedProjects],
  );

  if (recentThreads.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <div className="mb-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
        Active and recent
      </div>
      <div className="flex flex-col divide-y divide-border/50">
        {recentThreads.map((thread) => {
          const project = projectByScopedKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          );
          const isGeneralChat =
            generalChatsProject !== null &&
            thread.environmentId === generalChatsProject.environmentId &&
            thread.projectId === generalChatsProject.id;
          return (
            <button
              className="group flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              data-testid={testId}
              key={`${thread.environmentId}:${thread.id}`}
              onClick={() => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                });
              }}
              type="button"
            >
              <ThreadRowLeadingStatus thread={thread} />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                {thread.title}
              </span>
              {isGeneralChat ? (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground/60">
                  <MessagesSquareIcon className="size-3 shrink-0" />
                  General
                </span>
              ) : project ? (
                <span className="flex max-w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground/60">
                  <ProjectFavicon cwd={project.cwd} environmentId={project.environmentId} />
                  <span className="truncate">{project.name}</span>
                </span>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground/50">
                {formatRelativeTimeLabel(
                  thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
