// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads OpenCode 2's model calls out of its SQLite database.
 *
 * OpenCode keeps no transcript files: every session lives in one
 * `opencode.db`, with a `session_message` row per model call (`assistant`) and
 * per compaction (`compaction`), each carrying its model, tokens and cost. The
 * database runs in WAL mode, so fresh rows sit in `opencode.db-wal` until a
 * checkpoint and the main file's mtime says nothing about them; it is queried
 * for the window on every scan instead of being cached like a transcript.
 *
 * @module usageOpenCode
 */
import { DatabaseSync } from "node:sqlite";

import type { UsageTokenTotals } from "@threadlines/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

/** One row of {@link OPENCODE_USAGE_QUERY}. */
export interface OpenCodeUsageRow {
  readonly id: string;
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

/**
 * The model calls and compactions since `:since`, one row each.
 *
 * A fork copies its parent's rows (new ids, original times) into the new
 * session, so rows older than a forked session itself are the parent's and
 * already counted there; OpenCode's own session stats skip them the same way.
 * Subagents are sessions of their own and count only their own calls.
 */
export const OPENCODE_USAGE_QUERY = `
SELECT m.id AS id,
  m.session_id AS sessionId,
  m.time_created AS timestampMs,
  json_extract(m.data, '$.model.providerID') AS providerId,
  json_extract(m.data, '$.model.id') AS modelId,
  coalesce(json_extract(m.data, '$.tokens.input'), 0) AS input,
  coalesce(json_extract(m.data, '$.tokens.output'), 0) AS output,
  coalesce(json_extract(m.data, '$.tokens.reasoning'), 0) AS reasoning,
  coalesce(json_extract(m.data, '$.tokens.cache.read'), 0) AS cacheRead,
  coalesce(json_extract(m.data, '$.tokens.cache.write'), 0) AS cacheWrite,
  coalesce(json_extract(m.data, '$.cost'), 0) AS costUsd
FROM session_message m
JOIN session_v2 s ON s.id = m.session_id
WHERE m.type IN ('assistant', 'compaction')
  AND m.time_created >= :since
  AND json_type(m.data, '$.tokens') = 'object'
  AND (s.fork_session_id IS NULL OR m.time_created >= s.time_created)
ORDER BY m.time_created`;

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Turns one row into a usage record.
 *
 * OpenCode's counts don't overlap: `input` leaves out the cached part and
 * `output` leaves out reasoning, where the usage contract counts reasoning
 * inside output. Its cost is the model's list price; a zero means it had no
 * rate (a free model, or a subscription sign-in), so the rate table prices it.
 */
export function openCodeUsageRecord(row: OpenCodeUsageRow): UsageRecord | null {
  const reasoningTokens = count(row.reasoning);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: count(row.input),
    cachedInputTokens: count(row.cacheRead),
    cacheCreationTokens: count(row.cacheWrite),
    outputTokens: count(row.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const modelId = row.modelId?.trim() ?? "";
  const providerId = row.providerId?.trim() ?? "";
  return {
    provider: "opencode",
    timestampMs: row.timestampMs,
    // OpenCode's own `provider/model`, as its model picker names it.
    model: modelId.length === 0 ? "opencode" : providerId ? `${providerId}/${modelId}` : modelId,
    sessionId: row.sessionId,
    totals,
    cacheCreation1hTokens: 0,
    reportedCostUsd: Number.isFinite(row.costUsd) && row.costUsd > 0 ? row.costUsd : null,
    dedupeKey: row.id,
  };
}

const isUsageRow = (row: Record<string, unknown>): boolean =>
  typeof row["id"] === "string" &&
  typeof row["sessionId"] === "string" &&
  typeof row["timestampMs"] === "number" &&
  typeof row["input"] === "number" &&
  typeof row["output"] === "number" &&
  typeof row["reasoning"] === "number" &&
  typeof row["cacheRead"] === "number" &&
  typeof row["cacheWrite"] === "number" &&
  typeof row["costUsd"] === "number";

/**
 * The usage in one OpenCode database since `sinceMs`, or `null` when it could
 * not be read (missing, or locked past the timeout). A database without
 * OpenCode 2's session tables (an older release's) holds none. Opened
 * read-only and never `immutable`, which would skip the WAL.
 */
export function readOpenCodeUsage(databasePath: string, sinceMs: number): UsageRecord[] | null {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 2_000 });
    const rows = database.prepare(OPENCODE_USAGE_QUERY).all({ since: Math.floor(sinceMs) });
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!isUsageRow(row)) continue;
      const record = openCodeUsageRecord(row as unknown as OpenCodeUsageRow);
      if (record !== null) records.push(record);
    }
    return records;
  } catch (cause) {
    return cause instanceof Error && /no such table/u.test(cause.message) ? [] : null;
  } finally {
    database?.close();
  }
}
