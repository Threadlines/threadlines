/**
 * Antigravity prompt suggestion model selection and quota guard.
 *
 * Prefers a fast-but-smart Gemini Hydrogen model (e.g. `gemini-4-hydrogen`),
 * then Gemini Flash (non-lite first), at the lightest good thinking level so
 * suggestions stay quick without spending frontier or Claude/GPT quota. When
 * neither Hydrogen nor Flash is in the catalog, suggestions are skipped rather
 * than falling back to the thread's own frontier model.
 *
 * @module provider/antigravity/AntigravityPromptSuggestions
 */
import type {
  AntigravityAuthMethod,
  ProviderOptionSelection,
  ServerProviderAccountUsage,
  ServerProviderModel,
} from "@threadlines/contracts";
import { findReasoningOptionDescriptor } from "@threadlines/shared/model";
import {
  isAccountUsageNearLimit,
  isModelUsageNearLimit,
  usageResetTimeMs,
} from "@threadlines/shared/usageLimits";

import {
  PROMPT_SUGGESTION_USAGE_CEILING_PERCENT,
  selectSuggestionEffort,
} from "../promptSuggestions.ts";

/**
 * Only subscription/OAuth Antigravity accounts get automatic prompt
 * suggestions: pay-per-token API key and Vertex AI accounts have no quota
 * windows to guard against and would be billed per turn for an extra process.
 */
export function isAntigravityPromptSuggestionAuthSupported(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business";
}

export interface AntigravitySuggestionTarget {
  /** Model slug to select on the ephemeral suggestion session. */
  readonly model: string;
  /** Display name (or slug fallback) matched against Antigravity's scoped usage windows. */
  readonly modelName: string;
  /** Lightest good reasoning option selection for `model`, when supported. */
  readonly options: ReadonlyArray<ProviderOptionSelection>;
}

const GEMINI_VERSION = /^gemini-(\d+(?:\.\d+)*)-/iu;

function parseGeminiVersion(slug: string): ReadonlyArray<number> {
  const match = GEMINI_VERSION.exec(slug.trim());
  if (!match?.[1]) return [];
  return match[1].split(".").map((part) => Number(part));
}

function compareDescVersion(left: ServerProviderModel, right: ServerProviderModel): number {
  const a = parseGeminiVersion(left.slug);
  const b = parseGeminiVersion(right.slug);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isGeminiModel(model: ServerProviderModel): boolean {
  return /^gemini-/iu.test(model.slug) || /\bgemini\b/iu.test(model.name);
}

function isHydrogenModel(model: ServerProviderModel): boolean {
  return (
    isGeminiModel(model) && (/\bhydrogen\b/iu.test(model.slug) || /\bhydrogen\b/iu.test(model.name))
  );
}

function isFlashModel(model: ServerProviderModel): boolean {
  return isGeminiModel(model) && (/\bflash\b/iu.test(model.slug) || /\bflash\b/iu.test(model.name));
}

function isFlashLiteModel(model: ServerProviderModel): boolean {
  return /flash[-_\s]?lite/iu.test(model.slug) || /flash[-_\s]?lite/iu.test(model.name);
}

function reasoningOptionsFor(
  model: ServerProviderModel | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const descriptor = findReasoningOptionDescriptor(model?.capabilities?.optionDescriptors ?? []);
  if (!descriptor) return [];
  const effort = selectSuggestionEffort(descriptor.options.map((option) => option.id));
  return effort === undefined ? [] : [{ id: descriptor.id, value: effort }];
}

/**
 * Picks the suggestion model and light thinking option from the account's live
 * model catalog:
 *   1. Highest-version Gemini Hydrogen (e.g. `gemini-4-hydrogen`)
 *   2. Highest-version non-lite Gemini Flash (e.g. `gemini-3.8-flash`)
 *   3. Any Gemini Flash
 *
 * Returns `undefined` when no lightweight Gemini model is listed, so
 * suggestions never spend frontier or Claude/GPT quota.
 */
export function selectAntigravitySuggestionTarget(
  models: ReadonlyArray<ServerProviderModel>,
): AntigravitySuggestionTarget | undefined {
  const hydrogen = models.filter(isHydrogenModel).toSorted(compareDescVersion)[0];
  const chosen =
    hydrogen ??
    models
      .filter((model) => isFlashModel(model) && !isFlashLiteModel(model))
      .toSorted(compareDescVersion)[0] ??
    models.filter(isFlashModel).toSorted(compareDescVersion)[0];

  if (chosen === undefined) return undefined;

  return {
    model: chosen.slug,
    modelName: chosen.name || chosen.slug,
    options: reasoningOptionsFor(chosen),
  };
}

/**
 * Whether the chosen Antigravity suggestion model's usage pool (or a plan-wide
 * limit) is at or above `percent` (default 100%), pausing suggestions without
 * blocking on unrelated pools like Claude & GPT. When `modelName` is unknown,
 * fails safe if any active scoped or plan-wide window is at or above `percent`.
 */
export function isAntigravitySuggestionUsageNearLimit(
  accountUsage: ServerProviderAccountUsage | undefined,
  modelName: string | undefined,
  nowMs: number,
  percent: number = PROMPT_SUGGESTION_USAGE_CEILING_PERCENT,
): boolean {
  if (modelName !== undefined) {
    return isModelUsageNearLimit(accountUsage, modelName, nowMs, percent);
  }
  if (isAccountUsageNearLimit(accountUsage, nowMs, percent)) return true;
  if (accountUsage === undefined) return false;
  return accountUsage.limits.some((limit) =>
    (limit.scoped ?? []).some((window) => {
      if (window.usedPercent < percent && window.remainingPercent > 100 - percent) return false;
      const resetsAtMs = usageResetTimeMs(window.resetsAt);
      return resetsAtMs === undefined || resetsAtMs > nowMs;
    }),
  );
}
