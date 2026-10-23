import type { ScheduledTask } from "@threadlines/contracts";
import { CalendarClockIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { readEnvironmentConnection } from "../../environments/runtime";
import {
  type ScheduledTaskEnvironment,
  useScheduledTaskGroups,
} from "../../lib/scheduledTasksState";
import { cn } from "../../lib/utils";
import { PageTitlebar } from "../PageTitlebar";
import {
  SETTINGS_GROUP_ROW_CLASS,
  SettingsGroup,
  SettingsPageHeader,
} from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  describeNextRun,
  describeTaskSchedule,
  RUN_STATUS_DOT_CLASSES,
  RUN_STATUS_LABELS,
  taskRunStatus,
} from "./scheduled.logic";
import { ScheduledTaskDetail } from "./ScheduledTaskDetail";
import { ScheduledTaskForm } from "./ScheduledTaskForm";
import {
  useAgentLabels,
  useProjectNames,
  useScheduledNavigation,
  useScheduledSearch,
  useSelectedScheduledTask,
} from "./useScheduledPage";

/** The page's line: event tasks join set times on a computer that runs them. */
const pageDescription = (eventTasks: boolean) =>
  eventTasks
    ? "Agents start on your prompts at set times or when something happens, while Threadlines is running on that computer."
    : "Agents start on your prompts at set times, while Threadlines is running on that computer.";

/** Pauses or resumes a task from its row; a failure says why. */
export async function setTaskActive(
  environment: ScheduledTaskEnvironment,
  task: ScheduledTask,
  active: boolean,
): Promise<void> {
  const connection = readEnvironmentConnection(environment.environmentId);
  if (!connection) {
    toastManager.add({ type: "error", title: `${environment.label} isn't connected.` });
    return;
  }
  try {
    await connection.client.scheduledTasks.update({
      id: task.id,
      status: active ? "active" : "paused",
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: active ? "Couldn't resume the task" : "Couldn't pause the task",
      description: error instanceof Error ? error.message : undefined,
    });
  }
}

function TaskOverviewRow({
  environment,
  task,
  nowMs,
  onOpen,
}: {
  readonly environment: ScheduledTaskEnvironment;
  readonly task: ScheduledTask;
  readonly nowMs: number;
  readonly onOpen: () => void;
}) {
  const projectName = useProjectNames();
  const agentLabels = useAgentLabels();
  const labels = agentLabels(environment.environmentId, task.modelSelection);
  const [pending, setPending] = useState(false);
  const runStatus = taskRunStatus(task);
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-center gap-3 px-3.5 py-2.5")}
      data-testid={`scheduled-row-${task.id}`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus-ring rounded-md"
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-[13.5px] leading-[19px] font-medium",
                task.status === "active" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {task.name}
            </span>
            <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
              {describeTaskSchedule(task)}
            </span>
          </span>
          <span className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
            {projectName(environment.environmentId, task.projectId)} · {labels.agent} {labels.model}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground sm:hidden">
            {describeNextRun(task, nowMs)}
          </span>
        </span>
        <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
          <span className="font-mono text-[11px] text-muted-foreground">
            {describeNextRun(task, nowMs)}
          </span>
          {runStatus ? (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-[7px] rounded-full", RUN_STATUS_DOT_CLASSES[runStatus])}
              />
              {RUN_STATUS_LABELS[runStatus]}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">No runs yet</span>
          )}
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {/* A one-time task that ran has nothing to pause; Edit gives it a new time. */}
      {task.status === "done" ? null : (
        <Switch
          checked={task.status === "active"}
          disabled={pending}
          aria-label={task.status === "active" ? `Pause ${task.name}` : `Resume ${task.name}`}
          data-testid={`scheduled-row-active-${task.id}`}
          onCheckedChange={(checked) => {
            setPending(true);
            void setTaskActive(environment, task, Boolean(checked)).finally(() =>
              setPending(false),
            );
          }}
        />
      )}
    </div>
  );
}

