import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { showOnScreenKeyboard } from "../hooks/useOnScreenKeyboardInset.browser-harness";
import { installOnScreenKeyboardFlag, ON_SCREEN_KEYBOARD_ATTRIBUTE } from "./onScreenKeyboard";

describe("installOnScreenKeyboardFlag", () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    vi.restoreAllMocks();
  });

  it("flags the page while a keyboard is up, even once Safari scrolled the page clear of it", () => {
    const root = document.documentElement;
    uninstall = installOnScreenKeyboardFlag();
    expect(root.hasAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE)).toBe(false);

    // A composer at the bottom of the page: Safari scrolls it up by the
    // keyboard's whole height, so the keyboard covers none of the page.
    showOnScreenKeyboard({ height: 260, pageScrolledUpBy: 260 });
    expect(root.hasAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE)).toBe(true);

    vi.restoreAllMocks();
    window.visualViewport?.dispatchEvent(new Event("resize"));
    expect(root.hasAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE)).toBe(false);
  });
});
