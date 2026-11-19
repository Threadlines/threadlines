/**
 * ProjectBriefRepository: `project_briefs`, one row per project that has a
 * brief (docs/design/project-brief-notes.md). A save names the revision it
 * expects, so two devices saving at once cannot overwrite each other.
 */
import { IsoDateTime, NonNegativeInt, ProjectId, type ProjectBrief } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";

const ProjectBriefRow = Schema.Struct({
  projectId: ProjectId,
  text: Schema.String,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});

export interface ProjectBriefRepositoryShape {
  /** Every project's brief row. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectBrief>, PersistenceSqlError>;
  /** The project's brief; none before its first save. */
  readonly get: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ProjectBrief>, PersistenceSqlError>;
  /**
   * Save `text` as the next revision when the stored revision is
   * `expectedRevision` (0: no row yet). None when it isn't: nothing written.
   */
  readonly save: (input: {
    readonly projectId: ProjectId;
    readonly text: string;
    readonly expectedRevision: number;
    readonly now: string;
  }) => Effect.Effect<Option.Option<ProjectBrief>, PersistenceSqlError>;
}

export class ProjectBriefRepository extends Context.Service<
  ProjectBriefRepository,
  ProjectBriefRepositoryShape
>()("threadlines/projectContext/ProjectBriefRepository") {}

export const makeProjectBriefRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectBriefRow,
    execute: () => sql`
      SELECT project_id AS "projectId", text, revision, updated_at AS "updatedAt"
      FROM project_briefs
      ORDER BY project_id
    `,
  });

  const selectOne = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: ProjectBriefRow,
    execute: (projectId) => sql`
      SELECT project_id AS "projectId", text, revision, updated_at AS "updatedAt"
      FROM project_briefs
      WHERE project_id = ${projectId}
    `,
  });

  const listAll: ProjectBriefRepositoryShape["listAll"] = () =>
    selectAll(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectBriefRepository.listAll")),
    );

  const get: ProjectBriefRepositoryShape["get"] = (projectId) =>
    selectOne(projectId).pipe(Effect.mapError(toPersistenceSqlError("ProjectBriefRepository.get")));

  const save: ProjectBriefRepositoryShape["save"] = (input) =>
    Effect.gen(function* () {
      const current = yield* selectOne(input.projectId);
      const currentRevision = Option.match(current, {
        onNone: () => 0,
        onSome: (row) => row.revision,
      });
      if (currentRevision !== input.expectedRevision) return Option.none();
      const next = {
        projectId: input.projectId,
        text: input.text,
        revision: currentRevision + 1,
        updatedAt: input.now,
      };
      yield* sql`
        INSERT INTO project_briefs (project_id, text, revision, updated_at)
        VALUES (${next.projectId}, ${next.text}, ${next.revision}, ${next.updatedAt})
        ON CONFLICT (project_id) DO UPDATE SET
          text = excluded.text,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `;
      return Option.some(next);
    }).pipe(
      sql.withTransaction,
      Effect.mapError(toPersistenceSqlError("ProjectBriefRepository.save")),
    );

  return { listAll, get, save } satisfies ProjectBriefRepositoryShape;
});

export const ProjectBriefRepositoryLive = Layer.effect(
  ProjectBriefRepository,
  makeProjectBriefRepository,
);
