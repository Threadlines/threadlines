/**
 * The composer stamps its footer's reserve on its form while the footer
 * shows, so the right panel's drag limit still knows it while a question or
 * an approval replaces the footer (the footer comes back afterwards).
 */
export const COMPOSER_FOOTER_RESERVE_ATTRIBUTE = "data-chat-composer-footer-reserve";

/**
 * Room the footer's right-hand buttons take, the gap before them included:
 * what the right panel's drag limit keeps free beside the left controls.
 */
export function measureComposerFooterReserve(footer: HTMLElement): number {
  const rightActions = footer.querySelector<HTMLElement>("[data-chat-composer-actions='right']");
  const style = getComputedStyle(footer);
  const gap = Number.parseFloat(style.columnGap) || Number.parseFloat(style.gap) || 0;
  return (rightActions?.getBoundingClientRect().width ?? 0) + gap;
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
