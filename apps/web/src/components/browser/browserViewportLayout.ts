/**
 * Geometry for the preview surface.
 *
 * The webview is placed at computed coordinates rather than centred by flex,
 * and scaled by a transform on the element itself. Both matter: Electron
 * positions the guest's surface from the element's own box, so a transform on
 * an ancestor moves the element without moving what the guest paints, and a
 * flex-centred element sits where its *unscaled* size says it should while
 * drawing somewhere else. Either one leaves the page visibly offset inside its
 * own frame.
 *
 * Keeping the arithmetic here rather than in the component means the placement
 * can be checked without a browser.
 */

export interface BrowserViewport {
  /** null means the page fills the panel and reflows with it. */
  width: number | null;
  height: number | null;
}

export interface BrowserViewportLayout {
  /** The surface the frame is placed within; always the full container. */
  canvasWidth: number;
  canvasHeight: number;
  /** Top-left of the frame's visible footprint, within the canvas. */
  x: number;
  y: number;
  /** What the frame occupies on screen, after fitting. */
  width: number;
  height: number;
  /**
   * Presentation only: the guest keeps the CSS viewport it was asked for, so a
   * scaled-down phone still reports a phone's width to the page.
   */
  scale: number;
  fills: boolean;
}

function positiveOrOne(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function resolveBrowserViewportLayout(input: {
  container: { width: number; height: number };
  viewport: BrowserViewport;
  zoomFactor?: number;
}): BrowserViewportLayout {
  const canvasWidth = Math.max(1, Math.round(input.container.width));
  const canvasHeight = Math.max(1, Math.round(input.container.height));

  if (input.viewport.width === null || input.viewport.height === null) {
    return {
      canvasWidth,
      canvasHeight,
      x: 0,
      y: 0,
      width: canvasWidth,
      height: canvasHeight,
      scale: 1,
      fills: true,
    };
  }

  const zoomFactor = positiveOrOne(input.zoomFactor ?? 1);
  const renderedWidth = input.viewport.width * zoomFactor;
  const renderedHeight = input.viewport.height * zoomFactor;
  // Only ever scales down. A device smaller than the panel is shown at its own
  // size, because blowing a phone up to fill a wide panel would misrepresent it.
  const scale = Math.min(1, canvasWidth / renderedWidth, canvasHeight / renderedHeight);
  const width = renderedWidth * scale;
  const height = renderedHeight * scale;

  return {
    canvasWidth,
    canvasHeight,
    x: Math.max(0, Math.round((canvasWidth - width) / 2)),
    y: Math.max(0, Math.round((canvasHeight - height) / 2)),
    width,
    height,
    scale,
    fills: false,
  };
}
