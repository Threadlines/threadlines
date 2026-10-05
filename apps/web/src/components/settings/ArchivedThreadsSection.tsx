import { ArchiveIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import type { EnvironmentId, OrchestrationShellSnapshot, ProjectId } from "@threadlines/contracts";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SETTINGS_GROUP_ROW_CLASS, SettingsRow, SettingsSection } from "./settingsLayout";
import { ARCHIVED_THREADS_PAGE_SIZE, filterArchivedThreads } from "./SettingsPanels.logic";

export interface ArchivedThreadProject {
  /** `${environmentId}:${projectId}`; project ids are only unique within an environment. */
  readonly key: string;
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly cwd: string;
}

export type ArchivedThreadItem = OrchestrationShellSnapshot["threads"][number] & {
  readonly environmentId: EnvironmentId;
  readonly project: ArchivedThreadProject;
};

const ALL_PROJECTS_VALUE = "all";

function ArchivedThreadsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading archived threads"
      data-testid="archived-threads-skeleton"
    >
      <div aria-hidden="true">
        {["w-40", "w-52", "w-36"].map((titleWidth) => (
          <div
            key={titleWidth}
            className="flex items-center gap-3 border-t border-group-divider px-4 py-2.5 first:border-t-0 sm:px-5"
          >
            <Skeleton className={`h-3.5 max-w-full rounded-full ${titleWidth}`} />
            <Skeleton className="ml-auto h-3 w-24 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The archive list on Settings > Archive: one list, newest archive first, narrowed by a
 * search box and a project picker, and capped with a "Show more" row so it never grows
 * into an endless scroll.
 */
export function ArchivedThreadsSection({
  threads,
  isLoading,
  error,
  onUnarchive,
  onDelete,
  onContextMenu,
}: {
  readonly threads: ReadonlyArray<ArchivedThreadItem>;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onUnarchive: (thread: ArchivedThreadItem) => void;
  readonly onDelete: (thread: ArchivedThreadItem) => void;
  readonly onContextMenu: (thread: ArchivedThreadItem, position: { x: number; y: number }) => void;
}) {
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(ARCHIVED_THREADS_PAGE_SIZE);

  const projectOptions = useMemo(() => {
    const countsByKey = new Map<string, { project: ArchivedThreadProject; count: number }>();
    for (const thread of threads) {
      const entry = countsByKey.get(thread.project.key);
      countsByKey.set(thread.project.key, {
        project: thread.project,
        count: (entry?.count ?? 0) + 1,
      });
    }
    return [...countsByKey.values()].toSorted((left, right) =>
      left.project.name.localeCompare(right.project.name),
    );
  }, [threads]);
  // Falls back to all projects once the picked project has no archived threads left.
  const selectedProject =
    projectOptions.find((option) => option.project.key === projectKey)?.project ?? null;
  const filteredThreads = useMemo(
    () => filterArchivedThreads(threads, { query, projectKey: selectedProject?.key ?? null }),
    [query, selectedProject, threads],
  );
  const visibleThreads = filteredThreads.slice(0, visibleCount);
  const hiddenCount = filteredThreads.length - visibleThreads.length;
  const isFiltered = query.trim().length > 0 || selectedProject !== null;

  const updateQuery = (next: string) => {
    setQuery(next);
    setVisibleCount(ARCHIVED_THREADS_PAGE_SIZE);
  };

  return (
    <SettingsSection
      title="Archived threads"
      headerAction={
        threads.length > 0 ? (
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {isFiltered ? `${filteredThreads.length} of ${threads.length}` : threads.length}
          </span>
        ) : null
      }
    >
      {threads.length === 0 ? (
        isLoading ? (
          <ArchivedThreadsSkeleton />
        ) : (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <ArchiveIcon className="size-3.5 text-muted-foreground" />
                {error ? "Could not load archived threads" : "No archived threads"}
              </span>
            }
            description={error ?? "Archived threads will appear here."}
          />
        )
      ) : (
        <>
          <div className="flex items-center gap-2 py-1.5 pr-2 pl-3.5">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(event) => updateQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query.length > 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  updateQuery("");
                }
              }}
              placeholder="Search archived threads"
              aria-label="Search archived threads"
              className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query.length > 0 ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                onClick={() => updateQuery("")}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
            {projectOptions.length > 1 ? (
              <Select
                value={selectedProject?.key ?? ALL_PROJECTS_VALUE}
                onValueChange={(value) => {
                  setProjectKey(value === null || value === ALL_PROJECTS_VALUE ? null : value);
                  setVisibleCount(ARCHIVED_THREADS_PAGE_SIZE);
                }}
              >
                <SelectTrigger
                  variant="ghost"
                  size="xs"
                  className="w-auto max-w-48 shrink-0"
                  aria-label="Filter archived threads by project"
                >
                  <SelectValue>{selectedProject?.name ?? "All projects"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} popupClassName="max-w-72">
                  <SelectItem value={ALL_PROJECTS_VALUE}>
                    <span className="flex items-center gap-3">
                      <span className="flex-1">All projects</span>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {threads.length}
                      </span>
                    </span>
                  </SelectItem>
                  {projectOptions.map(({ project, count }) => (
                    <SelectItem key={project.key} value={project.key}>
                      <span className="flex min-w-0 items-center gap-2">
                        <ProjectFavicon
                          environmentId={project.environmentId}
                          cwd={project.cwd}
                          name={project.name}
                        />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        <span className="ml-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                          {count}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
          {visibleThreads.length === 0 ? (
            <div
              className={cn(
                SETTINGS_GROUP_ROW_CLASS,
                "px-3.5 py-3 text-[12.5px] text-muted-foreground",
              )}
            >
              No archived threads match this search.
            </div>
          ) : (
            visibleThreads.map((thread) => (
              <div
                key={`${thread.environmentId}:${thread.id}`}
                className={cn(
                  SETTINGS_GROUP_ROW_CLASS,
                  "group/archived-row flex min-h-10 items-center gap-3 py-1.5 pr-3.5 pl-3.5 pointer-coarse:pr-2",
                )}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextMenu(thread, { x: event.clientX, y: event.clientY });
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {thread.title}
                </span>
                {/* The date and the hover actions share one cell, sized to the wider
                    of the two, so the actions never cover the title. Touch shows
                    both, side by side. */}
                <div className="grid shrink-0 items-center justify-items-end pointer-coarse:flex pointer-coarse:gap-2">
                  <span className="col-start-1 row-start-1 flex items-center gap-1 text-[11px] text-muted-foreground transition-opacity group-hover/archived-row:opacity-0 group-focus-within/archived-row:opacity-0 pointer-coarse:opacity-100">
                    {selectedProject === null ? (
                      <>
                        <ProjectFavicon
                          environmentId={thread.project.environmentId}
                          cwd={thread.project.cwd}
                          name={thread.project.name}
                        />
                        <span>{thread.project.name} ·</span>
                      </>
                    ) : null}
                    <span>{formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}</span>
                  </span>
                  <div className="col-start-1 row-start-1 -me-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/archived-row:opacity-100 group-focus-within/archived-row:opacity-100 pointer-coarse:opacity-100">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      aria-label={`Unarchive ${thread.title}`}
                      onClick={() => onUnarchive(thread)}
                    >
                      Unarchive
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="size-6 text-muted-foreground hover:text-destructive-foreground"
                            aria-label={`Delete archived thread ${thread.title}`}
                            onClick={() => onDelete(thread)}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Delete thread</TooltipPopup>
                    </Tooltip>
                  </div>
                </div>
              </div>
            ))
          )}
          {hiddenCount > 0 ? (
            <button
              type="button"
              className={cn(
                SETTINGS_GROUP_ROW_CLASS,
                "w-full cursor-pointer px-3.5 py-2 text-center text-[12.5px] text-muted-foreground transition-colors hover:text-foreground focus-ring",
              )}
              onClick={() => setVisibleCount((count) => count + ARCHIVED_THREADS_PAGE_SIZE)}
            >
              Show {Math.min(hiddenCount, ARCHIVED_THREADS_PAGE_SIZE)} more
            </button>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
