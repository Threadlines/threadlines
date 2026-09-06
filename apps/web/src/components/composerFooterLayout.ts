/**
 * The composer footer's left-hand controls (traits, mode, access) have three
 * layouts: full labels, icons only, and the overflow menu. The switch is
 * measured rather than tied to a fixed width, because the room the labels
 * need depends on the model name and the access label. All three controls
 * drop to icons together the moment the labelled row would clip, and the row
 * collapses into the overflow menu once the icon row gets tight.
 */
export type ComposerFooterTier = "full" | "icons" | "compact";

export interface ComposerFooterTierState {
  tier: ComposerFooterTier;
  /**
   * Composer widths at which the roomier tiers last overflowed. A tier is
   * only retried once the composer grows past that width, which stops the
   * layout from flapping between tiers on every resize frame.
   */
  overflowWidths: { full: number | null; icons: number | null };
}

export const INITIAL_COMPOSER_FOOTER_TIER_STATE: ComposerFooterTierState = {
  tier: "full",
  overflowWidths: { full: null, icons: null },
};

/** Headroom the left controls keep before the row counts as overflowing. */
export const COMPOSER_FOOTER_OVERFLOW_SLACK_PX = 12;

/** Extra width required beyond the recorded overflow width before retrying a roomier tier. */
export const COMPOSER_FOOTER_TIER_HYSTERESIS_PX = 16;

/**
 * Pixels by which the left control group's content extends past its content
 * box; negative when there is room to spare. Reads child rects rather than
 * scrollWidth, which never drops below clientWidth and so cannot report
 * free space.
 */
export function measureComposerFooterOverflow(leftActions: HTMLElement): number {
  const box = leftActions.getBoundingClientRect();
  const paddingRight = Number.parseFloat(getComputedStyle(leftActions).paddingRight) || 0;
  let contentRight = box.left;
  for (const child of Array.from(leftActions.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.width > 0 && rect.right > contentRight) {
      contentRight = rect.right;
    }
  }
  return contentRight - (box.right - paddingRight);
}

/** True when the content no longer fits with slack to spare. */
export function isComposerFooterOverflowing(overflowPx: number): boolean {
  return overflowPx > -COMPOSER_FOOTER_OVERFLOW_SLACK_PX;
}

/**
 * Advances the tier from one measurement. Overflow escalates one tier and
 * records the width it happened at; a comfortable fit steps back one tier
 * only once the composer is wider than where that tier last overflowed.
 * Each step is followed by a re-measure, so a row that still overflows after
 * stepping down simply steps back up with a fresh record.
 */
export function resolveComposerFooterTier(
  state: ComposerFooterTierState,
  measurement: { width: number; overflowing: boolean },
): ComposerFooterTierState {
  const { tier, overflowWidths } = state;
  const { width, overflowing } = measurement;
  if (overflowing) {
    if (tier === "full") {
      return { tier: "icons", overflowWidths: { ...overflowWidths, full: width } };
    }
    if (tier === "icons") {
      return { tier: "compact", overflowWidths: { ...overflowWidths, icons: width } };
    }
    return state;
  }
  const canRetry = (limit: number | null) =>
    limit === null || width >= limit + COMPOSER_FOOTER_TIER_HYSTERESIS_PX;
  if (tier === "compact" && canRetry(overflowWidths.icons)) {
    return { tier: "icons", overflowWidths };
  }
  if (tier === "icons" && canRetry(overflowWidths.full)) {
    return { tier: "full", overflowWidths };
  }
  return state;
}

/**
 * The labels under the controls changed (model, mode, access, traits), so the
 * recorded overflow widths no longer describe them. Forgetting them lets the
 * next measurement retry the roomier tiers at the current width.
 */
export function resetComposerFooterTierWidths(
  state: ComposerFooterTierState,
): ComposerFooterTierState {
  return { tier: state.tier, overflowWidths: { full: null, icons: null } };
}

// Wide primary actions (plan follow-up, pending answers) are on the right of
// the row and compact by width alone.
export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX = 780;

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}
