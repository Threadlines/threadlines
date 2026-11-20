/**
 * The floating device window's geometry: its size from the screen's aspect,
 * kept inside the window, and how a drag or an edge resize moves it. Pure, in
 * window pixels. The window's height follows its width, so every resize is a
 * width change.
 */

/** The title strip the window is dragged by. */
export const DEVICE_FLOAT_HEADER_HEIGHT = 28;
/** Room around the device frame inside the window. */
const BODY_PADDING = 6;
/** The device frame's bezel and hairline around the screen (DeviceStreamView). */
const FRAME_INSET = 7;
export const DEVICE_FLOAT_MIN_WIDTH = 180;
export const DEVICE_FLOAT_DEFAULT_WIDTH = 260;
const MAX_WIDTH = 640;
/** The gap kept between the window and the edges of the app window. */
export const DEVICE_FLOAT_MARGIN = 8;

export interface DeviceFloatRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DeviceFloatViewport {
  readonly width: number;
  readonly height: number;
}

export type DeviceFloatEdge = "left" | "right" | "bottom" | "bottomLeft" | "bottomRight";

/** Side padding is on both sides; below the title strip there is padding at the bottom only. */
const insetX = 2 * (BODY_PADDING + FRAME_INSET);
const insetY = BODY_PADDING + 2 * FRAME_INSET;

/** The window's height for a width, showing a screen of `aspect` (width / height). */
export function deviceFloatHeight(width: number, aspect: number): number {
  return Math.round(DEVICE_FLOAT_HEADER_HEIGHT + (width - insetX) / aspect + insetY);
}

function widthForHeight(height: number, aspect: number): number {
  return (height - DEVICE_FLOAT_HEADER_HEIGHT - insetY) * aspect + insetX;
}

/** The widest the window may be: within its cap, and short enough to fit the app window. */
function maxWidth(aspect: number, viewport: DeviceFloatViewport): number {
  const byWidth = viewport.width - 2 * DEVICE_FLOAT_MARGIN;
  const byHeight = widthForHeight(viewport.height - 2 * DEVICE_FLOAT_MARGIN, aspect);
  return Math.max(DEVICE_FLOAT_MIN_WIDTH, Math.min(MAX_WIDTH, byWidth, byHeight));
}

function clampWidth(width: number, aspect: number, viewport: DeviceFloatViewport): number {
  return Math.round(Math.min(maxWidth(aspect, viewport), Math.max(DEVICE_FLOAT_MIN_WIDTH, width)));
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where the window sits: its wanted spot and width, kept inside the app
 * window. A window too small for the minimum size pins to the top left.
 */
export function fitDeviceFloat(input: {
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly aspect: number;
  readonly viewport: DeviceFloatViewport;
}): DeviceFloatRect {
  const width = clampWidth(input.width, input.aspect, input.viewport);
  const height = deviceFloatHeight(width, input.aspect);
  return {
    x: Math.round(
      clamp(
        input.position.x,
        DEVICE_FLOAT_MARGIN,
        input.viewport.width - width - DEVICE_FLOAT_MARGIN,
      ),
    ),
    y: Math.round(
      clamp(
        input.position.y,
        DEVICE_FLOAT_MARGIN,
        input.viewport.height - height - DEVICE_FLOAT_MARGIN,
      ),
    ),
    width,
    height,
  };
}

/** The window moved by a drag of (dx, dy) from where it started. */
export function dragDeviceFloat(
  start: DeviceFloatRect,
  dx: number,
  dy: number,
  aspect: number,
  viewport: DeviceFloatViewport,
): DeviceFloatRect {
  return fitDeviceFloat({
    position: { x: start.x + dx, y: start.y + dy },
    width: start.width,
    aspect,
    viewport,
  });
}

/**
 * The window resized from an edge by a pointer move of (dx, dy). The edge
 * opposite the one held stays put: the left edge keeps the right one, and
 * the top stays where it is.
 */
export function resizeDeviceFloat(
  start: DeviceFloatRect,
  edge: DeviceFloatEdge,
  dx: number,
  dy: number,
  aspect: number,
  viewport: DeviceFloatViewport,
): DeviceFloatRect {
  const byHeight = widthForHeight(start.height + dy, aspect) - start.width;
  const fromLeft = edge === "left" || edge === "bottomLeft";
  const delta =
    edge === "bottom"
      ? byHeight
      : edge === "left"
        ? -dx
        : edge === "right"
          ? dx
          : // A corner follows whichever way the pointer pulled further.
            Math.abs(fromLeft ? -dx : dx) >= Math.abs(byHeight)
            ? fromLeft
              ? -dx
              : dx
            : byHeight;
  const width = clampWidth(start.width + delta, aspect, viewport);
  const right = start.x + start.width;
  return fitDeviceFloat({
    position: { x: fromLeft ? right - width : start.x, y: start.y },
    width,
    aspect,
    viewport,
  });
}
