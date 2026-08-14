import { OrchestrationSubagent, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSubagent = Schema.Struct({
  threadId: ThreadId,
  ...OrchestrationSubagent.fields,
});
export type ProjectionThreadSubagent = typeof ProjectionThreadSubagent.Type;

export const ProjectionThreadSubagentThreadInput = Schema.Struct({ threadId: ThreadId });

export interface ProjectionThreadSubagentRepositoryShape {
  readonly listByThreadId: (
    input: typeof ProjectionThreadSubagentThreadInput.Type,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadSubagent>, ProjectionRepositoryError>;
  readonly replaceByThreadId: (
    threadId: ThreadId,
    rows: ReadonlyArray<OrchestrationSubagent>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadSubagentRepository extends Context.Service<
  ProjectionThreadSubagentRepository,
  ProjectionThreadSubagentRepositoryShape
>()(
  "threadlines/persistence/Services/ProjectionThreadSubagents/ProjectionThreadSubagentRepository",
) {}
