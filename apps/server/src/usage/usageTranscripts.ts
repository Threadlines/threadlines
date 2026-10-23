/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Both parsers are line-at-a-time reducers so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@threadlines/contracts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  /**
   * Portion of `totals.cacheCreationTokens` written with the 1-hour cache TTL,
   * which Anthropic bills above the 5-minute rate. Kept off the wire: buckets
   * report the flat write total, and only pricing needs the split.
   */
  readonly cacheCreation1hTokens: number;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage, and
 * the lines that do not are frequently the largest. Skipping them without
 * parsing is worth roughly an order of magnitude on a 30-day window.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  switch (provider) {
    case "claude":
      return line.includes('"usage"');
    case "codex":
      return line.includes('"token_count"');
    case "grok":
      return line.includes('"turn_completed"');
    case "pi":
      return line.includes('"usage"');
    case "muse":
      // Model calls, plus the status lines that name an approval check's model.
      return line.includes('"model_completed"') || line.includes('"kind":"status"');
    case "opencode":
      // A database, read by `usageOpenCode`, never a transcript.
      return false;
    case "fx":
      // Threadlines' own ledger: every line is a turn.
      return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * The CLI writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts badly, so the caller must drop repeats by
 * `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  // Older CLI builds wrote a `costUSD` per record; current ones do not. Read it
  // when present rather than assuming either way.
  const cost = record["costUSD"];

  const cacheCreationTokens = int(usageRecord["cache_creation_input_tokens"]);
  // The nested `cache_creation` object splits the write total into 5m and 1h
  // ephemeral buckets. Claude Code writes most of its cache with the 1h TTL,
  // which bills at 2x input rather than the 5m TTL's 1.25x, so the split is
  // carried through to pricing. Clamped: the parts can never exceed the total.
  const cacheCreation = usageRecord["cache_creation"];
  const cacheCreation1hTokens = Math.min(
    cacheCreationTokens,
    typeof cacheCreation === "object" && cacheCreation !== null
      ? int((cacheCreation as Record<string, unknown>)["ephemeral_1h_input_tokens"])
      : 0,
  );

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens,
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    cacheCreation1hTokens,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms in real Threadlines forks), while the
 * child's first genuine usage event only lands after a real model turn
 * (observed seconds). One second of separation splits the two cleanly;
 * `ccusage` uses the same threshold.
 *
 * This matters more for Threadlines than for a plain CLI install: forking a
 * Codex thread is a first-class feature here, so forked rollouts are common and
 * naive summing would multiply their prefix turns by the fork count.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  // Present but `null` on ordinary rollouts, so the type check is load-bearing.
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  // `source` is a plain string ("vscode", "cli") on ordinary rollouts.
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided consecutive
 * duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    // `turn_context` payloads carry `model` at the top level and no `type` of
    // their own, so the envelope type is the only reliable discriminator.
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex has no cache TTL tiers.
    cacheCreation1hTokens: 0,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Events surviving the fork-copy suppression above are unique to this
    // rollout, so they need no global dedup.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Grok Build                                                                 */
/* -------------------------------------------------------------------------- */

/** Grok reports cost in integer ticks: 1 USD = 10^10 ticks. */
const GROK_COST_TICKS_PER_DOLLAR = 10_000_000_000;

interface GrokUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly costUsdTicks: number | null;
}

function readGrokUsageTotals(value: unknown): GrokUsageTotals | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const ticks = record["costUsdTicks"];
  return {
    inputTokens: int(record["inputTokens"]),
    outputTokens: int(record["outputTokens"]),
    cachedReadTokens: int(record["cachedReadTokens"]),
    cacheCreationTokens: int(record["cacheCreationTokens"]),
    reasoningTokens: int(record["reasoningTokens"]),
    costUsdTicks: typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0 ? ticks : null,
  };
}

/** Grok counts cached input inside `inputTokens`, as Codex does. */
function grokTotals(totals: GrokUsageTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: Math.max(
      0,
      totals.inputTokens - totals.cachedReadTokens - totals.cacheCreationTokens,
    ),
    cachedInputTokens: totals.cachedReadTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: Math.min(totals.outputTokens, totals.reasoningTokens),
  };
}

const grokTicksToUsd = (ticks: number | null) =>
  ticks === null ? null : ticks / GROK_COST_TICKS_PER_DOLLAR;

/**
 * Parses one line of a Grok Build session log (`sessions/<cwd>/<id>/updates.jsonl`).
 *
 * Usage lands on `turn_completed` updates, with a per-model breakdown under
 * `usage.modelUsage`; each model becomes its own record. A model without its
 * own cost gets a token-share slice of what the turn's total cost leaves.
 */
export function parseGrokLine(line: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const params = record["params"];
  if (typeof params !== "object" || params === null) return [];
  const paramsRecord = params as Record<string, unknown>;
  const update = paramsRecord["update"];
  if (typeof update !== "object" || update === null) return [];
  const updateRecord = update as Record<string, unknown>;
  if (updateRecord["sessionUpdate"] !== "turn_completed") return [];
  const usage = readGrokUsageTotals(updateRecord["usage"]);
  if (usage === null) return [];

  const sessionId = typeof paramsRecord["sessionId"] === "string" ? paramsRecord["sessionId"] : "";
  const promptId = typeof updateRecord["prompt_id"] === "string" ? updateRecord["prompt_id"] : null;
  const meta = paramsRecord["_meta"];
  const agentTimestampMs =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>)["agentTimestampMs"]
      : undefined;
  const outerTimestamp = record["timestamp"];
  const timestampMs =
    typeof agentTimestampMs === "number" && Number.isFinite(agentTimestampMs)
      ? agentTimestampMs
      : typeof outerTimestamp === "number" && Number.isFinite(outerTimestamp)
        ? outerTimestamp > 1e12
          ? outerTimestamp
          : outerTimestamp * 1000
        : null;
  if (timestampMs === null) return [];

  const make = (model: string, totals: UsageTokenTotals, costUsd: number | null): UsageRecord => ({
    provider: "grok",
    timestampMs,
    model,
    sessionId,
    totals,
    cacheCreation1hTokens: 0,
    reportedCostUsd: costUsd,
    // Without a prompt id two same-moment turns can't be told apart.
    dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${model}`,
  });

  const byModel = updateRecord["usage"] as Record<string, unknown>;
  const modelUsage = byModel["modelUsage"];
  const entries: Array<{ readonly model: string; readonly totals: GrokUsageTotals }> = [];
  if (typeof modelUsage === "object" && modelUsage !== null) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      const totals = model.length > 0 ? readGrokUsageTotals(raw) : null;
      if (totals !== null) entries.push({ model, totals });
    }
  }
  if (entries.length === 0) {
    const totals = grokTotals(usage);
    return totalTokens(totals) === 0
      ? []
      : [make("grok", totals, grokTicksToUsd(usage.costUsdTicks))];
  }

  const turnCostUsd = grokTicksToUsd(usage.costUsdTicks);
  let ownCostUsd = 0;
  let untickedTokens = 0;
  for (const entry of entries) {
    const tokens = totalTokens(grokTotals(entry.totals));
    if (tokens === 0) continue;
    if (entry.totals.costUsdTicks !== null)
      ownCostUsd += grokTicksToUsd(entry.totals.costUsdTicks) ?? 0;
    else untickedTokens += tokens;
  }
  const leftoverUsd = turnCostUsd === null ? null : Math.max(0, turnCostUsd - ownCostUsd);
  return entries.flatMap((entry) => {
    const totals = grokTotals(entry.totals);
    const tokens = totalTokens(totals);
    if (tokens === 0) return [];
    const ownCost = grokTicksToUsd(entry.totals.costUsdTicks);
    const cost =
      ownCost ??
      (leftoverUsd !== null && untickedTokens > 0 ? leftoverUsd * (tokens / untickedTokens) : null);
    return [make(entry.model, totals, cost)];
  });
}

