import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ProjectScript,
  ProjectSetupId,
  ProjectSetupProtocol,
  ProjectSetupRemote,
  ProjectSetupSourceRef,
  ProjectSetupStage,
  TrimmedNonEmptyString,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * This computer's record of project setups (docs/design/fleet.md, Part 8):
 * one row per job, written before the job touches the disk. It keeps the
 * request without the files' bytes (to show and retry it), the ids the job
 * will use to add the project (so a restart replays the same commands), the
 * staging folder it made (the only thing it may delete) and its stage.
 */

/** What the app asked for, minus the files' bytes. */
export const ProjectSetupStoredRequest = Schema.Struct({
  source: ProjectSetupSourceRef,
  title: TrimmedNonEmptyString,
  repositoryKey: TrimmedNonEmptyString,
  subdirectory: Schema.String,
  remotes: Schema.Array(ProjectSetupRemote),
  primaryRemoteName: TrimmedNonEmptyString,
  protocol: ProjectSetupProtocol,
  scripts: Schema.Array(ProjectScript),
  destinationPath: TrimmedNonEmptyString,
  filePaths: Schema.Array(TrimmedNonEmptyString),
  expectedBytes: Schema.optional(Schema.Number),
});
export type ProjectSetupStoredRequest = typeof ProjectSetupStoredRequest.Type;

export const ProjectSetupRow = Schema.Struct({
  setupId: ProjectSetupId,
  request: ProjectSetupStoredRequest,
  /** The folder the copy ends in, `~` expanded. */
  destinationPath: Schema.String,
  /** The folder this job made with an exclusive mkdir; null for an adopted copy. */
  stagingPath: Schema.NullOr(Schema.String),
  /** An existing copy of the repository the job adds as it is: nothing of it is ever deleted. */
  adopted: Schema.Boolean,
  /** The URL the clone used, once it worked. */
  cloneUrl: Schema.NullOr(Schema.String),
  stage: ProjectSetupStage,
  projectId: ProjectId,
  createCommandId: CommandId,
  scriptsCommandId: CommandId,
  error: Schema.NullOr(Schema.String),
  warnings: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectSetupRow = typeof ProjectSetupRow.Type;

const ProjectSetupDbRow = Schema.Struct({
  ...ProjectSetupRow.fields,
  request: Schema.fromJsonString(ProjectSetupStoredRequest),
  adopted: Schema.BooleanFromBit,
  warnings: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ProjectSetupStoredRequest));
const encodeWarnings = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export class ProjectSetupRepositoryError extends Data.TaggedError("ProjectSetupRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ProjectSetupRepositoryShape {
  /** Inserts the job unless its id exists; returns the stored row either way. */
  readonly insert: (
    row: Omit<ProjectSetupRow, "error" | "cloneUrl" | "warnings" | "updatedAt">,
  ) => Effect.Effect<ProjectSetupRow, ProjectSetupRepositoryError>;
  readonly get: (
    setupId: ProjectSetupId,
  ) => Effect.Effect<Option.Option<ProjectSetupRow>, ProjectSetupRepositoryError>;
  /** Every job, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<ProjectSetupRow>, ProjectSetupRepositoryError>;
  readonly update: (input: {
    readonly setupId: ProjectSetupId;
    readonly patch: Partial<Pick<ProjectSetupRow, "stage" | "cloneUrl" | "error" | "warnings">>;
    readonly now: string;
  }) => Effect.Effect<void, ProjectSetupRepositoryError>;
  readonly remove: (setupId: ProjectSetupId) => Effect.Effect<void, ProjectSetupRepositoryError>;
}

export class ProjectSetupRepository extends Context.Service<
  ProjectSetupRepository,
  ProjectSetupRepositoryShape
>()("threadlines/projectSetup/ProjectSetupRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ProjectSetupRepositoryError({ operation, cause })),
      );

  const select = `
    SELECT
      setup_id AS "setupId",
      request_json AS "request",
      destination_path AS "destinationPath",
      staging_path AS "stagingPath",
      adopted AS "adopted",
      clone_url AS "cloneUrl",
      stage AS "stage",
      project_id AS "projectId",
      create_command_id AS "createCommandId",
      scripts_command_id AS "scriptsCommandId",
      error AS "error",
      warnings_json AS "warnings",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM project_setups
  `;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProjectSetupDbRow,
    execute: (setupId) => sql.unsafe(`${select} WHERE setup_id = ?`, [setupId]),
  });
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectSetupDbRow,
    execute: () => sql.unsafe(`${select} ORDER BY created_at, setup_id`, []),
  });

  const get: ProjectSetupRepositoryShape["get"] = (setupId) => findOne(setupId).pipe(wrap("get"));

  const insert: ProjectSetupRepositoryShape["insert"] = (row) =>
    Effect.gen(function* () {
      const request = yield* encodeRequest(row.request);
      yield* sql`
        INSERT INTO project_setups (
          setup_id, request_json, destination_path, staging_path, adopted, stage,
          project_id, create_command_id, scripts_command_id, warnings_json, created_at, updated_at
        ) VALUES (
          ${row.setupId}, ${request}, ${row.destinationPath}, ${row.stagingPath},
          ${row.adopted ? 1 : 0}, ${row.stage}, ${row.projectId}, ${row.createCommandId},
          ${row.scriptsCommandId}, '[]', ${row.createdAt}, ${row.createdAt}
        )
        ON CONFLICT(setup_id) DO NOTHING
      `;
      return Option.getOrThrow(yield* findOne(row.setupId));
    }).pipe(wrap("insert"));

  const list: ProjectSetupRepositoryShape["list"] = findAll(undefined).pipe(wrap("list"));

  const update: ProjectSetupRepositoryShape["update"] = (input) =>
    Effect.gen(function* () {
      const { patch } = input;
      const warnings = patch.warnings === undefined ? null : yield* encodeWarnings(patch.warnings);
      yield* sql`
        UPDATE project_setups SET
          stage = COALESCE(${patch.stage ?? null}, stage),
          clone_url = CASE WHEN ${patch.cloneUrl === undefined ? 0 : 1} = 1
            THEN ${patch.cloneUrl ?? null} ELSE clone_url END,
          error = CASE WHEN ${patch.error === undefined ? 0 : 1} = 1
            THEN ${patch.error ?? null} ELSE error END,
          warnings_json = COALESCE(${warnings}, warnings_json),
          updated_at = ${input.now}
        WHERE setup_id = ${input.setupId}
      `;
    }).pipe(wrap("update"));

  const remove: ProjectSetupRepositoryShape["remove"] = (setupId) =>
    sql`DELETE FROM project_setups WHERE setup_id = ${setupId}`.pipe(Effect.asVoid, wrap("remove"));

  return { insert, get, list, update, remove } satisfies ProjectSetupRepositoryShape;
});

export const ProjectSetupRepositoryLive = Layer.effect(ProjectSetupRepository, make);
