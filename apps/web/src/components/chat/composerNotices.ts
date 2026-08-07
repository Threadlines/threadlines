/**
 * The one notice surface above the composer.
 *
 * Provider status, turn errors, held sends, version skew and environment
 * trouble all used to float their own box at the top of the chat and stack on
 * each other. They are all statements about whether the next message can be
 * sent, so they now share a single slim row docked to the composer, and this
 * module decides which one that row shows.
 *
 * @module composerNotices
 */
import type { ReactNode } from "react";

export type ComposerNoticeSeverity = "error" | "warning" | "info";

export interface ComposerNotice {
  readonly id: string;
  readonly severity: ComposerNoticeSeverity;
  /** Bold opening phrase naming the condition, e.g. "Codex needs sign-in." */
  readonly lead: string;
  /** Plain continuation of the lead. Truncates with the row. */
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

const SEVERITY_RANK: Record<ComposerNoticeSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Orders active notices worst-first and drops the merely informational ones
 * while something is actually wrong.
 *
 * Version skew and update availability are worth a line when the composer is
 * otherwise calm, but behind a "1 more" expander on top of a failed turn they
 * are just noise, so they wait for the urgent notice to clear instead.
 * Ordering is stable, so same-severity notices keep the order the caller
 * listed them in.
 */
export function selectComposerNotices(
  notices: ReadonlyArray<ComposerNotice | null | undefined>,
): ReadonlyArray<ComposerNotice> {
  const present = notices.filter((notice): notice is ComposerNotice => Boolean(notice));
  const hasUrgentNotice = present.some((notice) => notice.severity !== "info");
  const eligible = hasUrgentNotice
    ? present.filter((notice) => notice.severity !== "info")
    : present;
  return eligible
    .slice()
    .sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
}
