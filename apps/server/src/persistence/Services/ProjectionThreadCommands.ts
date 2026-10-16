import type {
  OrchestrationCommandRequest,
  OrchestrationCommandRun,
  ThreadId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/**
 * A thread's suggested commands as stored (docs/terminal-command-runs.md):
 * request cards and runs, each its read model, plus the output a run left,
 * which only the server reads (to hand it to the agent).
 */
export interface ProjectionThreadCommandRepositoryShape {
  readonly upsertRequest: (input: {
    readonly threadId: ThreadId;
    readonly request: OrchestrationCommandRequest;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listRequests: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<OrchestrationCommandRequest>, ProjectionRepositoryError>;
  readonly deleteRequests: (input: {
    readonly threadId: ThreadId;
    readonly requestIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Writes a run's read model; its recorded output stays as it was. */
  readonly upsertRun: (input: {
    readonly threadId: ThreadId;
    readonly run: OrchestrationCommandRun;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listRuns: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<OrchestrationCommandRun>, ProjectionRepositoryError>;
  readonly deleteRuns: (input: {
    readonly threadId: ThreadId;
    readonly runIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly setRunOutput: (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly output: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Every thread's runs, for the startup check of runs a restart cut off. */
  readonly listAllRuns: () => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly run: OrchestrationCommandRun }>,
    ProjectionRepositoryError
  >;
  /** Null when the run left no output, or is gone. */
  readonly getRunOutput: (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
  }) => Effect.Effect<string | null, ProjectionRepositoryError>;
}

export class ProjectionThreadCommandRepository extends Context.Service<
  ProjectionThreadCommandRepository,
  ProjectionThreadCommandRepositoryShape
>()(
  "threadlines/persistence/Services/ProjectionThreadCommands/ProjectionThreadCommandRepository",
) {}
