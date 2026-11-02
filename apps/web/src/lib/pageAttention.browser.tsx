import { COMPUTER_IN_USE_MS } from "@threadlines/shared/phoneAlerts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { isPageAttended, isPageInUse, onPageUseChange, pageIdleMs } from "./pageAttention";

describe("onPageUseChange", () => {
  beforeEach(async () => {
    await page.elementLocator(document.body).click();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls a window left alone out of use, and back in use at the next touch", () => {
    const changed = vi.fn();
    const stop = onPageUseChange(changed);
    try {
      window.dispatchEvent(new KeyboardEvent("keydown"));
      expect(isPageAttended()).toBe(true);
      expect(isPageInUse()).toBe(true);

      vi.advanceTimersByTime(COMPUTER_IN_USE_MS - 1_000);
      window.dispatchEvent(new KeyboardEvent("keydown"));
      expect(pageIdleMs()).toBe(0);
      vi.advanceTimersByTime(COMPUTER_IN_USE_MS - 1);
      expect(isPageInUse()).toBe(true);
      expect(changed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(isPageInUse()).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new KeyboardEvent("keydown"));
      expect(isPageInUse()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("doesn't call an untouched window in use after the clock steps back", () => {
    const stop = onPageUseChange(vi.fn());
    try {
      window.dispatchEvent(new KeyboardEvent("keydown"));
      expect(isPageInUse()).toBe(true);
      vi.setSystemTime(Date.now() - 60 * 60_000);
      expect(isPageInUse()).toBe(false);
      window.dispatchEvent(new KeyboardEvent("keydown"));
      expect(isPageInUse()).toBe(true);
    } finally {
      stop();
    }
  });
});
