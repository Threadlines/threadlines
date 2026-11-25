import type { EnvironmentId } from "@threadlines/contracts";
import { CalendarClockIcon } from "lucide-react";
import { useMemo } from "react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { useScheduledTasksStore } from "../../lib/scheduledTasksState";
import { cn } from "../../lib/utils";
import {
  describeScheduleCall,
  parseScheduleCallResult,
  type ScheduleChangeTool,
} from "../scheduled/scheduled.logic";
import { useScheduledNavigation } from "../scheduled/useScheduledNavigation";
import { threadlinesRoomToolOf } from "./activitySteps";
import type { TimelineWorkEntry } from "./MessagesTimeline.logic";

/**
 * Where the agent created or changed a scheduled task: one line with the task
 * as it is now (its schedule and next run), or its card still waiting for the
 * user. A click opens the task on the Scheduled page.
 */
export default function ScheduleCallRecordLine({
  activeThreadEnvironmentId,
  entry,
}: {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly entry: TimelineWorkEntry;
}) {
  const nowMs = useRelativeTimeTick(30_000);
  const navigation = useScheduledNavigation();
  const snapshot = useScheduledTasksStore(
    (state) => state.byEnvironment[activeThreadEnvironmentId],
  );
  const result = useMemo(
    () => parseScheduleCallResult(entry.toolResult ?? entry.outputPreview),
    [entry.outputPreview, entry.toolResult],
  );
  const tool: ScheduleChangeTool =
    threadlinesRoomToolOf(entry) === "schedule_update" ? "schedule_update" : "schedule_create";
  const record = describeScheduleCall({
    tool,
    result,
    task:
      result.taskId === null
        ? null
        : (snapshot?.tasks.find((task) => task.id === result.taskId) ?? null),
    waiting:
      result.requestId !== null &&
      (snapshot?.requests.some((request) => request.requestId === result.requestId) ?? false),
    failed: entry.executionState === "failed",
    followed: snapshot !== undefined,
    nowMs,
  });
  const line = (
    <>
      <CalendarClockIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
      <span className="max-w-[70%] min-w-0 shrink-0 truncate" data-schedule-call-heading>
        {record.heading}
      </span>
      {record.outcome !== null ? (
        <>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate text-muted-foreground" data-schedule-call-outcome>
            {record.outcome}
          </span>
        </>
      ) : null}
    </>
  );
  const className = "flex min-w-0 items-center gap-[7px] text-xs leading-5 text-foreground/80";
  const open = record.open;
  return open === null ? (
    <div className={className} data-schedule-call={entry.id}>
      {line}
    </div>
  ) : (
    <button
      type="button"
      className={cn(
        className,
        "w-full cursor-pointer text-left transition-colors hover:text-foreground",
      )}
      data-schedule-call={entry.id}
      onClick={() =>
        navigation.openTask({ environmentId: activeThreadEnvironmentId, taskId: open })
      }
    >
      {line}
    </button>
  );
}
