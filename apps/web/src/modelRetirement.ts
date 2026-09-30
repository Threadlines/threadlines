/**
 * When a provider is about to stop serving a model, and what replaces it.
 * Codex marks a retiring model with `upgradeInfo.retiresAt` weeks ahead; the
 * model picker labels the row and the composer offers the replacement.
 *
 * @module modelRetirement
 */
import type { ServerProviderModel } from "@threadlines/contracts";

export interface ModelRetirement {
  readonly retiresAtMs: number;
  readonly retired: boolean;
  /** "Oct 14", with the year when it isn't this year. */
  readonly dateLabel: string;
  /** The provider's suggested replacement, when the user can pick it. */
  readonly replacement: { readonly slug: string; readonly name: string } | null;
}

/** Locale and time zone default to the runtime's; tests pin them. */
export interface RetirementDateFormat {
  readonly locale?: string;
  readonly timeZone?: string;
}

export function formatRetirementDate(
  retiresAtMs: number,
  nowMs: number,
  format: RetirementDateFormat = {},
): string {
  const yearOf = (ms: number) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: format.timeZone }).format(ms);
  return new Intl.DateTimeFormat(format.locale, {
    month: "short",
    day: "numeric",
    timeZone: format.timeZone,
    ...(yearOf(retiresAtMs) === yearOf(nowMs) ? {} : { year: "numeric" }),
  }).format(retiresAtMs);
}

/**
 * @param pickable The models the user can switch to: the picker's options for
 *   this instance, which already drop provider- and user-hidden models.
 */
export function readModelRetirement(
  model: Pick<ServerProviderModel, "upgradeInfo">,
  pickable: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  nowMs: number,
  format?: RetirementDateFormat,
): ModelRetirement | null {
  const retiresAtMs = model.upgradeInfo?.retiresAt
    ? Date.parse(model.upgradeInfo.retiresAt)
    : Number.NaN;
  if (!Number.isFinite(retiresAtMs)) {
    return null;
  }
  const replacement = pickable.find((candidate) => candidate.slug === model.upgradeInfo?.model);
  return {
    retiresAtMs,
    retired: retiresAtMs <= nowMs,
    dateLabel: formatRetirementDate(retiresAtMs, nowMs, format),
    replacement: replacement ? { slug: replacement.slug, name: replacement.name } : null,
  };
}

/** setTimeout's ceiling; a later deadline re-arms after this long. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** How long until a mounted view should re-read the clock to flip a retiring
 *  model to retired, or null once it has. */
export function retirementRecheckDelayMs(retiresAtMs: number, nowMs: number): number | null {
  return retiresAtMs <= nowMs ? null : Math.min(retiresAtMs - nowMs + 1_000, MAX_TIMER_DELAY_MS);
}

/** The gray note on a retiring model's row. */
export function modelRetirementMetaLabel(retirement: ModelRetirement): string {
  return `${retirement.retired ? "Retired" : "Retires"} ${retirement.dateLabel}`;
}

/**
 * A model row's gray note: the catalog's own metadata, else its retirement.
 * Rows redraw with every provider refresh, which keeps the tense current.
 */
export function modelMetaLabel(
  model: Pick<ServerProviderModel, "metaLabel" | "upgradeInfo">,
  nowMs: number = Date.now(),
): string | undefined {
  if (model.metaLabel) {
    return model.metaLabel;
  }
  const retirement = readModelRetirement(model, [], nowMs);
  return retirement ? modelRetirementMetaLabel(retirement) : undefined;
}
