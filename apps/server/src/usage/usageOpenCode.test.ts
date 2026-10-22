// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readOpenCodeUsage } from "./usageOpenCode.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

/** The two OpenCode 2.1.3 tables the query reads, with only the columns it reads. */
function openCodeDatabase(): { readonly path: string; readonly database: DatabaseSync } {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usage-opencode-"));
  folders.push(folder);
  const path = NodePath.join(folder, "opencode.db");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, fork_session_id text, time_created integer NOT NULL);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  return { path, database };
}

function addMessage(
  database: DatabaseSync,
  row: { id: string; session: string; type: string; at: number; data: unknown },
): void {
  database
    .prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .run(row.id, row.session, row.type, row.at, row.at, JSON.stringify(row.data));
}

/** An assistant row's `data` as OpenCode 2.1.3 writes it. */
const call = (cost: number) => ({
  time: { created: 0 },
  model: { id: "claude-sonnet-5", providerID: "anthropic", variant: "default" },
  finish: "stop",
  cost,
  tokens: { input: 103, output: 53, reasoning: 7, cache: { read: 8192, write: 40 } },
});

describe("readOpenCodeUsage", () => {
  it("reads each model call and compaction once, skipping the rows a fork copied", () => {
    const { path, database } = openCodeDatabase();
    database
      .prepare(
        "INSERT INTO session_v2 (id, parent_id, fork_session_id, time_created) VALUES (?, ?, ?, ?)",
      )
      .run("ses_parent", null, null, 1_000);
    database
      .prepare(
        "INSERT INTO session_v2 (id, parent_id, fork_session_id, time_created) VALUES (?, ?, ?, ?)",
      )
      .run("ses_fork", null, "ses_parent", 5_000);
    addMessage(database, {
      id: "msg_1",
      session: "ses_parent",
      type: "assistant",
      at: 2_000,
      data: call(0.01),
    });
    addMessage(database, {
      id: "msg_2",
      session: "ses_parent",
      type: "compaction",
      at: 3_000,
      data: call(0),
    });
    addMessage(database, {
      id: "msg_u",
      session: "ses_parent",
      type: "user",
      at: 2_500,
      data: { text: "hi" },
    });
    // The fork's copy of msg_1 keeps msg_1's time, which is older than the fork.
    addMessage(database, {
      id: "ev_1_0",
      session: "ses_fork",
      type: "assistant",
      at: 2_000,
      data: call(0.01),
    });
    addMessage(database, {
      id: "msg_3",
      session: "ses_fork",
      type: "assistant",
      at: 6_000,
      data: call(0.02),
    });
    database.close();

    const records = readOpenCodeUsage(path, 0);

    expect(records?.map((record) => record.dedupeKey)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(records?.[0]).toEqual({
      provider: "opencode",
      timestampMs: 2_000,
      model: "anthropic/claude-sonnet-5",
      sessionId: "ses_parent",
      // OpenCode keeps reasoning out of output; the contract counts it inside.
      totals: {
        uncachedInputTokens: 103,
        cachedInputTokens: 8192,
        cacheCreationTokens: 40,
        outputTokens: 60,
        reasoningTokens: 7,
      },
      cacheCreation1hTokens: 0,
      reportedCostUsd: 0.01,
      dedupeKey: "msg_1",
    });
    // A zero cost is a model without a rate, left for the rate table to price.
    expect(records?.[1]?.reportedCostUsd).toBeNull();
    expect(readOpenCodeUsage(path, 4_000)?.map((record) => record.dedupeKey)).toEqual(["msg_3"]);
  });

  it("returns null for a database it cannot read, and nothing for an older layout", () => {
    expect(readOpenCodeUsage(NodePath.join(NodeOS.tmpdir(), "no-such-opencode.db"), 0)).toBeNull();
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usage-opencode-"));
    folders.push(folder);
    const older = new DatabaseSync(NodePath.join(folder, "opencode-next.db"));
    older.exec("CREATE TABLE message (id text PRIMARY KEY)");
    older.close();
    expect(readOpenCodeUsage(NodePath.join(folder, "opencode-next.db"), 0)).toEqual([]);
  });
});
