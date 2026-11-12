/**
 * Themes this computer shared to the Showcase (migrations 106 and 109): a row
 * per share, written when it starts and settled once GitHub has its pull
 * request.
 */
import {
  GitHubLogin,
  ThemeContentHash,
  ThemeEntryId,
  ThemeShowcaseSlug,
  ThemeShowcaseSubmissionId,
  ThemeShowcaseSubmissionState,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class ThemeShowcaseRepositoryError extends Data.TaggedError("ThemeShowcaseRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export const ThemeShowcaseSubmissionRow = Schema.Struct({
  submissionId: ThemeShowcaseSubmissionId,
  entryId: ThemeEntryId,
  sourceHash: ThemeContentHash,
  publishedHash: ThemeContentHash,
  slug: ThemeShowcaseSlug,
  login: GitHubLogin,
  /** Null until GitHub has the pull request: the share is unfinished. */
  pullRequestNumber: Schema.NullOr(Schema.Int),
  pullRequestUrl: Schema.NullOr(Schema.String),
  state: ThemeShowcaseSubmissionState,
  /**
   * For a share that wasn't added: whether the person who shared it closed
   * its pull request. Null while that isn't known (or doesn't apply).
   */
  takenBack: Schema.NullOr(Schema.BooleanFromBit),
  createdAt: Schema.String,
  /** When the pull request's state was last looked up. */
  checkedAt: Schema.NullOr(Schema.String),
});
export type ThemeShowcaseSubmissionRow = typeof ThemeShowcaseSubmissionRow.Type;

export interface ThemeShowcaseRepositoryShape {
  /** Every share, newest first. */
  readonly list: Effect.Effect<
    ReadonlyArray<ThemeShowcaseSubmissionRow>,
    ThemeShowcaseRepositoryError
  >;
  readonly get: (
    submissionId: string,
  ) => Effect.Effect<Option.Option<ThemeShowcaseSubmissionRow>, ThemeShowcaseRepositoryError>;
  /** Writes a share whole, inserting or replacing it by id. */
  readonly put: (
    row: ThemeShowcaseSubmissionRow,
  ) => Effect.Effect<void, ThemeShowcaseRepositoryError>;
}

export class ThemeShowcaseRepository extends Context.Service<
  ThemeShowcaseRepository,
  ThemeShowcaseRepositoryShape
>()("threadlines/themes/ThemeShowcaseRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ThemeShowcaseRepositoryError({ operation, cause })),
      );

  const select = `
    SELECT
      submission_id AS "submissionId",
      entry_id AS "entryId",
      source_hash AS "sourceHash",
      published_hash AS "publishedHash",
      slug AS "slug",
      login AS "login",
      pull_request_number AS "pullRequestNumber",
      pull_request_url AS "pullRequestUrl",
      state AS "state",
      taken_back AS "takenBack",
      created_at AS "createdAt",
      checked_at AS "checkedAt"
    FROM theme_showcase_submissions
  `;
  const find = (where: string, params: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: ThemeShowcaseSubmissionRow,
      execute: () => sql.unsafe(`${select} ${where}`, [...params]),
    })(undefined);

  const list: ThemeShowcaseRepositoryShape["list"] = find(
    "ORDER BY created_at DESC, submission_id",
    [],
  ).pipe(wrap("list"));

  const get: ThemeShowcaseRepositoryShape["get"] = (submissionId) =>
    find("WHERE submission_id = ?", [submissionId]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("get"),
    );

  const put: ThemeShowcaseRepositoryShape["put"] = (row) =>
    sql`
      INSERT INTO theme_showcase_submissions (
        submission_id, entry_id, source_hash, published_hash, slug, login,
        pull_request_number, pull_request_url, state, taken_back, created_at, checked_at
      ) VALUES (
        ${row.submissionId},
        ${row.entryId},
        ${row.sourceHash},
        ${row.publishedHash},
        ${row.slug},
        ${row.login},
        ${row.pullRequestNumber},
        ${row.pullRequestUrl},
        ${row.state},
        ${row.takenBack === null ? null : row.takenBack ? 1 : 0},
        ${row.createdAt},
        ${row.checkedAt}
      )
      ON CONFLICT (submission_id) DO UPDATE SET
        entry_id = excluded.entry_id,
        source_hash = excluded.source_hash,
        published_hash = excluded.published_hash,
        slug = excluded.slug,
        login = excluded.login,
        pull_request_number = excluded.pull_request_number,
        pull_request_url = excluded.pull_request_url,
        state = excluded.state,
        taken_back = excluded.taken_back,
        created_at = excluded.created_at,
        checked_at = excluded.checked_at
    `.pipe(Effect.asVoid, wrap("put"));

  return ThemeShowcaseRepository.of({ list, get, put });
});

export const ThemeShowcaseRepositoryLive = Layer.effect(ThemeShowcaseRepository, make);
