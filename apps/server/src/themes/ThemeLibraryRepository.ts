/**
 * The theme library's tables (migrations 104, 107 and 108): entries, with the
 * chat offer each was kept from, the content they name, and the shared pick.
 * Content rows are only ever added (and given a thumbnail); entries are
 * written whole, by id; the pick is one row, written whole.
 */
import {
  IsoDateTime,
  ThemeContentHash,
  ThemeEntry,
  ThemeEntrySummary,
  ThemeManifest,
  ThemePick,
  ThemePickTheme,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class ThemeLibraryRepositoryError extends Data.TaggedError("ThemeLibraryRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** One theme's content as stored, with what the library lists it by. */
export interface ThemeContentRow {
  readonly hash: ThemeContentHash;
  readonly manifest: ThemeManifest;
  readonly createdAt: string;
}

const EntryDbRow = Schema.Struct({ ...ThemeEntry.fields, deleted: Schema.BooleanFromBit });
const SummaryDbRow = Schema.Struct({ ...ThemeEntrySummary.fields, deleted: Schema.BooleanFromBit });
const ManifestDbRow = Schema.Struct({
  hash: ThemeContentHash,
  manifest: Schema.fromJsonString(ThemeManifest),
  createdAt: IsoDateTime,
});
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ThemeManifest));
const PickDbRow = Schema.Struct({
  theme: Schema.fromJsonString(ThemePickTheme),
  revision: ThemePick.fields.revision,
  revisedBy: ThemePick.fields.revisedBy,
  updatedAt: ThemePick.fields.updatedAt,
});
const encodePickTheme = Schema.encodeSync(Schema.fromJsonString(ThemePickTheme));

export interface ThemeLibraryRepositoryShape {
  /** Every entry with its content's summary, tombstones included, oldest first. */
  readonly listSummaries: Effect.Effect<
    ReadonlyArray<ThemeEntrySummary>,
    ThemeLibraryRepositoryError
  >;
  readonly listEntries: Effect.Effect<ReadonlyArray<ThemeEntry>, ThemeLibraryRepositoryError>;
  readonly getEntry: (
    entryId: string,
  ) => Effect.Effect<Option.Option<ThemeEntry>, ThemeLibraryRepositoryError>;
  readonly getSummary: (
    entryId: string,
  ) => Effect.Effect<Option.Option<ThemeEntrySummary>, ThemeLibraryRepositoryError>;
  readonly getContent: (
    hash: string,
  ) => Effect.Effect<Option.Option<ThemeContentRow>, ThemeLibraryRepositoryError>;
  /** Whether content is stored under this hash, without reading it. */
  readonly hasContent: (hash: string) => Effect.Effect<boolean, ThemeLibraryRepositoryError>;
  /** Stores content under its hash unless it is there already; true when it was new. */
  readonly insertContent: (
    row: ThemeContentRow,
  ) => Effect.Effect<boolean, ThemeLibraryRepositoryError>;
  /** Whether stored content with art has no thumbnail yet. */
  readonly lacksThumbnail: (hash: string) => Effect.Effect<boolean, ThemeLibraryRepositoryError>;
  readonly setThumbnail: (input: {
    readonly hash: string;
    readonly thumbnail: string;
  }) => Effect.Effect<void, ThemeLibraryRepositoryError>;
  /** Writes an entry whole, inserting or replacing it by id. */
  readonly putEntry: (entry: ThemeEntry) => Effect.Effect<void, ThemeLibraryRepositoryError>;
  /** The shared pick; none until someone picks a theme. */
  readonly getPick: Effect.Effect<Option.Option<ThemePick>, ThemeLibraryRepositoryError>;
  /** Writes the shared pick whole. */
  readonly putPick: (pick: ThemePick) => Effect.Effect<void, ThemeLibraryRepositoryError>;
}

export class ThemeLibraryRepository extends Context.Service<
  ThemeLibraryRepository,
  ThemeLibraryRepositoryShape
