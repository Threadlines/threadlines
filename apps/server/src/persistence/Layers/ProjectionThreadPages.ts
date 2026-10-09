import {
  AgentPageId,
  AgentPageVersionId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@threadlines/contracts";
import { readAgentPageHeights } from "@threadlines/shared/agentPages";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadPage,
  ProjectionThreadPageRepository,
  type ProjectionThreadPageRepositoryShape,
} from "../Services/ProjectionThreadPages.ts";

// Optional fields come back as NULL; heights are stored as JSON text.
export const ProjectionThreadPageDbRowSchema = ProjectionThreadPage.mapFields(
  Struct.assign({
    heights: Schema.NullOr(Schema.String),
    icon: Schema.NullOr(TrimmedNonEmptyString),
    shareUrl: Schema.NullOr(TrimmedNonEmptyString),
    placementSequence: Schema.NullOr(NonNegativeInt),
    eventSequence: Schema.NullOr(NonNegativeInt),
  }),
);

const ThreadInput = Schema.Struct({ threadId: ThreadId });
const VersionInput = Schema.Struct({
  threadId: ThreadId,
  pageId: AgentPageId,
  versionId: AgentPageVersionId,
});
const VersionRefRow = Schema.Struct({
  threadId: ThreadId,
  pageId: AgentPageId,
  versionId: AgentPageVersionId,
});

const parseHeights = (json: string | null) => {
  if (json === null) return undefined;
  try {
    return readAgentPageHeights(JSON.parse(json));
  } catch {
    return undefined;
  }
};

export const projectionThreadPageFromDbRow = ({
  heights,
  icon,
  shareUrl,
  placementSequence,
  eventSequence,
  ...row
}: typeof ProjectionThreadPageDbRowSchema.Type): ProjectionThreadPage => {
  const parsedHeights = parseHeights(heights);
  return {
    ...row,
    ...(parsedHeights !== undefined ? { heights: parsedHeights } : {}),
    ...(icon !== null ? { icon } : {}),
    ...(shareUrl !== null ? { shareUrl } : {}),
    ...(placementSequence !== null ? { placementSequence } : {}),
    ...(eventSequence !== null ? { eventSequence } : {}),
  };
};

const makeProjectionThreadPageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadPage,
    execute: (row) => sql`
      INSERT INTO projection_thread_pages (
        thread_id,
        page_id,
        turn_id,
        version_id,
        version,
        participant_id,
        title,
        kind,
        height,
        heights_json,
        icon,
        share_url,
        placement_sequence,
        event_sequence,
        created_at,
        updated_at
      )
      VALUES (
        ${row.threadId},
        ${row.pageId},
        ${row.turnId},
        ${row.versionId},
        ${row.version},
        ${row.participantId},
        ${row.title},
        ${row.kind},
        ${row.height},
        ${row.heights !== undefined ? JSON.stringify(row.heights) : null},
        ${row.icon ?? null},
        ${row.shareUrl ?? null},
        ${row.placementSequence ?? null},
        ${row.eventSequence ?? null},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id, page_id, turn_id)
      DO UPDATE SET
        version_id = excluded.version_id,
        version = excluded.version,
        participant_id = excluded.participant_id,
        title = excluded.title,
        kind = excluded.kind,
        height = excluded.height,
        heights_json = excluded.heights_json,
        icon = excluded.icon,
        share_url = excluded.share_url,
        placement_sequence = excluded.placement_sequence,
        event_sequence = excluded.event_sequence,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: ThreadInput,
    Result: ProjectionThreadPageDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        page_id AS "pageId",
        turn_id AS "turnId",
        version_id AS "versionId",
        version,
        participant_id AS "participantId",
        title,
        kind,
        height,
        heights_json AS "heights",
        icon,
        share_url AS "shareUrl",
        placement_sequence AS "placementSequence",
        event_sequence AS "eventSequence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_pages
      WHERE thread_id = ${threadId}
      ORDER BY placement_sequence ASC, created_at ASC, version_id ASC
    `,
  });

  const getVersionRow = SqlSchema.findOneOption({
    Request: VersionInput,
    Result: ProjectionThreadPageDbRowSchema,
    execute: ({ threadId, pageId, versionId }) => sql`
      SELECT
        thread_id AS "threadId",
        page_id AS "pageId",
        turn_id AS "turnId",
        version_id AS "versionId",
        version,
        participant_id AS "participantId",
        title,
        kind,
        height,
        heights_json AS "heights",
        icon,
        share_url AS "shareUrl",
        placement_sequence AS "placementSequence",
        event_sequence AS "eventSequence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_pages
      WHERE thread_id = ${threadId} AND page_id = ${pageId} AND version_id = ${versionId}
      LIMIT 1
    `,
  });

  const listLiveVersionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: VersionRefRow,
    execute: () => sql`
      SELECT
        pages.thread_id AS "threadId",
        pages.page_id AS "pageId",
        pages.version_id AS "versionId"
      FROM projection_thread_pages AS pages
      JOIN projection_threads AS threads ON threads.thread_id = pages.thread_id
      WHERE threads.deleted_at IS NULL
    `,
  });

  const deleteRows = SqlSchema.void({
    Request: ThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_pages
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadPageRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPageRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadPageRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.map((rows) => rows.map(projectionThreadPageFromDbRow)),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPageRepository.listByThreadId:query")),
    );

  const getVersion: ProjectionThreadPageRepositoryShape["getVersion"] = (input) =>
    getVersionRow(input).pipe(
      Effect.map((row) =>
        Option.isSome(row) ? projectionThreadPageFromDbRow(row.value) : undefined,
      ),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPageRepository.getVersion:query")),
    );

  const listLiveVersions: ProjectionThreadPageRepositoryShape["listLiveVersions"] = () =>
    listLiveVersionRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPageRepository.listLiveVersions:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadPageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getVersion,
    listLiveVersions,
    deleteByThreadId,
  } satisfies ProjectionThreadPageRepositoryShape;
});

export const ProjectionThreadPageRepositoryLive = Layer.effect(
  ProjectionThreadPageRepository,
  makeProjectionThreadPageRepository,
);
