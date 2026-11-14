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

  it("does not take a page that is off screen for a moment for a keyboard", () => {
    const root = document.documentElement;
    uninstall = installOnScreenKeyboardFlag();

    // A folding phone moving the page from one of its screens to the other:
    // for a moment none of the page shows.
    showOnScreenKeyboard({ height: window.visualViewport!.height, pageScrolledUpBy: 0 });
    expect(root.hasAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE)).toBe(false);
  });

  it("looks again when the window resizes with no word from the visual viewport", () => {
    const root = document.documentElement;
    uninstall = installOnScreenKeyboardFlag();
    const viewport = window.visualViewport!;

    vi.spyOn(viewport, "height", "get").mockReturnValue(viewport.height - 260);
    expect(root.hasAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE)).toBe(false);
    window.dispatchEvent(new Event("resize"));
    expect(root.hasAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE)).toBe(true);
  });
});
