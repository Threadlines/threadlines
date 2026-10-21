import type { ScheduledTask } from "@threadlines/contracts";
import { CalendarPlusIcon } from "lucide-react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { useScheduledTaskGroups } from "../../lib/scheduledTasksState";
import { cn } from "../../lib/utils";
import { ChromeIconButton, ChromeTooltip } from "../sidebar/ChromeIconButton";
import { DestinationListHeader } from "../sidebar/DestinationListHeader";
import { SidebarContent } from "../ui/sidebar";
import {
  describeNextRun,
  describeTaskSchedule,
  RUN_STATUS_DOT_CLASSES,
  RUN_STATUS_LABELS,
  taskRunStatus,
} from "./scheduled.logic";
import { useScheduledNavigation, useScheduledSearch } from "./useScheduledPage";

function TaskRow({
  task,
  selected,
  nowMs,
  onSelect,
}: {
  readonly task: ScheduledTask;
  readonly selected: boolean;
  readonly nowMs: number;
  readonly onSelect: () => void;
}) {
  const runStatus = taskRunStatus(task);
  return (
    <li>
      <button
        type="button"
        data-testid={`scheduled-list-task-${task.id}`}
        aria-pressed={selected}
        className={cn(
          "flex w-full min-w-0 cursor-pointer flex-col rounded-lg px-2 py-1.5 text-left transition-colors select-none focus-ring",
          selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60 active:bg-sidebar-accent/80",
        )}
        onClick={onSelect}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium",
              task.status === "active" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {task.name}
          </span>
          {runStatus ? (
            <span
              role="img"
              aria-label={
                task.workingRuns > 0
                  ? "A run is working"
                  : `Last run: ${RUN_STATUS_LABELS[runStatus]}`
              }
              className={cn("size-[7px] shrink-0 rounded-full", RUN_STATUS_DOT_CLASSES[runStatus])}
            />
          ) : null}
        </span>
        <span className="truncate text-[12px] leading-[17px] text-muted-foreground">
          {describeTaskSchedule(task)}
        </span>
        <span className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground">
          {describeNextRun(task, nowMs)}
        </span>
      </button>
    </li>
  );
}

/**
 * The Scheduled page's list beside the rail: every task on every connected
 * computer that runs them, grouped by computer when there are several.
 * Choosing one opens it in the page; New task opens the form.
 */
export function ScheduledTasksList() {
  const nowMs = useRelativeTimeTick(30_000);
  const groups = useScheduledTaskGroups();
  const search = useScheduledSearch();
  const navigation = useScheduledNavigation();
  const grouped = groups.length > 1;
  const empty = groups.every((group) => (group.tasks ?? []).length === 0);

  return (
    <>
      <DestinationListHeader
        title="Scheduled"
        action={
          <ChromeIconButton
            size="titlebar"
            side="bottom"
            label="New task"
            testId="scheduled-list-new-task"
            disabled={groups.length === 0}
            tooltip={
              <ChromeTooltip
                label="New task"
                detail={groups.length === 0 ? "No computer runs scheduled tasks yet." : null}
              />
            }
            onClick={navigation.newTask}
          >
            <CalendarPlusIcon aria-hidden="true" />
          </ChromeIconButton>
        }
      />
      <SidebarContent className="px-2 pb-3" data-testid="scheduled-tasks-list">
        {/* With no tasks the page itself says so; the list stays quiet. */}
        {empty
          ? null
          : groups.map((group) =>
              (group.tasks ?? []).length === 0 ? null : (
                <section key={group.environment.environmentId} className="flex flex-col">
                  {grouped ? (
                    <h3 className="truncate px-2 pt-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
                      {group.environment.label}
                    </h3>
                  ) : null}
                  <ul className="flex flex-col gap-0.5">
                    {(group.tasks ?? []).map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        nowMs={nowMs}
                        selected={
                          search.environment === group.environment.environmentId &&
                          search.task === task.id
                        }
                        onSelect={() =>
                          navigation.openTask({
                            environmentId: group.environment.environmentId,
                            taskId: task.id,
                          })
                        }
                      />
                    ))}
                  </ul>
                </section>
              ),
            )}
      </SidebarContent>
    </>
  );
}
