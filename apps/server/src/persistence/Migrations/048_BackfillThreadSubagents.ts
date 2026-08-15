import type { OrchestrationSubagent, OrchestrationThreadActivity } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { projectSubagentActivity } from "../../orchestration/subagentProjection.ts";

interface ActivityRow {
  readonly activity_id: string;
  readonly turn_id: string | null;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload_json: string;
  readonly sequence: number | null;
  readonly created_at: string;
}

/** The rows that can move the roster fold: collab tool items create/update
 *  agents, the task stream links transcripts and settles completions, and
 *  subagent.metadata enriches identity. Everything else is a no-op in
 *  projectSubagentActivity, so it never has to be loaded. */
const CANDIDATE_FILTER = `
  json_extract(payload_json, '$.itemType') = 'collab_agent_tool_call'
  OR kind IN ('task.started', 'task.progress', 'task.completed', 'subagent.metadata')
`;

/**
 * Rebuilds the durable subagent roster from the activity projection. The
 * incremental fold in the projection pipeline only recognized Codex-shaped
 * collab items (`data.item`) until now, so threads whose agents ran through
 * Claude's Agent/Task tool never got a roster row. The fold now understands
 * both shapes; replaying every affected thread's activities through it settles
 * the historical record the same way live ingestion does going forward.
 *
 * Replay order is `rowid` — the order the rows were first appended, which is
 * the order the incremental fold saw them. The listing sort (sequence, then
 * created_at, then activity id) is not usable here: lifecycle rows often share
 * a timestamp and carry random ids, and replaying a completion before its
 * update would resurrect a settled agent. Threads are processed one at a time
 * so memory stays proportional to a single thread's agent activity.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threads = (yield* sql.unsafe(`
    SELECT DISTINCT thread_id FROM projection_thread_activities WHERE ${CANDIDATE_FILTER}
  `)) as unknown as ReadonlyArray<{ readonly thread_id: string }>;

  for (const { thread_id: threadId } of threads) {
    const rows = (yield* sql.unsafe(
      `
        SELECT activity_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        FROM projection_thread_activities
        WHERE thread_id = ? AND (${CANDIDATE_FILTER})
        ORDER BY rowid ASC
      `,
      [threadId],
    )) as unknown as ReadonlyArray<ActivityRow>;

    let subagents: ReadonlyArray<OrchestrationSubagent> = [];
    for (const row of rows) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const activity = {
        id: row.activity_id,
        tone: row.tone,
        kind: row.kind,
        summary: row.summary,
        payload,
        turnId: row.turn_id,
        ...(row.sequence !== null ? { sequence: row.sequence } : {}),
        createdAt: row.created_at,
      } as unknown as OrchestrationThreadActivity;
      subagents = projectSubagentActivity(subagents, activity);
    }

    yield* sql`DELETE FROM projection_thread_subagents WHERE thread_id = ${threadId}`;
    if (subagents.length === 0) continue;
    yield* sql`
      INSERT INTO projection_thread_subagents ${sql.insert(
        subagents.map((row) => ({
          thread_id: threadId,
          subagent_id: row.id,
          agent_thread_id: row.agentThreadId,
          parent_agent_thread_id: row.parentAgentThreadId,
          spawn_call_id: row.spawnCallId,
          transcript_agent_id: row.transcriptAgentId,
          turn_id: row.turnId,
          agent_path: row.agentPath,
          parent_agent_path: row.parentAgentPath,
          tree_depth: row.treeDepth,
          nickname: row.nickname,
          role: row.role,
          objective: row.objective,
          status: row.status,
          requested_model: row.requestedModel,
          resolved_model: row.resolvedModel,
          reasoning_effort: row.reasoningEffort,
          model_provenance: row.modelProvenance,
          reasoning_effort_provenance: row.reasoningEffortProvenance,
          result_body: row.resultBody,
          result_created_at: row.resultCreatedAt,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        })),
      )}
    `;
  }
});
