import type { DevicePlatform } from "@threadlines/contracts";
import {
  duoActivePanel,
  duoVisiblePanels,
  type DeviceOrientationName,
  type DeviceScreenSize,
  type DuoPanelId,
} from "@threadlines/client-runtime/device";

import type { DeviceBody } from "./deviceShapes";

/** The largest box of `aspect` (width / height) that fits `width` × `height`. */
export function fitDeviceFrame(aspect: number, width: number, height: number) {
  if (width <= 0 || height <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { width: 0, height: 0 };
  }
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= width ? byHeight : { width, height: width / aspect };
}

/** The screen's width / height as shown, before the first frame a phone's usual shape. */
export function deviceScreenAspect(platform: DevicePlatform, screen: DeviceScreenSize | null) {
  if (!screen) return platform === "ios" ? 9 / 19.5 : 9 / 20;
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape ? long / short : short / long;
}

/** serve-sim sends portrait framebuffers even when iOS is landscape; the view turns them. */
export function deviceScreenRotation(platform: DevicePlatform, screen: DeviceScreenSize | null) {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
  return orientationTurn(screen.orientation);
}

/** A clockwise CSS rotation in quarter turns. */
export type QuarterTurn = 0 | 90 | 180 | -90;

const ORIENTATION_TURN: Record<DeviceOrientationName, QuarterTurn> = {
  portrait: 0,
  landscape_left: 90,
  landscape_right: -90,
  portrait_upside_down: 180,
};

export const orientationTurn = (orientation: DeviceOrientationName) =>
  ORIENTATION_TURN[orientation];

export function normalizeTurn(degrees: number): QuarterTurn {
  const turn = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  return turn === 270 ? -90 : (turn as QuarterTurn);
}

const sideways = (turn: QuarterTurn) => turn === 90 || turn === -90;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a point of an upright `width` × `height` drawing lands once turned (in the turned box). */
export function turnPoint(x: number, y: number, width: number, height: number, turn: QuarterTurn) {
  switch (turn) {
    case 90:
      return { x: height - y, y: x };
    case -90:
      return { x: y, y: width - x };
    case 180:
      return { x: width - x, y: height - y };
    default:
      return { x, y };
  }
}

/** The inverse of `turnPoint`: a point of the turned box back on the upright drawing. */
export function unturnPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  turn: QuarterTurn,
) {
  switch (turn) {
    case 90:
      return { x: y, y: height - x };
    case -90:
      return { x: width - y, y: x };
    case 180:
      return { x: width - x, y: height - y };
    default:
      return { x, y };
  }
}

