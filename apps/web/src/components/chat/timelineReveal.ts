/**
 * Bringing one row of the virtualized chat list on screen, and a spot inside
 * it into view. Shared by everything that jumps through the chat: a followed
 * link, a command-palette search hit, find in chat.
 *
 * The list aims by guessed heights for rows it has not drawn yet, and rows
 * can move while it scrolls (older steps loading, a row being measured), so a
 * reveal scrolls, waits for the row to be drawn, and scrolls again if it never
 * appears.
 */
import type { LegendListRef } from "@legendapp/list/react";

export function finiteScrollMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface TimelineRowRevealOptions {
  readonly getList: () => LegendListRef | null;
  /** The row's index now; rows can change between attempts. Negative gives up. */
  readonly resolveIndex: () => number;
  /** The row's element once the list has drawn it. */
  readonly findRow: () => HTMLElement | null;
  /** Where in the list the row is aimed at, as a fraction from the top. */
  readonly viewPosition: number;
  /** Whether the scroll of a given attempt animates (counting down to 1). */
  readonly animated: (attemptsLeft: number) => boolean;
  /** Times the list is scrolled to the row before giving up. */
  readonly scrollAttempts: number;
  /** Frames waited after each scroll for the row to be drawn. */
  readonly renderAttempts: number;
  readonly onRow: (row: HTMLElement) => void;
  readonly onGiveUp?: (() => void) | undefined;
}

/** Scrolls to a row until it is drawn, then hands it over. Returns a cancel. */
export function revealTimelineRow(options: TimelineRowRevealOptions): () => void {
  let cancelled = false;
  const frameIds: number[] = [];
  const nextFrame = (callback: () => void) => {
    frameIds.push(
      window.requestAnimationFrame(() => {
        if (!cancelled) callback();
      }),
    );
  };
  const giveUp = () => {
    if (!cancelled) options.onGiveUp?.();
  };

  const waitForRow = (renderAttemptsLeft: number, scrollAttemptsLeft: number) => {
    nextFrame(() => {
      const row = options.findRow();
      if (row) {
        options.onRow(row);
      } else if (renderAttemptsLeft > 1) {
        waitForRow(renderAttemptsLeft - 1, scrollAttemptsLeft);
      } else if (scrollAttemptsLeft > 1) {
        scrollToRow(scrollAttemptsLeft - 1);
      } else {
        giveUp();
      }
    });
  };

  function scrollToRow(attemptsLeft: number): void {
    nextFrame(() => {
      const list = options.getList();
      const index = options.resolveIndex();
      if (index < 0) {
        giveUp();
        return;
      }
      if (!list) {
        if (attemptsLeft > 1) scrollToRow(attemptsLeft - 1);
        else giveUp();
        return;
      }
      void list
        .scrollToIndex({
          index,
          animated: options.animated(attemptsLeft),
          viewPosition: options.viewPosition,
        })
        .then(
          () => {
            if (!cancelled) waitForRow(options.renderAttempts, attemptsLeft);
          },
          () => {
            if (cancelled) return;
            if (attemptsLeft > 1) scrollToRow(attemptsLeft - 1);
            else giveUp();
          },
        );
    });
  }

  scrollToRow(options.scrollAttempts);
  return () => {
    cancelled = true;
    for (const frameId of frameIds) {
      window.cancelAnimationFrame(frameId);
    }
  };
}

/**
 * Scrolls the list so `rect` (a drawn row, or a range inside one) sits at
 * `viewPosition` of the visible list, unless it is already inside the list's
 * visible area less the given insets. Returns whether it scrolled.
 */
export function scrollRectIntoTimelineView(
  list: LegendListRef | null,
  rect: Pick<DOMRect, "top" | "bottom">,
  options: {
    readonly viewPosition: number;
    /** Clearance kept at the top (something floats there) and at the bottom. */
    readonly topInsetPx: number;
    readonly bottomInsetPx: number;
    /** Scroll even when already inside the safe area (to put it exactly there). */
    readonly always?: boolean | undefined;
  },
): boolean {
  const scrollableNode = list?.getScrollableNode?.();
  if (!list || !scrollableNode) {
    return false;
  }
  const viewportRect = scrollableNode.getBoundingClientRect();
  const safeTop = viewportRect.top + options.topInsetPx;
  const safeBottom = viewportRect.bottom - options.bottomInsetPx;
  if (!options.always && rect.top >= safeTop && rect.bottom <= safeBottom) {
    return false;
  }
  const targetTop = viewportRect.top + viewportRect.height * options.viewPosition;
  if (Math.abs(rect.top - targetTop) < 4) {
    return false;
  }
  const currentOffset = finiteScrollMetric(scrollableNode.scrollTop) ?? 0;
  void list.scrollToOffset({
    offset: Math.max(0, currentOffset + rect.top - targetTop),
    animated: false,
  });
  return true;
}
