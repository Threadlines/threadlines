import type { ScheduledTaskRequest, ScopedThreadRef } from "@threadlines/contracts";
import { memo, useState } from "react";

import { readEnvironmentConnection } from "~/environments/runtime";
import { Button } from "../ui/button";
import { failureNotice, toastManager } from "../ui/toast";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";

/**
 * An agent asks to create or change a scheduled task ("Agents can start
 * threads": Ask me first). The child-thread card's schedule kind: docked
 * above the message box the same way, naming the task and what the change
 * would do, with Allow and Not now.
 */
export const ComposerScheduleRequestPanel = memo(function ComposerScheduleRequestPanel(props: {
  threadRef: ScopedThreadRef;
  request: ScheduledTaskRequest;
}) {
  const { request } = props;
  const [responding, setResponding] = useState(false);

  const respond = async (allow: boolean) => {
    const connection = readEnvironmentConnection(props.threadRef.environmentId);
    if (!connection) {
      addComputerNotConnectedNotice({
        environmentId: props.threadRef.environmentId,
        fallbackLabel: "This computer",
      });
      return;
    }
    setResponding(true);
    try {
      await connection.client.scheduledTasks.respondRequest({
        requestId: request.requestId,
        allow,
      });
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: allow ? "Couldn't make the change" : "Couldn't answer the agent",
          error,
        }),
      );
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="schedule-request-panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tracking-[0.2em] uppercase">Agent request</span>
          <span className="text-sm font-medium" data-testid="schedule-request-panel-heading">
            {request.action === "create"
              ? `The agent wants to schedule "${request.name}"`
              : `The agent wants to change "${request.name}"`}
          </span>
        </div>
        <ul className="space-y-1">
          {request.details.map((detail) => (
            <li
              key={detail}
              className="min-w-0 text-sm break-words text-muted-foreground"
              data-testid="schedule-request-panel-detail"
            >
              {detail}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={responding} onClick={() => void respond(false)}>
          Not now
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={responding}
          onClick={() => void respond(true)}
        >
          Allow
        </Button>
      </div>
    </div>
  );
});
