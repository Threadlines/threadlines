/**
 * ProjectContext: what a project keeps for the agents that work in it, kept
 * on this computer outside the orchestration event log (docs/design/
 * project-brief-notes.md). The app reads and saves it over `projectContext.*`;
 * agents never can. Sessions read it through `ProjectInstructions`.
 */
import {
  GENERAL_CHATS_PROJECT_ID,
  type ProjectBrief,
  type ProjectBriefSetInput,
  type ProjectBriefSetResult,
  ProjectContextError,
  type ProjectContextSnapshot,
  type ProjectId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectBriefRepository } from "./ProjectBriefRepository.ts";

export interface ProjectContextShape {
  /** Every project's brief, now and again after each save. */
  readonly changes: Stream.Stream<ProjectContextSnapshot>;
  /** Save a brief, unless another device saved since `expectedRevision`. */
  readonly setBrief: (
    input: ProjectBriefSetInput,
  ) => Effect.Effect<ProjectBriefSetResult, ProjectContextError>;
  /** The project's brief text, for "Set up on another computer"; "" when it has none. */
  readonly briefText: (projectId: ProjectId) => Effect.Effect<string>;
  /**
   * A project "Set up on another computer" just added here takes the brief it
   * was copied with. Only into an empty brief: one the user wrote here wins.
   */
  readonly adoptBrief: (projectId: ProjectId, text: string) => Effect.Effect<void>;
}

export class ProjectContext extends Context.Service<ProjectContext, ProjectContextShape>()(
  "threadlines/projectContext/ProjectContext",
) {}

const failWith = (detail: string) => Effect.fail(new ProjectContextError({ detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const emptyBrief = (projectId: ProjectId): ProjectBrief => ({
  projectId,
  text: "",
  revision: 0,
  updatedAt: null,
});

export const makeProjectContext = Effect.gen(function* () {
  const briefs = yield* ProjectBriefRepository;
  const projects = yield* ProjectionProjectRepository;

  const loadSnapshot = briefs.listAll().pipe(
    Effect.map((rows): ProjectContextSnapshot => ({ briefs: rows })),
    Effect.catchCause((cause) =>
      Effect.logWarning("project briefs could not be read", { cause: Cause.pretty(cause) }).pipe(
        Effect.as({ briefs: [] } satisfies ProjectContextSnapshot),
      ),
    ),
  );
  const snapshot = yield* SubscriptionRef.make<ProjectContextSnapshot>(yield* loadSnapshot);
  const publish = (brief: ProjectBrief) =>
    SubscriptionRef.update(snapshot, (current) => ({
      briefs: [...current.briefs.filter((entry) => entry.projectId !== brief.projectId), brief],
    }));

  const requireProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if (projectId === GENERAL_CHATS_PROJECT_ID) {
        return yield* failWith("General Chats have no brief.");
      }
      const project = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            () => new ProjectContextError({ detail: "The project couldn't be read." }),
          ),
        );
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* failWith("This project is gone.");
      }
    });

  const setBrief: ProjectContextShape["setBrief"] = (input) =>
    Effect.gen(function* () {
      yield* requireProject(input.projectId);
      const saved = yield* briefs
        .save({
          projectId: input.projectId,
          text: input.text,
          expectedRevision: input.expectedRevision,
          now: yield* nowIso,
        })
        .pipe(
          Effect.mapError(
            () => new ProjectContextError({ detail: "The brief couldn't be saved." }),
          ),
        );
      if (Option.isNone(saved)) {
        const current = yield* briefs
          .get(input.projectId)
          .pipe(
            Effect.mapError(
              () => new ProjectContextError({ detail: "The brief couldn't be read." }),
            ),
          );
        return {
          outcome: "stale" as const,
          brief: Option.getOrElse(current, () => emptyBrief(input.projectId)),
        };
      }
      yield* publish(saved.value);
      return { outcome: "saved" as const, brief: saved.value };
    });

  const briefText: ProjectContextShape["briefText"] = (projectId) =>
    briefs.get(projectId).pipe(
      Effect.map((row) => Option.getOrUndefined(row)?.text ?? ""),
      Effect.orElseSucceed(() => ""),
    );

  const adoptBrief: ProjectContextShape["adoptBrief"] = (projectId, text) =>
    Effect.gen(function* () {
      if (text.trim().length === 0) return;
      const saved = yield* briefs.save({
        projectId,
        text,
        expectedRevision: 0,
        now: yield* nowIso,
      });
      if (Option.isSome(saved)) yield* publish(saved.value);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("a copied project's brief couldn't be saved", {
          projectId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return {
    changes: SubscriptionRef.changes(snapshot),
    setBrief,
    briefText,
    adoptBrief,
  } satisfies ProjectContextShape;
});

export const ProjectContextLive = Layer.effect(ProjectContext, makeProjectContext);