export function turnRect(rect: Rect, width: number, height: number, turn: QuarterTurn): Rect {
  const a = turnPoint(rect.x, rect.y, width, height, turn);
  const b = turnPoint(rect.x + rect.width, rect.y + rect.height, width, height, turn);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** How far a side button stands off the body, in points; the layout leaves room for it. */
export const DEVICE_BUTTON_DEPTH = 3;

/** One body laid out upright, in points: its outline and its screen inside it. */
export interface BodyBox {
  readonly width: number;
  readonly height: number;
  readonly screen: Rect;
}

/**
 * The body around a screen of `aspect` (width / height, upright). The
 * model's screen width stays and the height follows the simulator, so a
 * resized or unexpected screen still fits its bezels.
 */
export function bodyBox(body: DeviceBody, aspect: number): BodyBox {
  const width = body.screen.width;
  const height = Number.isFinite(aspect) && aspect > 0 ? width / aspect : body.screen.height;
  return {
    width: body.bezel.left + width + body.bezel.right,
    height: body.bezel.top + height + body.bezel.bottom,
    screen: { x: body.bezel.left, y: body.bezel.top, width, height },
  };
}

/**
 * A single screen's drawing: how the whole device turns (`turn`), how the
 * stream turns inside its screen (`canvasTurn`), and the screen's upright
 * aspect. iOS turns the device with its UI, since its frames stay portrait;
 * Android's frames already come the way the UI faces, so the device turns
 * only to match their shape and the stream turns back inside it.
 */
export function singleDeviceTurns(
  platform: DevicePlatform,
  screen: DeviceScreenSize | null,
  bodyLandscape: boolean,
) {
  const aspect = deviceScreenAspect(platform, screen);
  const content = deviceScreenRotation(platform, screen);
  const turn: QuarterTurn = content !== 0 ? content : aspect > 1 !== bodyLandscape ? -90 : 0;
  return {
    turn,
    canvasTurn: normalizeTurn(content - turn),
    uprightAspect: sideways(turn) ? 1 / aspect : aspect,
  };
}

/** A drawing of `width` × `height` points turned by `turn`, scaled to fit `host`, centered. */
export function fitTurned(
  size: { readonly width: number; readonly height: number },
  turn: QuarterTurn,
  host: { readonly width: number; readonly height: number },
  margin: number,
) {
  const width = sideways(turn) ? size.height : size.width;
  const height = sideways(turn) ? size.width : size.height;
  const scale =
    width > 0 && height > 0
      ? Math.max(
          0,
          Math.min((host.width - 2 * margin) / width, (host.height - 2 * margin) / height),
        )
      : 0;
  return {
    scale,
    /** The turned drawing's box in the host, in px. */
    box: {
      x: (host.width - width * scale) / 2,
      y: (host.height - height * scale) / 2,
      width: width * scale,
      height: height * scale,
    },
  };
}

/** Points between the Duo's two halves when both show. */
export const DUO_GAP = 28;

export interface DuoPanelBox {
  readonly id: DuoPanelId;
  /** The body's top left in the upright drawing. */
  readonly x: number;
  readonly y: number;
  readonly box: BodyBox;
  /** The stream's turn inside this screen: the inner panel is mounted a quarter turn. */
  readonly canvasTurn: QuarterTurn;
}

/**
 * The iPhone Duo upright: the cover alone when closed, the inner screen
 * alone (open, wide, hinge down the middle) when open, and both side by side
 * part way, the cover on the left where the hinge swings it. The whole
 * drawing turns with the display in front: its UI faces the user.
 */
export function duoLayout(
  screen: DeviceScreenSize,
  bodies: { readonly cover: DeviceBody; readonly inner: DeviceBody },
) {
  const active = duoActivePanel(screen);
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  const aspectOf = (id: DuoPanelId) => {
    const body = id === 1 ? bodies.cover : bodies.inner;
    if (id !== active) return body.screen.width / body.screen.height;
    // The cover's framebuffer is upright; the inner one is a quarter turn from its wide face.
    return id === 1 ? short / long : long / short;
  };
  const visible = duoVisiblePanels(screen);
  const boxes = visible.map((id) => bodyBox(id === 1 ? bodies.cover : bodies.inner, aspectOf(id)));
  const height = Math.max(...boxes.map((box) => box.height));
  let x = 0;
  const panels: DuoPanelBox[] = visible.map((id, index) => {
    const box = boxes[index]!;
    const panel = {
      id,
      x,
      y: (height - box.height) / 2,
      box,
      canvasTurn: id === 3 ? 90 : 0,
    } as const;
    x += box.width + DUO_GAP;
    return panel;
  });
  const turn = normalizeTurn(orientationTurn(screen.orientation) - (active === 3 ? 90 : 0));
  return { panels, width: x - DUO_GAP, height, turn, active };
}

/** Where a point of the turned Duo drawing falls on one display's framebuffer (0..1, clamped). */
export function duoPanelPoint(
  layout: ReturnType<typeof duoLayout>,
  panelId: DuoPanelId,
  /** In points of the turned drawing. */
  x: number,
  y: number,
) {
  const panel = layout.panels.find((candidate) => candidate.id === panelId);
  if (!panel) return null;
  const upright = unturnPoint(x, y, layout.width, layout.height, layout.turn);
  const screen = panel.box.screen;
  const u = (upright.x - panel.x - screen.x) / screen.width;
  const v = (upright.y - panel.y - screen.y) / screen.height;
  const inside = u >= 0 && v >= 0 && u <= 1 && v <= 1;
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));
  // The inner panel's stream is turned a quarter clockwise: undo it for its framebuffer.
  const raw = panel.id === 3 ? { x: cv, y: 1 - cu } : { x: cu, y: cv };
  return { inside, ...raw };
}

/**
 * The display a point on the turned Duo drawing touches, and where on its
 * framebuffer (0..1), or null off every screen. `active` is false for a
 * display not in front, whose touches the view drops.
 */
export function duoTouchPoint(
  layout: ReturnType<typeof duoLayout>,
  /** In points of the turned drawing. */
  x: number,
  y: number,
) {
  for (const panel of layout.panels) {
    const point = duoPanelPoint(layout, panel.id, x, y);
    if (point?.inside) {
      return { panel: panel.id, active: panel.id === layout.active, x: point.x, y: point.y };
    }
  }
  return null;
}

/** A display's screen on the turned drawing, in points (for overlays that face the user). */
export function duoScreenRect(layout: ReturnType<typeof duoLayout>, panelId: DuoPanelId) {
  const panel = layout.panels.find((candidate) => candidate.id === panelId);
  if (!panel) return null;
  const screen = panel.box.screen;
  return turnRect(
    { x: panel.x + screen.x, y: panel.y + screen.y, width: screen.width, height: screen.height },
    layout.width,
    layout.height,
    layout.turn,
  );
}
