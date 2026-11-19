/**
 * A project's brief: text the user writes once, which every thread in the
 * project gets as standing instructions, on any agent (docs/design/
 * project-brief-notes.md). Kept by Threadlines on each computer, outside the
 * orchestration event log and outside the repository.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The longest brief a project keeps. */
export const PROJECT_BRIEF_MAX_CHARS = 8_000;

/**
 * A project's brief on one computer. `revision` counts its saves there, so a
 * save from a page that loaded an older one is refused instead of lost.
 */
export const ProjectBrief = Schema.Struct({
  projectId: ProjectId,
  /** "" when the project has none. */
  text: Schema.String,
  revision: NonNegativeInt,
  /** Null before the first save. */
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectBrief = typeof ProjectBrief.Type;

/** What `projectContext.subscribe` sends: every project's brief that has one. */
export const ProjectContextSnapshot = Schema.Struct({
  briefs: Schema.Array(ProjectBrief),
});
export type ProjectContextSnapshot = typeof ProjectContextSnapshot.Type;

export const ProjectContextSubscribeInput = Schema.Struct({});
export type ProjectContextSubscribeInput = typeof ProjectContextSubscribeInput.Type;

/**
 * Save a project's brief. `expectedRevision` is the revision the page last saw
 * on this computer; a save from behind another device's is refused (`stale`)
 * with the brief as it is now. "" clears it.
 */
export const ProjectBriefSetInput = Schema.Struct({
  projectId: ProjectId,
  text: Schema.String.check(Schema.isMaxLength(PROJECT_BRIEF_MAX_CHARS)),
  expectedRevision: NonNegativeInt,
});
export type ProjectBriefSetInput = typeof ProjectBriefSetInput.Type;

export const ProjectBriefSetResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("saved"), brief: ProjectBrief }),
  /** Another device saved first: nothing was written, and `brief` is theirs. */
  Schema.Struct({ outcome: Schema.Literal("stale"), brief: ProjectBrief }),
]);
export type ProjectBriefSetResult = typeof ProjectBriefSetResult.Type;

export class ProjectContextError extends Schema.TaggedError<ProjectContextError>()(
  "ProjectContextError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
