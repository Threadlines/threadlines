import { OrchestrationWorkflowRun, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** A thread's workflow run as stored: see OrchestrationWorkflowRun. */
export const ProjectionThreadWorkflowRun = Schema.Struct({
  threadId: ThreadId,
  run: OrchestrationWorkflowRun,
});
export type ProjectionThreadWorkflowRun = typeof ProjectionThreadWorkflowRun.Type;

export const ProjectionThreadWorkflowRunThreadInput = Schema.Struct({ threadId: ThreadId });

export interface ProjectionThreadWorkflowRunRepositoryShape {
  readonly listByThreadId: (
    input: typeof ProjectionThreadWorkflowRunThreadInput.Type,
  ) => Effect.Effect<ReadonlyArray<OrchestrationWorkflowRun>, ProjectionRepositoryError>;
  /** Every run of every thread not deleted, for the snapshots. */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadWorkflowRun>,
    ProjectionRepositoryError
  >;
  readonly upsert: (
    threadId: ThreadId,
    run: OrchestrationWorkflowRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly replaceByThreadId: (
    threadId: ThreadId,
    runs: ReadonlyArray<OrchestrationWorkflowRun>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadWorkflowRunRepository extends Context.Service<
  ProjectionThreadWorkflowRunRepository,
  ProjectionThreadWorkflowRunRepositoryShape
>()(
  "threadlines/persistence/Services/ProjectionThreadWorkflowRuns/ProjectionThreadWorkflowRunRepository",
) {}
