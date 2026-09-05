import { ThreadActivityAppendedPayload, type OrchestrationSubagent } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { projectSubagentActivity } from "../../orchestration/subagentProjection.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeActivity = Schema.decodeUnknownOption(
  Schema.fromJsonString(ThreadActivityAppendedPayload),
);

/** Order transcript entries by their first durable event, even after a clock correction. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN event_sequence INTEGER`;
  yield* sql`
    WITH first_events AS (
      SELECT stream_id, json_extract(payload_json, '$.messageId') AS item_id,
             MIN(sequence) AS first_sequence
      FROM orchestration_events
      WHERE event_type IN ('thread.message-sent', 'thread.follow-up-accepted')
      GROUP BY stream_id, json_extract(payload_json, '$.messageId')
    )
    UPDATE projection_thread_messages
    SET event_sequence = (
      SELECT first_sequence FROM first_events
      WHERE stream_id = projection_thread_messages.thread_id
        AND item_id = projection_thread_messages.message_id
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_event_order
    ON projection_thread_messages(thread_id, event_sequence, created_at, message_id)
  `;

  yield* sql`ALTER TABLE projection_thread_proposed_plans ADD COLUMN event_sequence INTEGER`;
  yield* sql`
    WITH first_events AS (
      SELECT stream_id, json_extract(payload_json, '$.proposedPlan.id') AS item_id,
             MIN(sequence) AS first_sequence
      FROM orchestration_events
      WHERE event_type IN ('thread.proposed-plan-upserted')
      GROUP BY stream_id, json_extract(payload_json, '$.proposedPlan.id')
    )
    UPDATE projection_thread_proposed_plans
    SET event_sequence = (
      SELECT first_sequence FROM first_events
      WHERE stream_id = projection_thread_proposed_plans.thread_id
        AND item_id = projection_thread_proposed_plans.plan_id
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_proposed_plans_event_order
    ON projection_thread_proposed_plans(thread_id, event_sequence, created_at, plan_id)
  `;

  yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN event_sequence INTEGER`;
  yield* sql`
    WITH first_events AS (
      SELECT stream_id, json_extract(payload_json, '$.activity.id') AS item_id,
             MIN(sequence) AS first_sequence
      FROM orchestration_events
      WHERE event_type IN ('thread.activity-appended')
      GROUP BY stream_id, json_extract(payload_json, '$.activity.id')
    )
    UPDATE projection_thread_activities
    SET event_sequence = (
      SELECT first_sequence FROM first_events
      WHERE stream_id = projection_thread_activities.thread_id
        AND item_id = projection_thread_activities.activity_id
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_event_order
    ON projection_thread_activities(thread_id, event_sequence, sequence, created_at, activity_id)
  `;

  yield* sql`ALTER TABLE projection_thread_subagents ADD COLUMN result_event_sequence INTEGER`;
  yield* sql`ALTER TABLE projection_thread_subagents ADD COLUMN live_event_sequence INTEGER`;

  // Replay only retained roster activities, so reverted runs cannot restore results.
  // Update ordering metadata alone; keep every existing roster field untouched.
  const threads = yield* sql<{
    thread_id: string;
  }>`SELECT DISTINCT thread_id FROM projection_thread_subagents`;
  for (const { thread_id: threadId } of threads) {
    const events = yield* sql<{ sequence: number; payload_json: string }>`
      SELECT event.sequence, event.payload_json
      FROM orchestration_events AS event
      WHERE event.aggregate_kind = 'thread' AND event.stream_id = ${threadId}
        AND event.event_type = 'thread.activity-appended'
        AND json_valid(event.payload_json)
        AND (
          json_extract(event.payload_json, '$.activity.kind') IN ('task.started', 'task.progress', 'task.completed', 'subagent.metadata')
          OR json_extract(event.payload_json, '$.activity.payload.itemType') = 'collab_agent_tool_call'
        )
        AND EXISTS (
          SELECT 1 FROM projection_thread_activities AS activity
          WHERE activity.thread_id = ${threadId}
            AND activity.activity_id = json_extract(event.payload_json, '$.activity.id')
        )
      ORDER BY event.sequence ASC
    `;
    let subagents: ReadonlyArray<OrchestrationSubagent> = [];
    for (const event of events) {
      const decoded = decodeActivity(event.payload_json);
      if (Option.isNone(decoded)) continue;
      subagents = projectSubagentActivity(subagents, {
        ...decoded.value.activity,
        eventSequence: event.sequence,
      });
    }
    for (const subagent of subagents) {
      yield* sql`
        UPDATE projection_thread_subagents
        SET result_event_sequence = CASE WHEN result_body IS ${subagent.resultBody}
              THEN ${subagent.resultEventSequence ?? null} ELSE NULL END,
            live_event_sequence = ${subagent.liveEventSequence ?? null}
        WHERE thread_id = ${threadId} AND subagent_id = ${subagent.id}
      `;
    }
  }
});