/** Every task, grouped by computer when there are several. */
function ScheduledOverview() {
  const nowMs = useRelativeTimeTick(30_000);
  const groups = useScheduledTaskGroups();
  const navigation = useScheduledNavigation();
  const taskCount = groups.reduce((count, group) => count + (group.tasks?.length ?? 0), 0);
  const eventTasks = groups.some((group) => group.environment.eventTasks);
  const description = pageDescription(eventTasks);
  const loading = groups.length > 0 && groups.every((group) => group.tasks === null);

  if (groups.length === 0) {
    return (
      <>
        <SettingsPageHeader title="Scheduled" description={description} />
        <SettingsGroup className="mt-7 px-5 py-6 text-[12.5px] text-muted-foreground">
          None of your connected computers runs scheduled tasks. Update Threadlines on a computer to
          use them there.
        </SettingsGroup>
      </>
    );
  }

  if (taskCount === 0 && !loading) {
    return (
      <>
        <SettingsPageHeader title="Scheduled" description={description} />
        <Empty
          className="flex-none gap-4 px-0 py-14 md:px-0 md:py-16"
          data-testid="scheduled-empty"
        >
          <EmptyHeader className="max-w-[440px]">
            <EmptyMedia variant="icon" className="mb-3">
              <CalendarClockIcon className="size-5" />
            </EmptyMedia>
            <EmptyTitle className="text-[15px] font-medium">No scheduled tasks yet</EmptyTitle>
            <EmptyDescription className="text-[12.5px] leading-[18px]">
              A morning review of yesterday&apos;s commits, a weekly dependency check: write the
              prompt once and an agent starts on it at the times you pick
              {eventTasks ? ", or when an issue on GitHub gets a label." : "."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={navigation.newTask}>
              New task
            </Button>
          </EmptyContent>
        </Empty>
      </>
    );
  }

  const grouped = groups.length > 1;
  return (
    <>
      <SettingsPageHeader
        title="Scheduled"
        description={description}
        actions={
          <Button size="sm" onClick={navigation.newTask} data-testid="scheduled-new-task">
            New task
          </Button>
        }
      />
      {groups.map((group) =>
        (group.tasks ?? []).length === 0 ? null : (
          <section
            key={group.environment.environmentId}
            className="mt-7 flex flex-col gap-2"
            data-testid={`scheduled-computer-${group.environment.environmentId}`}
          >
            {grouped ? (
              <h2 className="px-1 text-[15px] leading-5 font-semibold text-foreground">
                {group.environment.label}
              </h2>
            ) : null}
            <SettingsGroup>
              {(group.tasks ?? []).map((task) => (
                <TaskOverviewRow
                  key={task.id}
                  environment={group.environment}
                  task={task}
                  nowMs={nowMs}
                  onOpen={() =>
                    navigation.openTask({
                      environmentId: group.environment.environmentId,
                      taskId: task.id,
                    })
                  }
                />
              ))}
            </SettingsGroup>
          </section>
        ),
      )}
    </>
  );
}

/**
 * The Scheduled page (docs/design/fleet.md, Part 6): every task on every
 * connected computer that runs them, a task's detail and run history, and
 * the form for a new or edited task. Which one shows is in the search params.
 */
export function ScheduledView() {
  const search = useScheduledSearch();
  const selected = useSelectedScheduledTask(search);
  const groups = useScheduledTaskGroups();
  const navigation = useScheduledNavigation();
  const waitingForTask =
    search.task !== undefined &&
    selected === null &&
    groups.some(
      (group) => group.environment.environmentId === search.environment && group.tasks === null,
    );

  let body;
  if (search.view === "new") {
    body = <ScheduledTaskForm key="new" editing={null} />;
  } else if (selected !== null && search.view === "edit") {
    body = <ScheduledTaskForm key={`edit-${selected.task.id}`} editing={selected} />;
  } else if (selected !== null) {
    body = <ScheduledTaskDetail located={selected} />;
  } else if (search.task !== undefined && !waitingForTask) {
    body = (
      <div className="flex flex-col items-start gap-3 px-1">
        <p className="text-[13px] text-muted-foreground">
          That task was deleted, or its computer isn&apos;t connected.
        </p>
        <Button size="sm" variant="outline" onClick={() => navigation.showAll({ replace: true })}>
          All tasks
        </Button>
      </div>
    );
  } else if (waitingForTask) {
    body = null;
  } else {
    body = <ScheduledOverview />;
  }

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
      data-testid="scheduled-view"
    >
      <PageTitlebar label="Scheduled" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col px-4 pt-5 pb-12 sm:px-8 sm:pt-8">
          {body}
        </div>
      </div>
    </div>
  );
}
