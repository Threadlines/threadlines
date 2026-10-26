import { vi } from "vite-plus/test";

/**
 * Stands in for iPhone Safari's on-screen keyboard in a browser test: it
 * slides over the page, shrinking only the visual viewport, and Safari may
 * scroll the page up to show the focused field. Undo with `vi.restoreAllMocks`.
 */
export function showOnScreenKeyboard(input: {
  readonly height: number;
  readonly pageScrolledUpBy: number;
}): void {
  const viewport = window.visualViewport;
  if (!viewport) throw new Error("This browser has no visualViewport.");
  const fullHeight = viewport.height;
  vi.spyOn(viewport, "height", "get").mockReturnValue(fullHeight - input.height);
  vi.spyOn(viewport, "offsetTop", "get").mockReturnValue(input.pageScrolledUpBy);
  viewport.dispatchEvent(new Event("resize"));
}
