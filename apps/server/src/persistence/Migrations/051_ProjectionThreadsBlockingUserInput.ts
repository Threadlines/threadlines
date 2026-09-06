import { countPendingUserInputs } from "@threadlines/shared/pendingRequests";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN blocking_user_input_count INTEGER NOT NULL DEFAULT 0
  `;

  // Only threads with open questions need a backfill. Replay the same request
  // rules as the projection so old prompts and failed answers stay consistent.
  const threads = yield* sql<{ threadId: string }>`
    SELECT thread_id AS "threadId" FROM projection_threads
    WHERE pending_user_input_count > 0
  `;
  for (const { threadId } of threads) {
    const activities = yield* sql<{ kind: string; payloadJson: string }>`
      SELECT kind, payload_json AS "payloadJson"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND json_valid(payload_json)
        AND kind IN ('user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed')
      ORDER BY sequence ASC, created_at ASC, activity_id ASC
    `;
    const counts = countPendingUserInputs(
      activities.map((activity) => ({
        kind: activity.kind,
        payload: JSON.parse(activity.payloadJson) as unknown,
      })),
    );
    yield* sql`
      UPDATE projection_threads
      SET blocking_user_input_count = ${counts.blockingUserInputCount}
      WHERE thread_id = ${threadId}
    `;
  }
});
