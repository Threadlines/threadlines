import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProjectionThreadMessageSearch", (it) => {
  it.effect("backfills completed messages and tracks completion, edits, and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
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
            'message-complete',
            'thread-1',
            NULL,
            'assistant',
            'Completed migration needle',
            NULL,
            NULL,
            0,
            '2026-07-13T12:00:00.000Z',
            '2026-07-13T12:00:00.000Z'
          ),
          (
            'message-streaming',
            'thread-1',
            NULL,
            'assistant',
            'Streaming migration needle',
            NULL,
            NULL,
            1,
            '2026-07-13T12:01:00.000Z',
            '2026-07-13T12:01:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const search = (query: string) => sql<{ readonly messageId: string }>`
        SELECT message.message_id AS "messageId"
        FROM projection_thread_messages_fts
        JOIN projection_thread_messages AS message
          ON message.rowid = projection_thread_messages_fts.rowid
        WHERE projection_thread_messages_fts MATCH ${`"${query}"`}
        ORDER BY message.message_id ASC
      `;

      assert.deepStrictEqual(
        (yield* search("migration needle")).map((row) => row.messageId),
        ["message-complete"],
      );

      yield* sql`
        UPDATE projection_thread_messages
        SET is_streaming = 0
        WHERE message_id = 'message-streaming'
      `;
      assert.deepStrictEqual(
        (yield* search("migration needle")).map((row) => row.messageId),
        ["message-complete", "message-streaming"],
      );

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Edited searchable phrase'
        WHERE message_id = 'message-complete'
      `;
      assert.deepStrictEqual(
        (yield* search("migration needle")).map((row) => row.messageId),
        ["message-streaming"],
      );
      assert.deepStrictEqual(
        (yield* search("searchable phrase")).map((row) => row.messageId),
        ["message-complete"],
      );

      yield* sql`
        UPDATE projection_thread_messages
        SET is_streaming = 1
        WHERE message_id = 'message-complete'
      `;
      assert.deepStrictEqual(yield* search("searchable phrase"), []);

      yield* sql`
        DELETE FROM projection_thread_messages
        WHERE message_id = 'message-streaming'
      `;
      assert.deepStrictEqual(yield* search("migration needle"), []);
    }),
  );
});
