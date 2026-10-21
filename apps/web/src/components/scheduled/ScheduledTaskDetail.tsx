import type { ScheduledRun, ThreadId } from "@threadlines/contracts";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";

import { useThreadTitle } from "../../childThreads";
import { readEnvironmentConnection } from "../../environments/runtime";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { ProviderGlyph } from "../chat/ProviderInstanceIcon";
import { SETTINGS_GROUP_ROW_CLASS, SettingsSection } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import {
  describeNextRun,
  describeTaskSchedule,
  formatWhen,
  RUN_STATUS_DOT_CLASSES,
  RUN_STATUS_LABELS,
  RUN_TRIGGER_LABELS,
} from "./scheduled.logic";
import { setTaskActive } from "./ScheduledView";
import {
  type LocatedTask,
  taskRef,
  useAccessLabel,
  useAgentLabels,
  useContinuedAgents,
  useProjectNames,
  useScheduledNavigation,
} from "./useScheduledPage";

const RUN_PAGE = 30;

function RunRow({
  run,
  environmentId,
  nowMs,
}: {
  readonly run: ScheduledRun;
  readonly environmentId: string;
  readonly nowMs: number;
}) {
  const navigate = useNavigate();
  const trigger = RUN_TRIGGER_LABELS[run.trigger];
  const note = run.summary ?? run.reason;
  return (
    <li
      className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-start gap-3 px-3.5 py-2.5")}
      data-testid={`scheduled-run-${run.slotUtc}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-[7px] shrink-0 rounded-full",
          RUN_STATUS_DOT_CLASSES[run.status],
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-[13.5px] leading-[19px] font-medium text-foreground">
            {RUN_STATUS_LABELS[run.status]}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatWhen(run.slotUtc, nowMs)}
          </span>
          {trigger ? (
            <span className="font-mono text-[11px] text-muted-foreground">{trigger}</span>
          ) : null}
        </span>
        {note ? (
          <span className="text-[12.5px] leading-[18px] text-muted-foreground">{note}</span>
        ) : null}
      </span>
      {run.threadId !== null ? (
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: run.threadId! },
            })
          }
        >
          Open thread
        </Button>
      ) : null}
    </li>
  );
}

/** The task's runs, newest first; follows the task as its runs move. */
function RunHistory({ located }: { readonly located: LocatedTask }) {
  const nowMs = useRelativeTimeTick(30_000);
  const { environment, task } = located;
  // Read again whenever the task's last run moves or a run starts or ends.
  const version = `${task.lastRun?.slotUtc ?? ""}:${task.lastRun?.status ?? ""}:${task.lastRun?.updatedAt ?? ""}:${task.workingRuns}`;
  // A page at a time, each picking up below the oldest run shown, so Show
  // more reaches the very first run however long the history is.
  const runs = useInfiniteQuery({
    queryKey: ["scheduledTasks", "runs", environment.environmentId, task.id, version],
    queryFn: async ({ pageParam }) => {
      const connection = readEnvironmentConnection(environment.environmentId);
      if (!connection) throw new Error(`${environment.label} isn't connected.`);
      return connection.client.scheduledTasks.listRuns({
        id: task.id,
        limit: RUN_PAGE,
        ...(pageParam !== null ? { before: pageParam } : {}),
      });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.hasMore ? (page.runs.at(-1)?.slotUtc ?? null) : null),
    placeholderData: keepPreviousData,
  });
  const list = runs.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <SettingsSection title="Runs" bare={list.length === 0} data-testid="scheduled-run-history">
      {list.length === 0 ? (
        <p className="px-1 text-[12.5px] text-muted-foreground">
          {runs.isError
            ? `Couldn't load its runs: ${runs.error instanceof Error ? runs.error.message : "unknown error"}`
            : runs.isPending
              ? "Loading runs…"
              : "No runs yet."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {list.map((run) => (
              <RunRow
                key={run.slotUtc}
                run={run}
                environmentId={environment.environmentId}
                nowMs={nowMs}
              />
            ))}
          </ul>
          {runs.hasNextPage ? (
            <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2")}>
              <Button
                size="xs"
                variant="ghost"
                disabled={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
                data-testid="scheduled-run-history-more"
              >
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-baseline gap-4 px-3.5 py-2.5")}>
      <span className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] leading-[19px] text-foreground">{children}</span>
    </div>
  );
}

/**
 * One task: what it runs, where and when, its run history, and Run now,
 * Edit, Pause or Resume, and Delete.
 */
export function ScheduledTaskDetail({ located }: { readonly located: LocatedTask }) {
  const nowMs = useRelativeTimeTick(30_000);
  const navigation = useScheduledNavigation();
  const navigate = useNavigate();
  const projectName = useProjectNames();
  const agentLabels = useAgentLabels();
  const accessLabel = useAccessLabel();
  const { environment, task } = located;
  const labels = agentLabels(environment.environmentId, task.modelSelection);
  const continuedTitle = useThreadTitle(
    environment.environmentId,
    task.target.kind === "thread" ? task.target.threadId : null,
  );
  const originTitle = useThreadTitle(environment.environmentId, task.originThreadId);
  // In a room, the agent its runs go to (none named: the thread's own).
  const continuedParticipantId =
    task.target.kind === "thread" ? (task.target.participantId ?? null) : null;
  const goesTo = useContinuedAgents(
    environment.environmentId,
    task.target.kind === "thread" ? task.target.threadId : null,
    continuedParticipantId,
  ).find((agent) => continuedParticipantId !== null && agent.id === continuedParticipantId);
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: environment.environmentId, threadId },
    });
  const [busy, setBusy] = useState<"run" | "active" | "delete" | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveRunThreads, setArchiveRunThreads] = useState(false);
  // Archiving a run thread stops it, as archiving any thread does.
  const archivesRunThreads = archiveRunThreads && task.target.kind === "new_thread";

  const client = () => readEnvironmentConnection(environment.environmentId)?.client ?? null;

  const runNow = async () => {
    const connection = client();
    if (!connection) {
      toastManager.add({ type: "error", title: `${environment.label} isn't connected.` });
      return;
    }
    setBusy("run");
    try {
      const run = await connection.scheduledTasks.runNow({ id: task.id });
      if (run.status === "skipped") {
        toastManager.add({
          type: "warning",
          title: "It didn't start",
          description: run.reason ?? undefined,
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start a run",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    const connection = client();
    if (!connection) {
      toastManager.add({ type: "error", title: `${environment.label} isn't connected.` });
      return;
    }
    setBusy("delete");
    try {
      await connection.scheduledTasks.remove({
        id: task.id,
        archiveRunThreads: archivesRunThreads,
      });
      setDeleteOpen(false);
      navigation.showAll({ replace: true });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't delete the task",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-7" data-testid="scheduled-task-detail">
      <header className="flex flex-col gap-3 px-1">
        <button
          type="button"
          className="-ms-1 flex w-fit cursor-pointer items-center gap-0.5 rounded-md text-[12.5px] text-muted-foreground hover:text-foreground focus-ring md:hidden"
          onClick={() => navigation.showAll()}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
          All tasks
        </button>
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em] text-foreground">
            {task.name}
          </h1>
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            {describeTaskSchedule(task)} · {describeNextRun(task, nowMs)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void runNow()}
            data-testid="scheduled-run-now"
          >
            Run now
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigation.editTask(taskRef(located))}
            data-testid="scheduled-edit"
          >
            Edit
          </Button>
          {task.status === "done" ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              data-testid="scheduled-toggle-active"
              onClick={() => {
                setBusy("active");
                void setTaskActive(environment, task, task.status !== "active").finally(() =>
                  setBusy(null),
                );
              }}
            >
              {task.status === "active" ? "Pause" : "Resume"}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive-outline"
            className="ms-auto"
            disabled={busy !== null}
            onClick={() => setDeleteOpen(true)}
            data-testid="scheduled-delete"
          >
            Delete
          </Button>
        </div>
        {task.status === "error" && task.error ? (
          <p className="rounded-lg bg-destructive/8 px-3 py-2 text-[12.5px] text-destructive-foreground">
            It stopped running: {task.error}
          </p>
        ) : null}
      </header>

      <SettingsSection title="Instructions">
        <p className="px-3.5 py-2.5 text-[13px] leading-[19px] whitespace-pre-wrap text-foreground">
          {task.prompt}
        </p>
      </SettingsSection>

      <SettingsSection title="Where it runs">
        <DetailRow label="Computer">{environment.label}</DetailRow>
        <DetailRow label="Project">
          {projectName(environment.environmentId, task.projectId)}
        </DetailRow>
        <DetailRow label="Each run">
          {task.target.kind === "new_thread" ? (
            task.checkout === "worktree" ? (
              "Starts a new thread in a new worktree"
            ) : (
              "Starts a new thread in the project folder"
            )
          ) : (
            <span>
              Continues{" "}
              <button
                type="button"
                className="cursor-pointer text-primary-readable underline-offset-2 hover:underline focus-ring"
                onClick={() => {
                  if (task.target.kind === "thread") openThread(task.target.threadId);
                }}
              >
                {continuedTitle ?? "its thread"}
              </button>
              {goesTo !== undefined ? (
                <span className="text-muted-foreground">
                  {" "}
                  · for {goesTo.name}
                  {goesTo.left ? ", who left it" : ""}
                </span>
              ) : null}
            </span>
          )}
        </DetailRow>
        <DetailRow label="Agent">
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderGlyph
              instanceId={task.modelSelection.instanceId}
              driverKind={labels.driverKind}
              environmentId={environment.environmentId}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">
              {labels.agent} · {labels.model}
            </span>
          </span>
        </DetailRow>
        <DetailRow label="Access">
          {accessLabel(environment.environmentId, task.modelSelection, task.runtimeMode)}
          {/* A continuation never runs with more access than its thread has then. */}
          {task.target.kind === "thread" ? (
            <span className="text-muted-foreground"> · never more than the thread has</span>
          ) : null}
        </DetailRow>
        <DetailRow label="Time zone">{task.timeZone}</DetailRow>
        {task.originThreadId !== null ? (
          <DetailRow label="Set up by">
            {originTitle === null ? (
              "An agent, in a thread that's archived or deleted"
            ) : (
              <span>
                An agent in{" "}
                <button
                  type="button"
                  className="cursor-pointer text-primary-readable underline-offset-2 hover:underline focus-ring"
                  data-testid="scheduled-origin-thread"
                  onClick={() => openThread(task.originThreadId!)}
                >
                  {originTitle}
                </button>
              </span>
            )}
          </DetailRow>
        ) : null}
      </SettingsSection>

      <RunHistory located={located} />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{task.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running and its run history goes with it.
              {task.workingRuns === 0
                ? ""
                : archivesRunThreads
                  ? " Runs at work now stop."
                  : " Runs at work now keep going as ordinary threads."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {task.target.kind === "new_thread" ? (
            <label className="flex cursor-pointer items-center gap-2 px-6 pb-4 text-sm text-muted-foreground">
              <Checkbox
                checked={archiveRunThreads}
                onCheckedChange={(checked) => setArchiveRunThreads(checked === true)}
                data-testid="scheduled-delete-archive"
              />
              Also archive its run threads
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy === "delete"}
              onClick={() => void confirmDelete()}
              data-testid="scheduled-delete-confirm"
            >
              Delete task
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
