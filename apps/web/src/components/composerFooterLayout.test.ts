import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FOOTER_OVERFLOW_SLACK_PX,
  COMPOSER_FOOTER_TIER_HYSTERESIS_PX,
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  INITIAL_COMPOSER_FOOTER_TIER_STATE,
  isComposerFooterOverflowing,
  resetComposerFooterTierWidths,
  resolveComposerFooterTier,
  shouldUseCompactComposerPrimaryActions,
} from "./composerFooterLayout";

describe("resolveComposerFooterTier", () => {
  it("drops every label to icons together when the labelled row overflows", () => {
    const next = resolveComposerFooterTier(INITIAL_COMPOSER_FOOTER_TIER_STATE, {
      width: 600,
      overflowing: true,
    });
    expect(next.tier).toBe("icons");
    expect(next.overflowWidths.full).toBe(600);
  });

  it("collapses into the overflow menu when the icon row overflows too", () => {
    const icons = resolveComposerFooterTier(INITIAL_COMPOSER_FOOTER_TIER_STATE, {
      width: 600,
      overflowing: true,
    });
    const compact = resolveComposerFooterTier(icons, { width: 600, overflowing: true });
    expect(compact.tier).toBe("compact");
    expect(compact.overflowWidths).toEqual({ full: 600, icons: 600 });
    expect(resolveComposerFooterTier(compact, { width: 600, overflowing: true })).toBe(compact);
  });

  it("only retries a roomier tier once the composer is clearly wider than where it overflowed", () => {
    const icons = resolveComposerFooterTier(INITIAL_COMPOSER_FOOTER_TIER_STATE, {
      width: 600,
      overflowing: true,
    });
    expect(
      resolveComposerFooterTier(icons, {
        width: 600 + COMPOSER_FOOTER_TIER_HYSTERESIS_PX - 1,
        overflowing: false,
      }).tier,
    ).toBe("icons");
    expect(
      resolveComposerFooterTier(icons, {
        width: 600 + COMPOSER_FOOTER_TIER_HYSTERESIS_PX,
        overflowing: false,
      }).tier,
    ).toBe("full");
  });

  it("steps back one tier at a time from the overflow menu", () => {
    const compact: typeof INITIAL_COMPOSER_FOOTER_TIER_STATE = {
      tier: "compact",
      overflowWidths: { full: 700, icons: 500 },
    };
    const icons = resolveComposerFooterTier(compact, { width: 900, overflowing: false });
    expect(icons.tier).toBe("icons");
    expect(resolveComposerFooterTier(icons, { width: 900, overflowing: false }).tier).toBe("full");
  });

  it("retries the roomier tier at the same width after the labels change", () => {
    const icons = resolveComposerFooterTier(INITIAL_COMPOSER_FOOTER_TIER_STATE, {
      width: 600,
      overflowing: true,
    });
    expect(resolveComposerFooterTier(icons, { width: 600, overflowing: false }).tier).toBe("icons");
    const reset = resetComposerFooterTierWidths(icons);
    expect(reset.tier).toBe("icons");
    expect(resolveComposerFooterTier(reset, { width: 600, overflowing: false }).tier).toBe("full");
  });
});

describe("isComposerFooterOverflowing", () => {
  it("counts a row as overflowing before its content actually clips", () => {
    expect(isComposerFooterOverflowing(0)).toBe(true);
    expect(isComposerFooterOverflowing(-COMPOSER_FOOTER_OVERFLOW_SLACK_PX + 1)).toBe(true);
    expect(isComposerFooterOverflowing(-COMPOSER_FOOTER_OVERFLOW_SLACK_PX)).toBe(false);
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("compacts wide primary actions below the breakpoint", () => {
    expect(shouldUseCompactComposerPrimaryActions(300)).toBe(false);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});
