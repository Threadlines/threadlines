import { ProjectId, ThreadId } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { buildThreadSearchTokens, makeThreadSearch } from "./ThreadSearch.ts";

const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

layer("ThreadSearch", (it) => {
  it.effect("searches completed message substrings with project and thread lifecycle filters", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadSearch = yield* makeThreadSearch;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-recent',
            'project-a',
            'Unrelated title',
            NULL,
            NULL,
            NULL,
            '2026-07-13T10:00:00.000Z',
            '2026-07-13T14:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'thread-older',
            'project-b',
            'Another title',
            NULL,
            NULL,
            NULL,
            '2026-07-13T09:00:00.000Z',
            '2026-07-13T13:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-a',
            'Archived title',
            NULL,
            NULL,
            NULL,
            '2026-07-13T08:00:00.000Z',
            '2026-07-13T12:00:00.000Z',
            '2026-07-13T12:30:00.000Z',
            NULL
          ),
          (
            'thread-deleted',
            'project-a',
            'Deleted title',
            NULL,
            NULL,
            NULL,
            '2026-07-13T07:00:00.000Z',
            '2026-07-13T11:00:00.000Z',
            NULL,
            '2026-07-13T11:30:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          skills_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-recent',
            'thread-recent',
            NULL,
            'assistant',
            'The UI navbar spacing is now predictable.',
            NULL,
            NULL,
            0,
            '2026-07-13T14:00:00.000Z',
            '2026-07-13T14:00:00.000Z'
          ),
          (
            'message-older',
            'thread-older',
            NULL,
            'user',
            'Please revisit navbar spacing in the settings page.',
            NULL,
            NULL,
            0,
            '2026-07-13T13:00:00.000Z',
            '2026-07-13T13:00:00.000Z'
          ),
          (
            'message-streaming',
            'thread-recent',
            NULL,
            'assistant',
            'A streaming-only secret phrase.',
            NULL,
            NULL,
            1,
            '2026-07-13T14:01:00.000Z',
            '2026-07-13T14:01:00.000Z'
          ),
          (
            'message-archived',
            'thread-archived',
            NULL,
            'assistant',
            'Archived navbar spacing.',
            NULL,
            NULL,
            0,
            '2026-07-13T12:00:00.000Z',
            '2026-07-13T12:00:00.000Z'
          ),
          (
            'message-deleted',
            'thread-deleted',
            NULL,
            'assistant',
            'Deleted navbar spacing.',
            NULL,
            NULL,
            0,
            '2026-07-13T11:00:00.000Z',
            '2026-07-13T11:00:00.000Z'
          )
      `;

      const allMatches = yield* threadSearch.search({ query: "bar spa", limit: 10 });
      assert.deepStrictEqual(
        allMatches.matches.map((match) => match.threadId),
        ["thread-recent", "thread-older"],
      );
      assert.match(allMatches.matches[0]?.snippet ?? "", /navbar spacing/i);
      assert.equal(allMatches.truncated, false);

      const shortTokenMatch = yield* threadSearch.search({ query: "UI navbar", limit: 10 });
      assert.deepStrictEqual(
        shortTokenMatch.matches.map((match) => match.threadId),
        ["thread-recent"],
      );

      const projectMatches = yield* threadSearch.search({
        query: "navbar",
        projectIds: [ProjectId.make("project-b")],
        limit: 10,
      });
      assert.deepStrictEqual(
        projectMatches.matches.map((match) => match.threadId),
        ["thread-older"],
      );

      const limitedMatches = yield* threadSearch.search({ query: "navbar", limit: 1 });
      assert.equal(limitedMatches.matches.length, 1);
      assert.equal(limitedMatches.truncated, true);

      const streamingMatches = yield* threadSearch.search({ query: "secret phrase", limit: 10 });
      assert.deepStrictEqual(streamingMatches.matches, []);
    }),
  );

  it.effect("requires all terms, ranks phrase proximity, and honors quoted phrases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadSearch = yield* makeThreadSearch;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-exact',
            'project-a',
            'Exact phrase',
            NULL,
            NULL,
            NULL,
            '2026-07-13T09:00:00.000Z',
            '2026-07-13T09:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'thread-ordered',
            'project-a',
            'Ordered terms',
            NULL,
            NULL,
            NULL,
            '2026-07-13T10:00:00.000Z',
            '2026-07-13T12:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'thread-unordered',
            'project-a',
            'Unordered terms',
            NULL,
            NULL,
            NULL,
            '2026-07-13T11:00:00.000Z',
            '2026-07-13T13:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'thread-scattered',
            'project-a',
            'Scattered terms',
            NULL,
            NULL,
            NULL,
            '2026-07-13T12:00:00.000Z',
            '2026-07-13T14:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'thread-missing',
            'project-a',
            'Missing a term',
            NULL,
            NULL,
            NULL,
            '2026-07-13T13:00:00.000Z',
            '2026-07-13T15:00:00.000Z',
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          skills_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-exact',
            'thread-exact',
            NULL,
            'assistant',
            'Intro: testing how there works in practice.',
            NULL,
            NULL,
            0,
            '2026-07-13T09:00:00.000Z',
            '2026-07-13T09:00:00.000Z'
          ),
          (
            'message-exact-weaker',
            'thread-exact',
            NULL,
            'assistant',
            'There is also a newer testing note about how.',
            NULL,
            NULL,
            0,
            '2026-07-13T09:05:00.000Z',
            '2026-07-13T09:05:00.000Z'
          ),
          (
            'message-ordered',
            'thread-ordered',
            NULL,
            'user',
            'Testing can explain how we eventually got there.',
            NULL,
            NULL,
            0,
            '2026-07-13T12:00:00.000Z',
            '2026-07-13T12:00:00.000Z'
          ),
          (
            'message-unordered',
            'thread-unordered',
            NULL,
            'assistant',
            'There is a testing note about how this behaves.',
            NULL,
            NULL,
            0,
            '2026-07-13T13:00:00.000Z',
            '2026-07-13T13:00:00.000Z'
          ),
          (
            'message-scattered',
            'thread-scattered',
            NULL,
            'assistant',
            'There is the final marker. This deliberately long middle section separates every useful search term so the result preview must preserve multiple fragments instead of hiding a required word. Testing appears later, followed by another deliberately long stretch of prose before the remaining required marker: how.',
            NULL,
            NULL,
            0,
            '2026-07-13T14:00:00.000Z',
            '2026-07-13T14:00:00.000Z'
          ),
          (
            'message-missing',
            'thread-missing',
            NULL,
            'assistant',
            'Testing includes how but omits the final required term.',
            NULL,
            NULL,
            0,
            '2026-07-13T15:00:00.000Z',
            '2026-07-13T15:00:00.000Z'
          )
      `;

      const matches = yield* threadSearch.search({ query: "testing how there", limit: 10 });
      assert.deepStrictEqual(
        matches.matches.map((match) => match.threadId),
        ["thread-exact", "thread-ordered", "thread-unordered", "thread-scattered"],
      );
      assert.equal(matches.matches[0]?.messageId, "message-exact");
      assert.isBelow(matches.matches[0]?.score ?? Infinity, matches.matches[1]?.score ?? 0);
      assert.isBelow(matches.matches[1]?.score ?? Infinity, matches.matches[2]?.score ?? 0);
      assert.notInclude(
        matches.matches.map((match) => match.threadId),
        ThreadId.make("thread-missing"),
      );
      const scatteredSnippet = matches.matches.find(
        (match) => match.threadId === "thread-scattered",
      )?.snippet;
      assert.match(scatteredSnippet ?? "", /testing/i);
      assert.match(scatteredSnippet ?? "", /how/i);
      assert.match(scatteredSnippet ?? "", /there/i);
      assert.isBelow(
        scatteredSnippet?.toLowerCase().indexOf("there") ?? Infinity,
        scatteredSnippet?.toLowerCase().indexOf("testing") ?? 0,
      );

      const quotedMatches = yield* threadSearch.search({
        query: `"testing how there"`,
        limit: 10,
      });
      assert.deepStrictEqual(
        quotedMatches.matches.map((match) => match.threadId),
        ["thread-exact"],
      );
    }),
  );
});

it("builds a safe FTS query with quoted phrases and leaves short terms for filtering", () => {
  assert.deepStrictEqual(buildThreadSearchTokens(`UI "nav bar" spacing`), {
    ftsQuery: `"nav bar" AND "spacing"`,
    shortTokens: ["ui"],
  });
  assert.deepStrictEqual(buildThreadSearchTokens(`"UI x"`), {
    ftsQuery: `"ui x"`,
    shortTokens: [],
  });
  assert.equal(buildThreadSearchTokens("UI x"), null);
});
