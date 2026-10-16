/**
 * The calls the workflow view makes to the server, behind a narrow module for
 * the same reason as subagentTranscriptClient: the rendering components stay
 * off the environment runtime's large module graph (and tests can mock this).
 */
import type {
  EnvironmentId,
  ProviderSubagentTranscriptResult,
  ThreadId,
  WorkflowCommandLocation,
  WorkflowReadRunFileResult,
  WorkflowRunFileKind,
  WorkflowSaveCommandResult,
} from "@threadlines/contracts";

import { requireEnvironmentConnection } from "../../environments/runtime/service";

interface RunRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
}

export async function readWorkflowRunFile(
  input: RunRef & { readonly file: WorkflowRunFileKind },
): Promise<WorkflowReadRunFileResult> {
  const connection = requireEnvironmentConnection(input.environmentId);
  return await connection.client.server.readWorkflowRunFile({
    threadId: input.threadId,
    taskId: input.taskId,
    file: input.file,
  });
}

export async function readWorkflowAgentTranscriptPage(
  input: RunRef & {
    readonly agentId: string;
    readonly limit?: number;
    readonly offset?: number;
    readonly fromEnd?: boolean;
  },
): Promise<ProviderSubagentTranscriptResult> {
  const connection = requireEnvironmentConnection(input.environmentId);
  return await connection.client.server.readWorkflowAgentTranscript({
    threadId: input.threadId,
    taskId: input.taskId,
    agentId: input.agentId,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.fromEnd !== undefined ? { fromEnd: input.fromEnd } : {}),
  });
}

export async function saveWorkflowCommand(
  input: RunRef & {
    readonly location: WorkflowCommandLocation;
    readonly overwrite: boolean;
    readonly dryRun?: boolean;
  },
): Promise<WorkflowSaveCommandResult> {
  const connection = requireEnvironmentConnection(input.environmentId);
  return await connection.client.server.saveWorkflowCommand({
    threadId: input.threadId,
    taskId: input.taskId,
    location: input.location,
    overwrite: input.overwrite,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
  });
}
