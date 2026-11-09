import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Themes this computer shared to the Showcase (docs/design/custom-themes.md,
 * "Showcase"), one row per share.
 *
 * - `theme_showcase_submissions`: written when a share starts, with the
 *   folder (`slug`) and file it publishes, so sending the same share again
 *   picks up where it stopped. `pull_request_number` and `pull_request_url`
 *   are filled in once GitHub has the pull request; until then the share is
 *   unfinished and the app doesn't list it. `state` follows the pull request
 *   (inReview, listed, notAdded), looked up again at most every few minutes
 *   (`checked_at`).
 *
 * A new table only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS theme_showcase_submissions (
      submission_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      published_hash TEXT NOT NULL,
      slug TEXT NOT NULL,
      login TEXT NOT NULL,
      pull_request_number INTEGER,
      pull_request_url TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      checked_at TEXT
    )
  `;
});
