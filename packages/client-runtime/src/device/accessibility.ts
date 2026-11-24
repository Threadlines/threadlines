/**
 * The on-screen accessibility elements, for the Device tab's frame overlay
 * (docs/design/devices.md, "Round 2"): serve-sim's `/helper/<id>/ax` tree on
 * iOS, serve-emu's `/api/accessibility` node list on Android. Ported from T3
 * Code's deviceHubApi.ts (MIT, see NOTICE), over the device channel. Read-only.
 */
import type { DevicePlatform } from "@threadlines/contracts";

import type { DeviceHubTransport } from "./hubTransport.ts";

export interface DeviceAxElement {
  readonly id: string;
  /** What VoiceOver or TalkBack reads; empty for an unlabeled control. */
  readonly label: string;
  /** `Button`, `StaticText`, `TextView`… */
  readonly role: string;
  /** 0..1 of the screen as the user sees it, on both axes. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Enough for any real screen; a runaway tree stops here. */
const AX_ELEMENT_LIMIT = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** serve-sim's tree, in points of the first root's frame, flattened. Whole-screen containers are left out. */
export function flattenIosAxTree(roots: ReadonlyArray<unknown>): ReadonlyArray<DeviceAxElement> {
  const first = roots[0];
  const rootFrame = isRecord(first) && isRecord(first.frame) ? first.frame : null;
  const screenWidth = Math.max(1, numberOr(rootFrame?.width, 1));
  const screenHeight = Math.max(1, numberOr(rootFrame?.height, 1));
  const elements: DeviceAxElement[] = [];
  const ids = new Set<string>();
  const visit = (node: unknown, path: string) => {
    if (elements.length >= AX_ELEMENT_LIMIT || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    const width = numberOr(frame.width, 0);
    const height = numberOr(frame.height, 0);
    const coversScreen =
      Math.abs(width - screenWidth) < 0.5 && Math.abs(height - screenHeight) < 0.5;
    if (!coversScreen && width > 0 && height > 0) {
      // iOS can give a widget and its app's icon the same id.
      const unique =
        typeof node.AXUniqueId === "string" && node.AXUniqueId ? node.AXUniqueId : path;
      const id = ids.has(unique) ? `${unique}@${path}` : unique;
      ids.add(id);
      elements.push({
        id,
        label: typeof node.AXLabel === "string" ? node.AXLabel : "",
        role: typeof node.type === "string" ? node.type : "",
        x: numberOr(frame.x, 0) / screenWidth,
        y: numberOr(frame.y, 0) / screenHeight,
        width: width / screenWidth,
        height: height / screenHeight,
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, index) => visit(child, `${path}.${index}`));
  };
  roots.forEach((root, index) => visit(root, String(index)));
  return elements;
}

/** serve-emu's node list, in pixels of the first node's bounds. Unlabeled, unclickable nodes are left out. */
export function parseAndroidAxNodes(nodes: ReadonlyArray<unknown>): ReadonlyArray<DeviceAxElement> {
  const withBounds = nodes.filter(
    (node): node is Record<string, unknown> & { bounds: Record<string, unknown> } =>
      isRecord(node) && isRecord(node.bounds),
  );
  const root = withBounds[0]?.bounds;
  const screenWidth = Math.max(1, numberOr(root?.right, 1));
  const screenHeight = Math.max(1, numberOr(root?.bottom, 1));
  const elements: DeviceAxElement[] = [];
  for (let index = 1; index < withBounds.length && elements.length < AX_ELEMENT_LIMIT; index += 1) {
    const node = withBounds[index]!;
    const left = numberOr(node.bounds.left, 0);
    const top = numberOr(node.bounds.top, 0);
    const width = (numberOr(node.bounds.right, left) - left) / screenWidth;
    const height = (numberOr(node.bounds.bottom, top) - top) / screenHeight;
    const text = typeof node.text === "string" ? node.text : "";
    const description = typeof node.contentDescription === "string" ? node.contentDescription : "";
    const label = text || description;
    if (width <= 0 || height <= 0 || (width >= 0.95 && height >= 0.9)) continue;
    if (!label && node.clickable !== true) continue;
    const className = typeof node.className === "string" ? node.className : "";
    elements.push({
      // Node ids are not promised unique; the position in the list is.
      id: `${index - 1}:${typeof node.id === "string" || typeof node.id === "number" ? node.id : ""}`,
      label,
      role: className.split(".").at(-1) ?? "",
      x: left / screenWidth,
      y: top / screenHeight,
      width,
      height,
    });
  }
  return elements;
}

const errorOf = (payload: unknown) =>
  isRecord(payload) && typeof payload.error === "string" ? payload.error : null;

/** Reads the elements on screen now. Throws with the hub's reason when it has none to give. */
export async function readDeviceAxElements(
  transport: DeviceHubTransport,
  target: { readonly platform: DevicePlatform; readonly deviceId: string },
  signal?: AbortSignal,
): Promise<ReadonlyArray<DeviceAxElement>> {
  const device = encodeURIComponent(target.deviceId);
  const response = await transport.fetch(
    target.platform === "ios"
      ? `/vendor/serve-sim/helper/${device}/ax`
      : `/vendor/serve-emu/api/accessibility?device=${device}`,
    signal ? { signal } : {},
  );
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
  }
  if (!response.ok) throw new Error(errorOf(payload) ?? `Accessibility ${response.status}`);
  if (target.platform === "ios") {
    if (!Array.isArray(payload))
      throw new Error(errorOf(payload) ?? "Unexpected accessibility reply.");
    return flattenIosAxTree(payload);
  }
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) {
    throw new Error(errorOf(payload) ?? "Unexpected accessibility reply.");
  }
  return parseAndroidAxNodes(payload.nodes);
}

/** The smallest element under a point (0..1 of the screen), the one a finger there would hit. */
export function deviceAxElementAt(
  elements: ReadonlyArray<DeviceAxElement>,
  x: number,
  y: number,
): DeviceAxElement | null {
  let best: DeviceAxElement | null = null;
  for (const element of elements) {
    if (
      x < element.x ||
      y < element.y ||
      x > element.x + element.width ||
      y > element.y + element.height
    )
      continue;
    if (!best || element.width * element.height < best.width * best.height) best = element;
  }
  return best;
}
