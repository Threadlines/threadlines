// @effect-diagnostics nodeBuiltinImport:off
/**
 * The usage ledger: turn usage Threadlines writes down for agents that keep
 * none on disk.
 *
 * Agents on the generic ACP driver report a turn's tokens in the
 * `session/prompt` result and a running session cost in `usage_update`, and
 * some keep no record of either (fx stopped in 0.0.14). The ACP core appends
 * one line per turn to `<state>/usage-ledger/<provider>/<UTC day>.jsonl`, and
 * the usage scan reads those folders like any provider's transcripts. Only
 * chats run in Threadlines are in it.
 *
 * @module usageLedger
 */
import * as NodePath from "node:path";

import type { UsageProviderKind, UsageTokenTotals } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

/** The providers whose usage comes from the ledger rather than their own files. */
export const USAGE_LEDGER_PROVIDERS = ["fx"] as const satisfies readonly UsageProviderKind[];
export type UsageLedgerProvider = (typeof USAGE_LEDGER_PROVIDERS)[number];

export const isUsageLedgerProvider = (
  provider: UsageProviderKind,
): provider is UsageLedgerProvider =>
  (USAGE_LEDGER_PROVIDERS as readonly UsageProviderKind[]).includes(provider);

/** Where a provider's ledger files live. */
export function usageLedgerDir(stateDir: string, provider: UsageLedgerProvider): string {
  return NodePath.join(stateDir, "usage-ledger", provider);
}

/** One turn's usage, as the ACP core reports it. */
export interface UsageLedgerEntry {
  readonly atMs: number;
  /** The agent's session id: one per conversation, kept across resumes. */
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: string;
  readonly totals: UsageTokenTotals;
  /** What the agent said the turn cost, in USD, or `null` when it didn't say. */
  readonly costUsd: number | null;
}

/** The line format, version 1. Short keys: a busy day writes thousands. */
interface UsageLedgerLine {
  readonly v: 1;
  readonly at: number;
  readonly session: string;
  readonly turn: string;
  readonly model: string;
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
  readonly costUsd: number | null;
}

export function formatUsageLedgerLine(entry: UsageLedgerEntry): string {
  const line: UsageLedgerLine = {
    v: 1,
    at: entry.atMs,
    session: entry.sessionId,
    turn: entry.turnId,
    model: entry.model,
    input: entry.totals.uncachedInputTokens,
    cachedInput: entry.totals.cachedInputTokens,
    cacheWrite: entry.totals.cacheCreationTokens,
    output: entry.totals.outputTokens,
    reasoning: entry.totals.reasoningTokens,
    costUsd: entry.costUsd,
  };
  return `${JSON.stringify(line)}\n`;
}

/**
 * Appends one entry to today's file (UTC). A failure is the caller's to log:
 * losing a turn's usage line must never fail the turn.
 */
export const appendUsageLedgerEntry = Effect.fn("usageLedger.append")(function* (input: {
  readonly stateDir: string;
  readonly provider: UsageLedgerProvider;
  readonly entry: UsageLedgerEntry;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = usageLedgerDir(input.stateDir, input.provider);
  yield* fileSystem.makeDirectory(dir, { recursive: true });
  const day = new Date(input.entry.atMs).toISOString().slice(0, 10);
  yield* fileSystem.writeFileString(
    NodePath.join(dir, `${day}.jsonl`),
    formatUsageLedgerLine(input.entry),
    { flag: "a" },
  );
});

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Reads one ledger line back into a usage record for `provider`. */
export function parseUsageLedgerLine(
  line: string,
  provider: UsageLedgerProvider,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<Record<keyof UsageLedgerLine, unknown>>;
  if (record.v !== 1) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  const session = typeof record.session === "string" ? record.session : "";
  const turn = typeof record.turn === "string" ? record.turn : "";
  const model =
    typeof record.model === "string" && record.model.length > 0 ? record.model : provider;
  const outputTokens = count(record.output);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: count(record.input),
    cachedInputTokens: count(record.cachedInput),
    cacheCreationTokens: count(record.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, count(record.reasoning)),
  };
  const costUsd =
    typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd >= 0
      ? record.costUsd
      : null;
  if (totalTokens(totals) === 0 && costUsd === null) return null;
  return {
    provider,
    timestampMs: record.at,
    model,
    sessionId: session,
    totals,
    cacheCreation1hTokens: 0,
    reportedCostUsd: costUsd,
    // A turn is written once; the key guards against a line written twice.
    dedupeKey: session && turn ? `${session}:${turn}` : null,
  };
}
