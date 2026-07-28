/**
 * One dense meta line describing a spawned agent, shared by the activity
 * popover row and the inspector header so both stay in step. Everything here
 * comes from data the thread subscription already streams; nothing in this
 * module triggers a provider read.
 */
import type { ProviderDriverKind, ServerProviderModel } from "@threadlines/contracts";

import type { SubagentProgressItem } from "../../session-logic";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { getProviderScopedDisplayModelName } from "./providerIconUtils";

/** `74s` / `12m 04s` / `3h 21m`. Provider task durations are the agent's own
 *  run time, which is more honest than wall-clock since the spawn row. */
export function formatSubagentDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Names the model exactly, the way the model picker does. Providers report a
 * slug (`claude-opus-5`, `gpt-5.6-sol`), so the configured catalog is asked
 * first and its display name wins ("Opus 5"). A spawn that only stated an
 * alias, or a model the catalog does not carry, falls back to a readable form
 * of the raw slug rather than inventing a version.
 */
export function resolveSubagentModelLabel(
  providers: ReadonlyArray<{
    readonly driver: ProviderDriverKind;
    readonly models: ReadonlyArray<ServerProviderModel>;
  }>,
  model: string | null | undefined,
): string | null {
  const slug = model?.trim();
  if (!slug) {
    return null;
  }
  for (const provider of providers) {
    const match = provider.models.find(
      (candidate) => candidate.slug.toLowerCase() === slug.toLowerCase(),
    );
    if (match) {
      return getProviderScopedDisplayModelName(match, provider.driver, { preferShortName: true });
    }
  }
  return formatSubagentModelSlug(slug);
}

/** Names that read wrong in title case. */
const VENDOR_TOKENS = new Set(["gpt", "gpt4", "gpt5", "o1", "o3", "llm"]);

/** `claude-opus-5` reads as `Opus 5`; a bare alias keeps its own shape. */
export function formatSubagentModelSlug(slug: string): string {
  const withoutVendor = slug.replace(/^(claude|anthropic)-/iu, "").trim() || slug;
  return withoutVendor
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) =>
      VENDOR_TOKENS.has(part.toLowerCase())
        ? part.toUpperCase()
        : /^[a-z]/u.test(part)
          ? `${part[0]?.toUpperCase()}${part.slice(1)}`
          : part,
    )
    .join(" ");
}

export function formatSubagentMetaParts(
  item: Pick<SubagentProgressItem, "model" | "reasoningEffort" | "telemetry">,
  options?: {
    /** Where the agent is working, from the parsed objective. */
    readonly context?: string | null;
    /** Display name for the model, resolved against the provider catalog. */
    readonly modelLabel?: string | null;
    /** Wall-clock fallback used when the provider reports no duration. */
    readonly elapsed?: string | null;
    /** The current step reads as prose, so the popover row keeps it out of the
     *  meta line and renders it on its own. */
    readonly includeCurrentTool?: boolean;
  },
): ReadonlyArray<string> {
  const telemetry = item.telemetry;
  const parts: Array<string> = [];

  if (options?.context) {
    parts.push(options.context);
  }
  const modelLabel =
    options?.modelLabel ?? (item.model ? formatSubagentModelSlug(item.model) : null);
  if (modelLabel) {
    parts.push(modelLabel);
  }
  if (item.reasoningEffort) {
    parts.push(item.reasoningEffort);
  }
  const duration =
    telemetry?.durationMs != null ? formatSubagentDuration(telemetry.durationMs) : options?.elapsed;
  if (duration) {
    parts.push(duration);
  }
  if (telemetry?.totalTokens != null) {
    parts.push(`${formatContextWindowTokens(telemetry.totalTokens)} tokens`);
  }
  if (telemetry?.toolUses != null) {
    parts.push(
      `${telemetry.toolUses.toLocaleString()} ${telemetry.toolUses === 1 ? "tool" : "tools"}`,
    );
  }
  if (options?.includeCurrentTool !== false && telemetry?.lastToolName) {
    parts.push(telemetry.lastToolName);
  }

  return parts;
}
