/**
 * ProjectNoteRepository: `project_notes` and `project_note_suggestions`
 * (docs/design/project-brief-notes.md, "Storage"). A suggestion is inserted
 * and deleted, never updated. Whoever changes more than one row at once runs
 * it inside `transaction`.
 */
import {
  IsoDateTime,
  LeadPassCeiling,
  ProjectId,
  type ProjectNote,
  ProjectNoteAgentAuthor,
  ProjectNoteAuthor,
  ProjectNoteId,
  ProjectNoteSummary,
  type ProjectNoteSuggestion,
  ProjectNoteSuggestionId,
  ProjectNoteText,
  ProjectNoteTitle,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";

const NoteRow = Schema.Struct({
  id: ProjectNoteId,
  projectId: ProjectId,
  title: ProjectNoteTitle,
  summary: ProjectNoteSummary,
  text: ProjectNoteText,
  approved: Schema.BooleanFromBit,
  writerCeiling: Schema.NullOr(Schema.fromJsonString(LeadPassCeiling)),
  author: Schema.fromJsonString(ProjectNoteAuthor),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const SuggestionRow = Schema.Struct({
  id: ProjectNoteSuggestionId,
  projectId: ProjectId,
  title: ProjectNoteTitle,
  summary: ProjectNoteSummary,
  text: ProjectNoteText,
  author: Schema.fromJsonString(ProjectNoteAgentAuthor),
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
});

const encodeNote = Schema.encodeEffect(NoteRow);
const encodeSuggestion = Schema.encodeEffect(SuggestionRow);

export interface ProjectNoteRepositoryShape {
  readonly listNotes: () => Effect.Effect<ReadonlyArray<ProjectNote>, PersistenceSqlError>;
  readonly listNotesByProjectId?: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectNote>, PersistenceSqlError>;
  readonly listSuggestions: () => Effect.Effect<
    ReadonlyArray<ProjectNoteSuggestion>,
    PersistenceSqlError
  >;
  /** Inserts the note, or replaces the row with its id. */
  readonly putNote: (note: ProjectNote) => Effect.Effect<void, PersistenceSqlError>;
  readonly deleteNote: (id: ProjectNoteId) => Effect.Effect<void, PersistenceSqlError>;
  readonly insertSuggestion: (
    suggestion: ProjectNoteSuggestion,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly deleteSuggestions: (
    ids: ReadonlyArray<ProjectNoteSuggestionId>,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Runs `effect` as one transaction. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PersistenceSqlError, R>;
}

export class ProjectNoteRepository extends Context.Service<
  ProjectNoteRepository,
  ProjectNoteRepositoryShape
>()("threadlines/projectContext/ProjectNoteRepository") {}

export const makeProjectNoteRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectNotes = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NoteRow,
    execute: () => sql`
      SELECT id, project_id AS "projectId", title, summary, text, approved,
        writer_ceiling_json AS "writerCeiling", author_json AS "author",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_notes
      ORDER BY created_at, id
    `,
  });

  const selectNotesByProjectId = SqlSchema.findAll({
    Request: ProjectId,
    Result: NoteRow,
    execute: (projectId) => sql`
      SELECT id, project_id AS "projectId", title, summary, text, approved,
        writer_ceiling_json AS "writerCeiling", author_json AS "author",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_notes
      WHERE project_id = ${projectId}
      ORDER BY created_at, id
    `,
  });

  const selectSuggestions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SuggestionRow,
    execute: () => sql`
      SELECT id, project_id AS "projectId", title, summary, text,
        author_json AS "author", thread_id AS "threadId", turn_id AS "turnId",
        created_at AS "createdAt"
      FROM project_note_suggestions
      ORDER BY created_at, id
    `,
  });

  const listNotes: ProjectNoteRepositoryShape["listNotes"] = () =>
    selectNotes(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.listNotes")),
    );

  const listNotesByProjectId: NonNullable<ProjectNoteRepositoryShape["listNotesByProjectId"]> = (
    projectId,
  ) =>
    selectNotesByProjectId(projectId).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.listNotesByProjectId")),
    );

  const listSuggestions: ProjectNoteRepositoryShape["listSuggestions"] = () =>
    selectSuggestions(undefined).pipe(
      Effect.map((rows) =>
        rows.map(({ threadId: _threadId, ...suggestion }): ProjectNoteSuggestion => suggestion),
      ),
      Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.listSuggestions")),
    );

  const putNote: ProjectNoteRepositoryShape["putNote"] = (note) =>
    Effect.gen(function* () {
      const row = yield* encodeNote(note);
      yield* sql`
        INSERT INTO project_notes (
          id, project_id, title, summary, text, approved, writer_ceiling_json,
          author_json, created_at, updated_at
        )
        VALUES (
          ${row.id}, ${row.projectId}, ${row.title}, ${row.summary}, ${row.text},
          ${row.approved}, ${row.writerCeiling}, ${row.author}, ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          text = excluded.text,
          approved = excluded.approved,
          writer_ceiling_json = excluded.writer_ceiling_json,
          author_json = excluded.author_json,
          updated_at = excluded.updated_at
      `;
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.putNote")));

  const deleteNote: ProjectNoteRepositoryShape["deleteNote"] = (id) =>
    sql`DELETE FROM project_notes WHERE id = ${id}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.deleteNote")),
    );

  const insertSuggestion: ProjectNoteRepositoryShape["insertSuggestion"] = (suggestion) =>
    Effect.gen(function* () {
      const row = yield* encodeSuggestion({ ...suggestion, threadId: suggestion.author.threadId });
      yield* sql`
        INSERT INTO project_note_suggestions (
          id, project_id, title, summary, text, author_json, thread_id, turn_id, created_at
        )
        VALUES (
          ${row.id}, ${row.projectId}, ${row.title}, ${row.summary}, ${row.text},
          ${row.author}, ${row.threadId}, ${row.turnId}, ${row.createdAt}
        )
      `;
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.insertSuggestion")));

  const deleteSuggestions: ProjectNoteRepositoryShape["deleteSuggestions"] = (ids) =>
    ids.length === 0
      ? Effect.void
      : sql`DELETE FROM project_note_suggestions WHERE ${sql.in("id", ids)}`.pipe(
          Effect.asVoid,
          Effect.mapError(toPersistenceSqlError("ProjectNoteRepository.deleteSuggestions")),
        );

  const transaction: ProjectNoteRepositoryShape["transaction"] = (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? toPersistenceSqlError("ProjectNoteRepository.transaction")(error)
            : error,
        ),
      );

  return {
    listNotes,
    listNotesByProjectId,
    listSuggestions,
    putNote,
    deleteNote,
    insertSuggestion,
    deleteSuggestions,
    transaction,
  } satisfies ProjectNoteRepositoryShape;
});

export const ProjectNoteRepositoryLive = Layer.effect(
  ProjectNoteRepository,
  makeProjectNoteRepository,
);
