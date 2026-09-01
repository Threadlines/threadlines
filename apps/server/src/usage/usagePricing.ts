/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against, plus a small built-in table for models LiteLLM
 * has not published yet. Everything here is pure: fetching and caching the
 * table lives in `UsageService`.
 *
 * Every figure produced here is an API list-price equivalent, not billed spend.
 *
 * @module usagePricing
 */
import type { UsageCostSource, UsageTokenTotals } from "@threadlines/contracts";

/**
 * The subset of a LiteLLM entry we price against. All values are USD per token.
 *
 * LiteLLM also publishes tiered variants (`*_above_200k_tokens`, `*_flex`,
 * `*_priority`, `*_batches`). We deliberately price those at the base tier: the
 * transcripts don't record which tier served a request, so anything else would
 * be a guess dressed up as precision. The 1-hour cache-write rate is the
 * exception: Claude transcripts do record how much of each write used the
 * 1-hour TTL, and Claude Code writes most of its cache that way.
 */
export interface ModelRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  /** Cache writes with the default 5-minute TTL. */
  readonly cacheCreationCostPerToken: number;
  /** Cache writes with the 1-hour TTL, which Anthropic bills at a higher multiplier. */
  readonly cacheCreation1hCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost_above_1hr?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    // LiteLLM publishes the same model many times over with a routing prefix
    // (`azure/gpt-5.6-sol`, `openrouter/...`), sometimes at different rates.
    // They all normalise to one key, so the un-prefixed entry wins outright
    // rather than whichever happened to be enumerated last.
    const normalized = normalizeModelName(name);
    const prefixed = name.includes("/");
    if (prefixed && table.has(normalized)) continue;

    // Anthropic bills cache reads at a discount and cache writes at a premium.
    // When a model omits them, cached input is priced as plain input rather
    // than as free, and a missing 1-hour rate falls back to the 5-minute one.
    const cacheCreation = finiteNumber(entry.cache_creation_input_token_cost) ?? input;
    table.set(normalized, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: cacheCreation,
      cacheCreation1hCostPerToken:
        finiteNumber(entry.cache_creation_input_token_cost_above_1hr) ?? cacheCreation,
    });
  }
  return table;
}

/** Anthropic publishes USD per million tokens; the table stores USD per token. */
const perMillion = (usd: number): number => usd / 1_000_000;

/**
 * Rates for models LiteLLM has not published yet, from Anthropic's price list.
 *
 * Consulted only when the fetched table lacks the model, so LiteLLM takes over
 * the moment it catches up and an entry here can be deleted once it does.
 */
const BUILT_IN_RATES: RateTable = new Map([
  [
    // Claude Fable 5 pricing throughout, except cache reads at 0.025x input.
    "claude-fable-5-1",
    {
      inputCostPerToken: perMillion(10),
      outputCostPerToken: perMillion(50),
      cacheReadCostPerToken: perMillion(0.25),
      cacheCreationCostPerToken: perMillion(12.5),
      cacheCreation1hCostPerToken: perMillion(20),
    },
  ],
]);

/**
 * Canonicalises a model name for lookup.
 *
 * Strips a `provider/` prefix (LiteLLM publishes both `claude-opus-4-5` and
 * `anthropic/claude-opus-4-5`) and lowercases, since transcripts are
 * inconsistent about casing.
 */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations, so
 * we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) return null;
  return table.get(normalized) ?? BUILT_IN_RATES.get(normalized) ?? null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

/** The parts of a transcript record that cost arithmetic reads. */
export interface PriceableUsage {
  readonly model: string;
  readonly totals: UsageTokenTotals;
  /** Portion of `totals.cacheCreationTokens` written with the 1-hour TTL. */
  readonly cacheCreation1hTokens: number;
  readonly reportedCostUsd: number | null;
}

/**
 * Prices one record's tokens.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(table: RateTable, usage: PriceableUsage): PricedUsage {
  if (usage.reportedCostUsd !== null && Number.isFinite(usage.reportedCostUsd)) {
    return { costUsd: usage.reportedCostUsd, costSource: "providerReported" };
  }

  const rate = lookupRate(table, usage.model);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const { totals } = usage;
  const cacheCreation1h = Math.min(usage.cacheCreation1hTokens, totals.cacheCreationTokens);
  const cacheCreation5m = totals.cacheCreationTokens - cacheCreation1h;
  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    cacheCreation5m * rate.cacheCreationCostPerToken +
    cacheCreation1h * rate.cacheCreation1hCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;

  return { costUsd, costSource: "modelPriced" };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}