>()("threadlines/themes/ThemeLibraryRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ThemeLibraryRepositoryError({ operation, cause })),
      );

  const entryColumns = `
    e.entry_id AS "entryId",
    e.name AS "name",
    e.hash AS "hash",
    e.revision AS "revision",
    e.revised_by AS "revisedBy",
    e.deleted AS "deleted",
    e.created_at AS "createdAt",
    e.updated_at AS "updatedAt",
    e.offer_key AS "offerKey"
  `;
  const selectSummaries = `
    SELECT ${entryColumns},
      c.base AS "base",
      c.background AS "background",
      c.foreground AS "foreground",
      c.accent AS "accent",
      c.backdrop_mode AS "backdropMode",
      c.thumbnail AS "thumbnail"
    FROM theme_entries e
    JOIN theme_contents c ON c.hash = e.hash
  `;

  const findSummaries = (where: string, params: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: SummaryDbRow,
      execute: () => sql.unsafe(`${selectSummaries} ${where}`, [...params]),
    })(undefined);
  const findEntries = (where: string, params: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: EntryDbRow,
      execute: () =>
        sql.unsafe(`SELECT ${entryColumns} FROM theme_entries e ${where}`, [...params]),
    })(undefined);

  const listSummaries: ThemeLibraryRepositoryShape["listSummaries"] = findSummaries(
    "ORDER BY e.created_at, e.entry_id",
    [],
  ).pipe(wrap("listSummaries"));

  const listEntries: ThemeLibraryRepositoryShape["listEntries"] = findEntries(
    "ORDER BY e.created_at, e.entry_id",
    [],
  ).pipe(wrap("listEntries"));

  const getEntry: ThemeLibraryRepositoryShape["getEntry"] = (entryId) =>
    findEntries("WHERE e.entry_id = ?", [entryId]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getEntry"),
    );

  const getSummary: ThemeLibraryRepositoryShape["getSummary"] = (entryId) =>
    findSummaries("WHERE e.entry_id = ?", [entryId]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getSummary"),
    );

  const getContent: ThemeLibraryRepositoryShape["getContent"] = (hash) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: ManifestDbRow,
      execute: () =>
        sql`
          SELECT hash AS "hash", manifest_json AS "manifest", created_at AS "createdAt"
          FROM theme_contents WHERE hash = ${hash}
        `,
    })(undefined).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getContent"),
    );

  const hasContent: ThemeLibraryRepositoryShape["hasContent"] = (hash) =>
    sql<{ readonly hash: string }>`SELECT hash FROM theme_contents WHERE hash = ${hash}`.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("hasContent"),
    );

  const insertContent: ThemeLibraryRepositoryShape["insertContent"] = (row) =>
    Effect.gen(function* () {
      const { manifest } = row;
      const inserted = yield* sql<{ readonly hash: string }>`
        INSERT INTO theme_contents (
          hash, manifest_json, base, background, foreground, accent, backdrop_mode, thumbnail, created_at
        ) VALUES (
          ${row.hash},
          ${encodeManifest(manifest)},
          ${manifest.base},
          ${manifest.colors.background},
          ${manifest.colors.foreground},
          ${manifest.colors.accent},
          ${manifest.backdrop?.mode ?? null},
          ${null},
          ${row.createdAt}
        )
        ON CONFLICT (hash) DO NOTHING
        RETURNING hash
      `;
      return inserted.length > 0;
    }).pipe(wrap("insertContent"));

  const lacksThumbnail: ThemeLibraryRepositoryShape["lacksThumbnail"] = (hash) =>
    sql<{ readonly hash: string }>`
      SELECT hash FROM theme_contents
      WHERE hash = ${hash} AND backdrop_mode IS NOT NULL AND thumbnail IS NULL
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("lacksThumbnail"),
    );

  const setThumbnail: ThemeLibraryRepositoryShape["setThumbnail"] = (input) =>
    sql`UPDATE theme_contents SET thumbnail = ${input.thumbnail} WHERE hash = ${input.hash}`.pipe(
      Effect.asVoid,
      wrap("setThumbnail"),
    );

  const putEntry: ThemeLibraryRepositoryShape["putEntry"] = (entry) =>
    sql`
      INSERT INTO theme_entries (
        entry_id, name, hash, revision, revised_by, deleted, created_at, updated_at, offer_key
      ) VALUES (
        ${entry.entryId},
        ${entry.name},
        ${entry.hash},
        ${entry.revision},
        ${entry.revisedBy},
        ${entry.deleted ? 1 : 0},
        ${entry.createdAt},
        ${entry.updatedAt},
        ${entry.offerKey ?? null}
      )
      ON CONFLICT (entry_id) DO UPDATE SET
        name = excluded.name,
        hash = excluded.hash,
        revision = excluded.revision,
        revised_by = excluded.revised_by,
        deleted = excluded.deleted,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        offer_key = excluded.offer_key
    `.pipe(Effect.asVoid, wrap("putEntry"));

  const getPick: ThemeLibraryRepositoryShape["getPick"] = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PickDbRow,
    execute: () =>
      sql`
        SELECT theme_json AS "theme", revision AS "revision", revised_by AS "revisedBy",
          updated_at AS "updatedAt"
        FROM theme_pick WHERE id = 1
      `,
  })(undefined).pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0])),
    wrap("getPick"),
  );

  const putPick: ThemeLibraryRepositoryShape["putPick"] = (pick) =>
    sql`
      INSERT INTO theme_pick (id, theme_json, revision, revised_by, updated_at)
      VALUES (1, ${encodePickTheme(pick.theme)}, ${pick.revision}, ${pick.revisedBy}, ${pick.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        theme_json = excluded.theme_json,
        revision = excluded.revision,
        revised_by = excluded.revised_by,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, wrap("putPick"));

  return ThemeLibraryRepository.of({
    listSummaries,
    listEntries,
    getEntry,
    getSummary,
    getContent,
    hasContent,
    insertContent,
    lacksThumbnail,
    setThumbnail,
    putEntry,
    getPick,
    putPick,
  });
});

export const ThemeLibraryRepositoryLive = Layer.effect(ThemeLibraryRepository, make);
