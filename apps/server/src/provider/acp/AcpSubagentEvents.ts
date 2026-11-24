/**
 * The runtime events that show a subagent launched by a tool call
 * (`AcpProviderDescriptor.subagents`), in the shape Grok's subagents already
 * use: a `task.started` and `task.completed`, `subagent.metadata.updated`
 * with the role and prompt, and a replace-all task snapshot of what still
 * runs. The subagent is known by its launching call's id, which the
 * transcript route asks for.
 *
 * @module provider/acp/AcpSubagentEvents
 */
import { RuntimeTaskId } from "@threadlines/contracts";

import type { AcpExtensionRuntimeEvent, AcpSubagentLaunch } from "./AcpProviderDescriptor.ts";

/** How a launched subagent stands in the roster. */
export type AcpSubagentStatus = "running" | "completed" | "interrupted";

/** The most of a report kept on the task's summary (the full one is the result). */
const SUMMARY_LIMIT = 2_000;

/** One launch's subagent: a batch launch's roles and prompts read as one. */
export function describeAcpSubagentLaunches(
  launches: ReadonlyArray<AcpSubagentLaunch>,
): AcpSubagentLaunch {
  const [only] = launches;
  if (launches.length === 1 && only !== undefined) return only;
  return {
    role: launches.map((launch) => launch.role).join(", "),
    prompt: launches.map((launch) => `${launch.role}\n${launch.prompt}`).join("\n\n"),
  };
}

const nonEmpty = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** A launch went through: the subagent runs in the background. */
export function acpSubagentStartedEvents(
  launchCallId: string,
  launch: AcpSubagentLaunch,
): ReadonlyArray<AcpExtensionRuntimeEvent> {
  const role = nonEmpty(launch.role);
  const prompt = nonEmpty(launch.prompt);
  return [
    {
      type: "task.started",
      payload: {
        taskId: RuntimeTaskId.make(launchCallId),
        taskType: "agent",
        isBackgrounded: true,
        spawnDepth: 1,
        pendingCountManagedBySnapshot: true,
        ...(role ? { description: role, subagentType: role } : {}),
      },
    },
    {
      type: "subagent.metadata.updated",
      payload: {
        callId: launchCallId,
        agentThreadId: launchCallId,
        transcriptAgentId: launchCallId,
        treeDepth: 1,
        isBackgrounded: true,
        status: "running",
        ...(role ? { agentRole: role, taskName: role } : {}),
        ...(prompt ? { objective: prompt } : {}),
      },
    },
  ];
}

/** A subagent ended: it reported, or was stopped. */
export function acpSubagentSettledEvents(
  launchCallId: string,
  status: Exclude<AcpSubagentStatus, "running">,
  report: string | undefined,
): ReadonlyArray<AcpExtensionRuntimeEvent> {
  const result = report === undefined ? undefined : nonEmpty(report);
  return [
    {
      type: "task.completed",
      payload: {
        taskId: RuntimeTaskId.make(launchCallId),
        status: status === "interrupted" ? "stopped" : status,
        taskType: "agent",
        pendingCountManagedBySnapshot: true,
        ...(result ? { summary: result.slice(0, SUMMARY_LIMIT) } : {}),
      },
    },
    {
      type: "subagent.metadata.updated",
      payload: {
        callId: launchCallId,
        agentThreadId: launchCallId,
        status,
        ...(result ? { resultBody: result } : {}),
      },
    },
  ];
}

/** The replace-all snapshot of the subagents still running. */
export function acpSubagentSnapshotEvent(
  running: ReadonlyArray<{ readonly launchCallId: string; readonly launch: AcpSubagentLaunch }>,
): AcpExtensionRuntimeEvent {
  return {
    type: "task.snapshot.updated",
    payload: {
      tasks: running.map(({ launchCallId, launch }) => {
        const role = nonEmpty(launch.role);
        return {
          taskId: RuntimeTaskId.make(launchCallId),
          taskType: "agent",
          kind: "agent" as const,
          ...(role ? { description: role } : {}),
        };
      }),
    },
  };
}
