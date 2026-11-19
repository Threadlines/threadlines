import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A project's brief (docs/design/project-brief-notes.md): the user's standing
 * instructions for every thread in the project, kept outside the event log.
 * One row per project, so the text and its revision change together.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_briefs (
      project_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
