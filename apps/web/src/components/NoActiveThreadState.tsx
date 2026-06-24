import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, SearchIcon, SquarePenIcon, FolderPlusIcon } from "lucide-react";
import type * as React from "react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewThreadFromContext,
  startNewThreadInProjectFromContext,
} from "../lib/chatThreadActions";
import { sortThreads } from "../lib/threadSort";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ProjectFavicon } from "./ProjectFavicon";
import { resolveSidebarNewThreadEnvMode } from "./Sidebar.logic";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty";
import { Group } from "./ui/group";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { SidebarInset, SidebarOpenTrigger } from "./ui/sidebar";
import { useSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

const RECENT_THREAD_LIMIT = 3;

function riseDelay(delay: string): React.CSSProperties {
  return { "--no-thread-delay": delay } as React.CSSProperties;
}

/* Decorative thread graph: branches draw themselves in, commits surface
   left-to-right, and the one still-open branch ends on a live accent node. */
function ThreadlinesFigure() {
  return (
    <div aria-hidden="true" className="no-thread-rise relative mb-7" style={riseDelay("0.05s")}>
      <div className="pointer-events-none absolute -inset-x-14 -inset-y-8 rounded-full bg-primary-graph/[0.05] blur-2xl dark:bg-primary-graph/[0.07]" />
      <svg className="relative h-auto w-[300px] sm:w-[336px]" fill="none" viewBox="0 0 360 120">
        <defs>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id="no-thread-live-stroke"
            x1="150"
            x2="300"
            y1="62"
            y2="90"
          >
            <stop offset="0" stopColor="var(--muted-foreground)" stopOpacity="0.4" />
            <stop offset="1" stopColor="var(--primary-graph)" stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <g strokeLinecap="round" strokeWidth="1.25">
          <path
            className="no-thread-line text-muted-foreground/45"
            d="M 16 62 L 344 62"
            pathLength={1}
            stroke="currentColor"
            style={riseDelay("0.3s")}
          />
          <path
            className="no-thread-line text-muted-foreground/35"
            d="M 96 62 C 118 62 118 34 140 34 L 224 34 C 246 34 246 62 268 62"
            pathLength={1}
            stroke="currentColor"
            style={{ ...riseDelay("0.75s"), animationDuration: "0.7s" }}
          />
          <path
            className="no-thread-line"
            d="M 150 62 C 172 62 172 90 194 90 L 296 90"
            pathLength={1}
            stroke="url(#no-thread-live-stroke)"
            style={{ ...riseDelay("0.95s"), animationDuration: "0.7s" }}
          />
        </g>
        <g fill="currentColor">
          <circle
            className="no-thread-node text-muted-foreground/40"
            cx="44"
            cy="62"
            r="2"
            style={riseDelay("0.5s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx="96"
            cy="62"
            r="2.5"
            style={riseDelay("0.65s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx="150"
            cy="62"
            r="2.5"
            style={riseDelay("0.8s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/40"
            cx="182"
            cy="34"
            r="2"
            style={riseDelay("1.15s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/40"
            cx="322"
            cy="62"
            r="2"
            style={riseDelay("1.25s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx="268"
            cy="62"
            r="2.5"
            style={riseDelay("1.35s")}
          />
        </g>
        <circle
          className="no-thread-halo text-primary-graph"
          cx="300"
          cy="90"
          fill="currentColor"
          r="5"
        />
        <circle
          className="no-thread-node text-primary-graph"
          cx="300"
          cy="90"
          fill="currentColor"
          r="3"
          style={riseDelay("1.5s")}
        />
      </svg>
    </div>
  );
}

export function NoActiveThreadState() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, orderedProjects } =
    useHandleNewThread();
  const appSettings = useSettings();
  const navigate = useNavigate();
  const setCommandPaletteOpen = useCommandPaletteStore((store) => store.setOpen);
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));

  const recentThreads = useMemo(
    () =>
      sortThreads(
        threads.filter((thread) => thread.archivedAt === null),
        appSettings.sidebarThreadSortOrder,
      ).slice(0, RECENT_THREAD_LIMIT),
    [appSettings.sidebarThreadSortOrder, threads],
  );
  const projectTitleById = useMemo(
    () => new Map(orderedProjects.map((project) => [project.id, project.name])),
    [orderedProjects],
  );

  const hasProject = defaultProjectRef !== null;
  const defaultProjectName = orderedProjects[0]?.name ?? null;

  const newThreadActionContext = {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
      defaultEnvMode: appSettings.defaultThreadEnvMode,
    }),
    handleNewThread,
  };
  const handleNewThreadClick = () => {
    void startNewThreadFromContext(newThreadActionContext);
  };
  const handleNewThreadInProject = (project: (typeof orderedProjects)[number]) => {
    void startNewThreadInProjectFromContext(
      newThreadActionContext,
      scopeProjectRef(project.environmentId, project.id),
    );
  };
  const handleOpenThread = (thread: (typeof recentThreads)[number]) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron
              ? cn(
                  "drag-region flex items-center wco:h-[env(titlebar-area-height)]",
                  ELECTRON_HEADER_HEIGHT_CLASS,
                )
              : "py-2 sm:py-3",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron ? (
            <div className="flex items-center gap-2">
              <SidebarOpenTrigger className="size-7 shrink-0" />
              <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
                No active thread
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarOpenTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1 gap-0 overflow-y-auto">
          <div className="flex w-full max-w-md flex-col items-center">
            <ThreadlinesFigure />

            <EmptyTitle
              className="no-thread-rise text-foreground text-xl tracking-tight"
              style={riseDelay("0.16s")}
            >
              {hasProject ? "Pick up a thread" : "Start your first thread"}
            </EmptyTitle>
            <EmptyDescription
              className="no-thread-rise mt-2 text-sm text-muted-foreground/78"
              style={riseDelay("0.24s")}
            >
              {hasProject
                ? recentThreads.length > 0
                  ? "Jump back in, or start something new."
                  : "Resume one from the sidebar, or start fresh."
                : "Add a project to begin."}
            </EmptyDescription>

            <div
              className="no-thread-rise mt-7 flex flex-wrap items-center justify-center gap-2.5"
              style={riseDelay("0.34s")}
            >
              {hasProject ? (
                <Group aria-label="New thread">
                  <Button
                    data-testid="no-thread-new-thread-button"
                    onClick={handleNewThreadClick}
                    size="sm"
                    variant="outline"
                  >
                    <SquarePenIcon />
                    <span className="flex items-baseline gap-1">
                      New thread
                      {defaultProjectName ? (
                        <span className="text-muted-foreground">
                          in{" "}
                          <span className="inline-block max-w-32 truncate align-bottom font-medium text-foreground">
                            {defaultProjectName}
                          </span>
                        </span>
                      ) : null}
                    </span>
                  </Button>
                  {orderedProjects.length > 1 ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            aria-label="Choose a project for the new thread"
                            data-testid="no-thread-project-picker-trigger"
                            size="icon-sm"
                            variant="outline"
                          />
                        }
                      >
                        <ChevronDownIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuGroup>
                          <MenuGroupLabel>New thread in…</MenuGroupLabel>
                          {orderedProjects.map((project) => (
                            <MenuItem
                              key={`${project.environmentId}:${project.id}`}
                              onClick={() => handleNewThreadInProject(project)}
                              title={project.cwd}
                            >
                              <ProjectFavicon
                                cwd={project.cwd}
                                environmentId={project.environmentId}
                              />
                              <span className="max-w-56 truncate">{project.name}</span>
                            </MenuItem>
                          ))}
                        </MenuGroup>
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </Group>
              ) : (
                <Button
                  data-testid="no-thread-add-project-button"
                  onClick={openAddProject}
                  size="sm"
                  variant="outline"
                >
                  <FolderPlusIcon />
                  Add a project
                </Button>
              )}
              <Button
                className="text-muted-foreground hover:text-foreground"
                data-testid="no-thread-search-button"
                onClick={() => setCommandPaletteOpen(true)}
                size="sm"
                variant="ghost"
              >
                <SearchIcon />
                Search
              </Button>
            </div>

            {recentThreads.length > 0 ? (
              <div className="no-thread-rise mt-10 w-full max-w-sm" style={riseDelay("0.46s")}>
                <div className="mb-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
                  Recent threads
                </div>
                <div className="flex flex-col gap-0.5">
                  {recentThreads.map((thread) => (
                    <button
                      className="group flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                      data-testid="no-thread-recent-thread"
                      key={`${thread.environmentId}:${thread.id}`}
                      onClick={() => handleOpenThread(thread)}
                      type="button"
                    >
                      <ThreadRowLeadingStatus thread={thread} />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                        {thread.title}
                      </span>
                      {projectTitleById.get(thread.projectId) ? (
                        <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground/60">
                          {projectTitleById.get(thread.projectId)}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/50">
                        {formatRelativeTimeLabel(
                          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
