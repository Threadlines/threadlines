/**
 * FxGatewayModels — pricing/context metadata for fx's Gateway catalog.
 *
 * ACP carries only model ids and names. Vercel AI Gateway also publishes an
 * unauthenticated catalog (`/v1/models`) with per-model pricing (USD per
 * token), context window and tags; this folds it onto fx's discovered
 * models as a compact meta line plus a "Free" chip. Models fx lists from a
 * different source (Codex/Grok subscription catalogs) simply don't match a
 * Gateway id and pass through untouched.
 *
 * @module provider/acp/FxGatewayModels
 */
import type { ServerProviderModel } from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const GATEWAY_CATALOG_TTL_MS = 60 * 60 * 1_000;
const GATEWAY_FETCH_TIMEOUT_MS = 6_000;

const GatewayModelEntry = Schema.Struct({
  id: Schema.String,
  context_window: Schema.optional(Schema.NullOr(Schema.Number)),
  pricing: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        input: Schema.optional(Schema.NullOr(Schema.String)),
        output: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type GatewayModelEntry = typeof GatewayModelEntry.Type;

const GatewayModelsResponse = Schema.Struct({
  data: Schema.Array(GatewayModelEntry),
});

function formatUsdPerMTok(usdPerToken: number): string {
  const perM = usdPerToken * 1_000_000;
  const rendered =
    perM >= 100 ? perM.toFixed(0) : perM >= 1 ? perM.toFixed(2) : perM.toPrecision(2);
  return `$${rendered.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1")}/M`;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M ctx`;
  }
  // Catalog windows are power-of-two-ish (262144 → "256K"), so divide by 1024.
  return `${Math.round(tokens / 1024)}K ctx`;
}

export function gatewayModelMeta(entry: GatewayModelEntry): {
  readonly metaLabel?: string;
  readonly promoLabel?: string;
} {
  const input = entry.pricing?.input != null ? Number(entry.pricing.input) : Number.NaN;
  const output = entry.pricing?.output != null ? Number(entry.pricing.output) : Number.NaN;
  const isFree = input === 0 && output === 0;
  const parts = [
    ...(entry.context_window ? [formatContextWindow(entry.context_window)] : []),
    ...(!isFree && Number.isFinite(input) ? [`${formatUsdPerMTok(input)} in`] : []),
    ...(!isFree && Number.isFinite(output) ? [`${formatUsdPerMTok(output)} out`] : []),
  ];
  return {
    ...(parts.length > 0 ? { metaLabel: parts.join(" · ") } : {}),
    ...(isFree ? { promoLabel: "Free" } : {}),
  };
}

export function applyGatewayModelMeta(
  models: ReadonlyArray<ServerProviderModel>,
  entries: ReadonlyArray<GatewayModelEntry>,
): ReadonlyArray<ServerProviderModel> {
  const bySlug = new Map(entries.map((entry) => [entry.id, entry] as const));
  return models.map((model) => {
    const entry = bySlug.get(model.slug);
    if (!entry) {
      return model;
    }
    return { ...model, ...gatewayModelMeta(entry) };
  });
}

interface GatewayCatalogCacheEntry {
  readonly expiresAt: number;
  readonly entries: ReadonlyArray<GatewayModelEntry> | null;
}

let gatewayCatalogCache: GatewayCatalogCacheEntry | null = null;

export function clearGatewayCatalogCacheForTests(): void {
  gatewayCatalogCache = null;
}

const fetchGatewayCatalog = Effect.fn("fetchGatewayCatalog")(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(GATEWAY_MODELS_URL).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
    )
    .pipe(Effect.timeout(GATEWAY_FETCH_TIMEOUT_MS));
  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  const payload = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GatewayModelsResponse)),
  );
  return payload.data;
});

/**
 * Adds Gateway pricing/context metadata to fx's discovered models. Failures
 * (offline, schema drift) leave the models untouched — the metadata is a
 * garnish, never a gate on discovery.
 */
export const enrichFxModelsWithGatewayCatalog = (
  models: ReadonlyArray<ServerProviderModel>,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (models.length === 0) {
      return models;
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (!gatewayCatalogCache || gatewayCatalogCache.expiresAt <= now) {
      const entries = yield* fetchGatewayCatalog().pipe(Effect.catch(() => Effect.succeed(null)));
      gatewayCatalogCache = { expiresAt: now + GATEWAY_CATALOG_TTL_MS, entries };
    }
    const entries = gatewayCatalogCache.entries;
    return entries ? applyGatewayModelMeta(models, entries) : models;
  });
