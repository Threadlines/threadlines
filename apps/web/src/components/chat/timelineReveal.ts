/**
 * Bringing one row of the virtualized chat list on screen, and a spot inside
 * it into view. Shared by everything that jumps through the chat: a followed
 * link, a command-palette search hit, find in chat.
 *
 * The list aims by guessed heights for rows it has not drawn yet, and rows
 * can move while it scrolls (older steps loading, a row being measured), so a
 * reveal scrolls, waits for the row to be drawn, and scrolls again if it never
 * appears. Once placed, a row can be held there while the list finishes
 * measuring the rows it drew on the way.
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
  /**
   * Keeps the row where `onRow` put it while the list finishes measuring the
   * rows it drew on the way, which can push it off a frame or two late.
   * Unset: no hold.
   */
  readonly hold?: RevealHold | undefined;
  readonly onGiveUp?: (() => void) | undefined;
}

/**
 * How a placed row is held. Only a move of the row within the list's content
 * (a row above it measured anew) hands it back to `onRow`: a scroll, the
 * reader's or the list's, leaves that place alone, so the hold never fights
 * one. It ends once the row is `isPlaced` and has kept still for
 * HOLD_STILL_FRAMES, or after `durationMs`: the list can put off a scroll
 * while it measures, so a placement may land some frames late.
 */
export interface RevealHold {
  readonly durationMs: number;
  readonly isPlaced: (row: HTMLElement) => boolean;
}

/** Frames a held row must keep still, in place, before the hold ends. */
const HOLD_STILL_FRAMES = 3;

/** Where a drawn row's top sits within the list's content; null without a list. */
function offsetInContent(list: LegendListRef | null, row: HTMLElement): number | null {
  const scrollableNode = list?.getScrollableNode?.();
  if (!scrollableNode) return null;
  return (
    row.getBoundingClientRect().top -
    scrollableNode.getBoundingClientRect().top +
    (finiteScrollMetric(scrollableNode.scrollTop) ?? 0)
  );
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

  const holdRow = (hold: RevealHold, until: number, lastOffset: number, stillFrames: number) => {
    if (stillFrames >= HOLD_STILL_FRAMES || performance.now() > until) return;
    nextFrame(() => {
      const row = options.findRow();
      const offset = row ? offsetInContent(options.getList(), row) : null;
      if (!row || offset === null) return;
      if (Math.abs(offset - lastOffset) >= 1) {
        options.onRow(row);
        holdRow(hold, until, offset, 0);
      } else {
        holdRow(hold, until, offset, hold.isPlaced(row) ? stillFrames + 1 : 0);
      }
    });
  };

  const waitForRow = (renderAttemptsLeft: number, scrollAttemptsLeft: number) => {
    nextFrame(() => {
      const row = options.findRow();
      if (row) {
        options.onRow(row);
        const offset = options.hold ? offsetInContent(options.getList(), row) : null;
        if (options.hold && offset !== null) {
          holdRow(options.hold, performance.now() + options.hold.durationMs, offset, 0);
        }
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