/* -------------------------------------------------------------------------- */
/* Pi                                                                         */
/* -------------------------------------------------------------------------- */

/** Entries that carry spending: Pi counts these in a session's totals. */
const PI_USAGE_ENTRY_TYPES = new Set(["message", "usage", "compaction", "branch_summary"]);

/**
 * Parses one line of a Pi session file (`sessions/--<cwd>--/<time>_<id>.jsonl`).
 *
 * Spending sits on assistant messages, on tool results that did model work of
 * their own, on standalone `usage` entries (cache warming) and on compaction
 * and branch summaries. Pi reports `input` without the cached part and the
 * cost in USD.
 *
 * Every revert and fork copies the history it keeps into a new file, ids and
 * timestamps included, so the caller drops repeats by `dedupeKey`.
 */
export function parsePiLine(line: string, sessionId: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as Record<string, unknown>;
  const type = entry["type"];
  if (typeof type !== "string" || !PI_USAGE_ENTRY_TYPES.has(type)) return null;
  const id = typeof entry["id"] === "string" ? entry["id"] : null;
  const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : null;
  const timestampMs = parseTimestampMs(timestamp);
  if (timestampMs === null) return null;

  const message =
    type === "message" && typeof entry["message"] === "object" && entry["message"] !== null
      ? (entry["message"] as Record<string, unknown>)
      : null;
  // The message for its own entry; the entry itself for the rest.
  const source = type === "message" ? message : entry;
  if (source === null) return null;
  const usage = source["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const provider = typeof source["provider"] === "string" ? source["provider"] : "";
  const modelId = typeof source["model"] === "string" ? source["model"] : "";
  // Pi's own `provider/id`, as its model picker names it. Summaries don't say
  // which model wrote them.
  const model = modelId.length === 0 ? "pi-summary" : provider ? `${provider}/${modelId}` : modelId;

  const outputTokens = int(usageRecord["output"]);
  const cacheCreationTokens = int(usageRecord["cacheWrite"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(usageRecord["input"]),
    cachedInputTokens: int(usageRecord["cacheRead"]),
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(usageRecord["reasoning"])),
  };
  if (totalTokens(totals) === 0) return null;

  const cost = usageRecord["cost"];
  const total =
    typeof cost === "object" && cost !== null ? (cost as Record<string, unknown>)["total"] : null;
  return {
    provider: "pi",
    timestampMs,
    model,
    sessionId,
    totals,
    cacheCreation1hTokens: Math.min(cacheCreationTokens, int(usageRecord["cacheWrite1h"])),
    reportedCostUsd:
      typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null,
    // Copies keep the entry's id and timestamp. An id alone is only unique
    // within one session's tree.
    dedupeKey: id === null ? null : `${id}:${timestamp}:${model}`,
  };
}

/** `<time>_<session id>.jsonl` → the session id, or the file's name when it has another shape. */
export function piSessionIdFromFileName(fileName: string): string {
  const base = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
  const separator = base.indexOf("_");
  return separator >= 0 ? base.slice(separator + 1) : base;
}

/* -------------------------------------------------------------------------- */
/* Muse Code                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Muse's approval-review runs record on a fixed replay clock, so their
 * `recorded_at` says nothing about when the review ran.
 */
const MUSE_REPLAY_CLOCK_STREAM = "approval.review.runtime";

export interface MuseScanState {
  /** The model the last `status` producer facet named, for records that name none. */
  model: string;
}

export const initialMuseScanState = (): MuseScanState => ({ model: "" });

/** The model a `status` event's producer facet names, if it names one. */
function museStatusModel(event: Record<string, unknown>): string | null {
  const details = event["details"];
  if (typeof details !== "object" || details === null) return null;
  const facets = (details as Record<string, unknown>)["facets"];
  if (!Array.isArray(facets)) return null;
  for (const facet of facets) {
    if (typeof facet !== "object" || facet === null) continue;
    const detail = (facet as Record<string, unknown>)["detail"];
    if (typeof detail !== "object" || detail === null) continue;
    const model = (detail as Record<string, unknown>)["model"];
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/**
 * Feeds one line of a Muse Code session log into `state`, returning a record
 * when the line is a finished model call.
 *
 * Muse keeps one log per session at
 * `muse/sessions/YYYY/MM/DD/<session>/session.jsonl`, with its subagents under
 * `subagent/<id>/session.jsonl` and its automatic approval checks under
 * `approval-review/<id>.jsonl`; each log records only its own model calls.
 * Every call lands as a `model_completed` event. `input_tokens` includes the
 * cached part, as OpenAI and Codex report it, and Muse reports no cost.
 *
 * `fileMtimeMs` stands in for the time of an approval-review call, whose
 * records carry a replay clock instead of the real one.
 */
export function parseMuseLine(
  line: string,
  state: MuseScanState,
  fileMtimeMs: number,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["payload_type"] !== "runtime.session") return null;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const event = (payload as Record<string, unknown>)["event"];
  if (typeof event !== "object" || event === null) return null;
  const eventRecord = event as Record<string, unknown>;

  if (eventRecord["kind"] === "status") {
    const model = museStatusModel(eventRecord);
    if (model !== null) state.model = model;
    return null;
  }
  if (eventRecord["kind"] !== "model_completed") return null;
  const usage = eventRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const stream = record["stream"];
  const streamRecord =
    typeof stream === "object" && stream !== null ? (stream as Record<string, unknown>) : {};
  const recordedAt = record["recorded_at"];
  const timestampMs =
    streamRecord["kind"] === MUSE_REPLAY_CLOCK_STREAM
      ? fileMtimeMs
      : typeof recordedAt === "number" && Number.isFinite(recordedAt) && recordedAt > 0
        ? Math.trunc(recordedAt / 1000)
        : null;
  if (timestampMs === null) return null;

  const named = eventRecord["model"];
  const model = typeof named === "string" && named.length > 0 ? named : state.model || "muse";

  const inputTokens = int(usageRecord["input_tokens"]);
  // `cached_tokens` is the older name for the same count.
  const cachedInputTokens = int(usageRecord["cache_read_tokens"] ?? usageRecord["cached_tokens"]);
  const cacheCreationTokens = int(usageRecord["cache_write_tokens"]);
  const outputTokens = int(usageRecord["output_tokens"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(usageRecord["reasoning_tokens"])),
  };
  if (totalTokens(totals) === 0) return null;

  const id = typeof record["id"] === "string" ? record["id"] : null;
  return {
    provider: "muse",
    timestampMs,
    model,
    sessionId: typeof streamRecord["id"] === "string" ? streamRecord["id"] : "",
    totals,
    cacheCreation1hTokens: 0,
    reportedCostUsd: null,
    // A rewound or forked session may copy records with their ids.
    dedupeKey: id,
  };
}
