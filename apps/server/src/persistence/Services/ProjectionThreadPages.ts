import {
  AgentPageHeights,
  AgentPageId,
  AgentPageKind,
  AgentPageVersionId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  ThreadParticipantId,
  TrimmedNonEmptyString,
  TurnId,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** One agent page as one turn left it (OrchestrationAgentPage), keyed by thread, page and turn. */
export const ProjectionThreadPage = Schema.Struct({
  threadId: ThreadId,
  pageId: AgentPageId,
  turnId: TurnId,
  versionId: AgentPageVersionId,
  version: PositiveInt,
  participantId: Schema.NullOr(ThreadParticipantId),
  title: TrimmedNonEmptyString,
  kind: AgentPageKind,
  height: PositiveInt,
  heights: Schema.optional(AgentPageHeights),
  icon: Schema.optional(TrimmedNonEmptyString),
  shareUrl: Schema.optional(TrimmedNonEmptyString),
  placementSequence: Schema.optional(NonNegativeInt),
  eventSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadPage = typeof ProjectionThreadPage.Type;

/** A stored version a live page row still shows, for the page file sweep. */
export interface ProjectionPageVersionRef {
  readonly threadId: ThreadId;
  readonly pageId: AgentPageId;
  readonly versionId: AgentPageVersionId;
}

export interface ProjectionThreadPageRepositoryShape {
  readonly upsert: (page: ProjectionThreadPage) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<ProjectionThreadPage>, ProjectionRepositoryError>;
  readonly getVersion: (input: {
    readonly threadId: ThreadId;
    readonly pageId: AgentPageId;
    readonly versionId: AgentPageVersionId;
  }) => Effect.Effect<ProjectionThreadPage | undefined, ProjectionRepositoryError>;
  /** Every version a page row of a thread that is not deleted still shows. */
  readonly listLiveVersions: () => Effect.Effect<
    ReadonlyArray<ProjectionPageVersionRef>,
    ProjectionRepositoryError
  >;
  readonly deleteByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPageRepository extends Context.Service<
  ProjectionThreadPageRepository,
  ProjectionThreadPageRepositoryShape
>()("threadlines/persistence/Services/ProjectionThreadPages/ProjectionThreadPageRepository") {}
