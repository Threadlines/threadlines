/**
 * The client's requests about one workflow run: its files, an agent's
 * transcript, and saving its script as a command. Each finds the run on the
 * thread and goes to the provider instance recorded as its owner, so they keep
 * working after the thread moved to another agent or provider, or the server
 * restarted.
 */
import {
  type OrchestrationThread,
  type OrchestrationWorkflowRun,
  type ProviderInstanceId,
  ProviderSubagentTranscriptError,
  type ThreadId,
  type WorkflowReadAgentTranscriptInput,
  type WorkflowReadRunFileInput,
  WorkflowRequestError,
  type WorkflowSaveCommandInput,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

interface ResolvedRun {
  readonly thread: OrchestrationThread;
  readonly run: OrchestrationWorkflowRun;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
}

function message(cause: unknown, fallback: string): string {
  const text =
    typeof cause === "string"
      ? cause
      : typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { readonly message: unknown }).message)
        : "";
  return text.trim().length > 0 ? text : fallback;
}

export function makeWorkflowRunRequests(input: {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerService: ProviderServiceShape;
}) {
  const resolveRun = (threadId: ThreadId, taskId: string) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(
        yield* input.projectionSnapshotQuery.getThreadDetailById(threadId),
      );
      const run = thread?.workflowRuns?.find((entry) => entry.taskId === taskId);
      if (!thread || !run) {
        return yield* Effect.fail("That workflow run is not in this thread.");
      }
      // A run recorded before its session was known falls back to the thread's.
      const providerInstanceId =
        run.owner.providerInstanceId ??
        thread.session?.providerInstanceId ??
        thread.modelSelection.instanceId;
      const projects = yield* input.projectionSnapshotQuery.getProjectShellById(thread.projectId);
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: Option.match(projects, {
          onNone: () => [],
          onSome: (project) => [project],
        }),
      });
      return { thread, run, providerInstanceId, cwd } satisfies ResolvedRun;
    });

  const readRunFile = (request: WorkflowReadRunFileInput) =>
    resolveRun(request.threadId, request.taskId).pipe(
      Effect.flatMap((resolved) =>
        input.providerService.readWorkflowRunFile({
          providerInstanceId: resolved.providerInstanceId,
          run: resolved.run,
          file: request.file,
        }),
      ),
      Effect.mapError(
        (cause) =>
          new WorkflowRequestError({
            message: message(cause, "The workflow's file could not be read."),
          }),
      ),
    );

  const readAgentTranscript = (request: WorkflowReadAgentTranscriptInput) =>
    resolveRun(request.threadId, request.taskId).pipe(
      Effect.flatMap((resolved) =>
        input.providerService.readWorkflowAgentTranscript({
          providerInstanceId: resolved.providerInstanceId,
          run: resolved.run,
          agentId: request.agentId,
          ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
          ...(request.offset !== undefined ? { offset: request.offset } : {}),
          ...(request.fromEnd !== undefined ? { fromEnd: request.fromEnd } : {}),
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ProviderSubagentTranscriptError({
            message: message(cause, "The agent's transcript could not be read."),
          }),
      ),
    );

  const saveCommand = (request: WorkflowSaveCommandInput) =>
    resolveRun(request.threadId, request.taskId).pipe(
      Effect.flatMap((resolved) =>
        Effect.gen(function* () {
          if (resolved.cwd === undefined && request.location === "project") {
            return yield* Effect.fail("This thread has no project folder to save into.");
          }
          return yield* input.providerService.saveWorkflowCommand({
            providerInstanceId: resolved.providerInstanceId,
            run: resolved.run,
            location: request.location,
            cwd: resolved.cwd ?? "",
            overwrite: request.overwrite,
            dryRun: request.dryRun === true,
          });
        }),
      ),
      Effect.mapError(
        (cause) =>
          new WorkflowRequestError({
            message: message(cause, "The workflow could not be saved."),
          }),
      ),
    );

  return { readRunFile, readAgentTranscript, saveCommand };
}
