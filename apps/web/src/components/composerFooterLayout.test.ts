import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  shouldUseCompactComposerPrimaryActions,
} from "./composerFooterLayout";

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
