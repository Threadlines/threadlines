import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX,
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
  shouldUseIconOnlyComposerFooter,
} from "./composerFooterLayout";

describe("shouldUseCompactComposerFooter", () => {
  it("stays expanded without a measured width", () => {
    expect(shouldUseCompactComposerFooter(null)).toBe(false);
  });

  it("switches to compact mode below the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("stays expanded at and above the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)).toBe(false);
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)).toBe(false);
  });
});

describe("shouldUseIconOnlyComposerFooter", () => {
  it("uses icons before the footer collapses into the overflow menu", () => {
    expect(shouldUseIconOnlyComposerFooter(COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX - 1)).toBe(true);
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX - 1)).toBe(false);
  });

  it("stays expanded at and above the icon-only breakpoint", () => {
    expect(shouldUseIconOnlyComposerFooter(COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX)).toBe(false);
  });

  it("uses icons earlier when the primary actions are wide", () => {
    expect(
      shouldUseIconOnlyComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseIconOnlyComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("matches the wide footer breakpoint", () => {
    expect(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX).toBe(
      COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX,
    );
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
