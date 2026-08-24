export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 440;
export const COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX = 780;
export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX =
  COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX;

export function shouldUseCompactComposerFooter(width: number | null): boolean {
  return width !== null && width < COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
}

export function shouldUseIconOnlyComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX
    : COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}
