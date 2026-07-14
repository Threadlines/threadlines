import {
  OrchestrationThreadSearchInput,
  OrchestrationThreadSearchMatch,
} from "@threadlines/contracts";
import {
  analyzeSearchText,
  buildSearchTextSnippet,
  parseSearchQuery,
} from "@threadlines/shared/searchRanking";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type * as Statement from "effect/unstable/sql/Statement";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadSearch, type ThreadSearchShape } from "../Services/ThreadSearch.ts";

interface ThreadSearchTokens {
  readonly ftsQuery: string;
  readonly shortTokens: ReadonlyArray<string>;
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

export function buildThreadSearchTokens(query: string): ThreadSearchTokens | null {
  const clauses = parseSearchQuery(query).clauses;
  const indexedClauses = clauses.filter((clause) => Array.from(clause.value).length >= 3);
  if (indexedClauses.length === 0) {
    return null;
  }

  return {
    ftsQuery: indexedClauses.map((clause) => quoteFtsPhrase(clause.value)).join(" AND "),
    shortTokens: clauses
      .filter((clause) => Array.from(clause.value).length < 3)
      .map((clause) => clause.value),
  };
}

const THREAD_SEARCH_MESSAGES_PER_THREAD = 8;
const THREAD_SEARCH_CANDIDATE_LIMIT_MULTIPLIER = 8;
const THREAD_SEARCH_MAX_CANDIDATES = 800;
const THREAD_SEARCH_SNIPPET_LENGTH = 180;

export const makeThreadSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchRows = SqlSchema.findAll({
    Request: OrchestrationThreadSearchInput,
    Result: OrchestrationThreadSearchMatch,
    execute: (input) => {
      const tokens = buildThreadSearchTokens(input.query);
      const candidateLimit = Math.min(
        THREAD_SEARCH_MAX_CANDIDATES,
        Math.max(input.limit + 1, input.limit * THREAD_SEARCH_CANDIDATE_LIMIT_MULTIPLIER),
      );
      const filters: Statement.Fragment[] = [
        sql`projection_thread_messages_fts MATCH ${tokens?.ftsQuery ?? ``}`,
        sql`thread.deleted_at IS NULL`,
        sql`thread.archived_at IS NULL`,
      ];

      if (input.projectIds !== undefined) {
        filters.push(sql.in("project_id", input.projectIds));
      }
      for (const token of tokens?.shortTokens ?? []) {
        filters.push(sql`instr(lower(message.text), ${token}) > 0`);
      }

      return sql`
        WITH ranked_matches AS (
          SELECT
            message.thread_id AS "threadId",
            message.message_id AS "messageId",
            message.role,
            message.text AS snippet,
            0 AS score,
            thread.updated_at AS thread_updated_at,
            message.rowid AS message_rowid,
            ROW_NUMBER() OVER (
              PARTITION BY message.thread_id
              ORDER BY projection_thread_messages_fts.rank ASC, message.rowid DESC
            ) AS thread_match_rank
          FROM projection_thread_messages_fts
          JOIN projection_thread_messages AS message
            ON message.rowid = projection_thread_messages_fts.rowid
          JOIN projection_threads AS thread
            ON thread.thread_id = message.thread_id
          WHERE ${sql.and(filters)}
        )
        SELECT
          "threadId",
          "messageId",
          role,
          snippet,
          score
        FROM ranked_matches
        WHERE thread_match_rank <= ${THREAD_SEARCH_MESSAGES_PER_THREAD}
        ORDER BY
          thread_match_rank ASC,
          thread_updated_at DESC,
          "threadId" DESC,
          message_rowid DESC
        LIMIT ${candidateLimit}
      `;
    },
  });

  const search: ThreadSearchShape["search"] = (input) => {
    if (buildThreadSearchTokens(input.query) === null) {
      return Effect.succeed({ matches: [], truncated: false });
    }

    const parsedQuery = parseSearchQuery(input.query);
    const candidateLimit = Math.min(
      THREAD_SEARCH_MAX_CANDIDATES,
      Math.max(input.limit + 1, input.limit * THREAD_SEARCH_CANDIDATE_LIMIT_MULTIPLIER),
    );

    return searchRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadSearch.search:query")),
      Effect.map((rows) => {
        const bestByThread = new Map<
          OrchestrationThreadSearchMatch["threadId"],
          OrchestrationThreadSearchMatch & { readonly candidateIndex: number }
        >();

        rows.forEach((row, candidateIndex) => {
          const analysis = analyzeSearchText(row.snippet, parsedQuery);
          if (!analysis) {
            return;
          }
          const candidate = {
            ...row,
            score: analysis.score,
            snippet: buildSearchTextSnippet(row.snippet, parsedQuery, {
              maxLength: THREAD_SEARCH_SNIPPET_LENGTH,
            }),
            candidateIndex,
          };
          const existing = bestByThread.get(row.threadId);
          if (
            !existing ||
            candidate.score < existing.score ||
            (candidate.score === existing.score && candidateIndex < existing.candidateIndex)
          ) {
            bestByThread.set(row.threadId, candidate);
          }
        });

        const rankedMatches = [...bestByThread.values()].toSorted(
          (left, right) => left.score - right.score || left.candidateIndex - right.candidateIndex,
        );
        return {
          matches: rankedMatches
            .slice(0, input.limit)
            .map(({ candidateIndex: _, ...match }) => match),
          truncated: rankedMatches.length > input.limit || rows.length >= candidateLimit,
        };
      }),
    );
  };

  return { search } satisfies ThreadSearchShape;
});

export const ThreadSearchLive = Layer.effect(ThreadSearch, makeThreadSearch);
