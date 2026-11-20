/**
 * A device's accessibility tree, flattened to the element frames on screen:
 * iOS from the device's serve-sim helper (`/vendor/serve-sim/helper/<udid>/ax`),
 * Android from serve-emu (`/vendor/serve-emu/api/accessibility`). Frames are
 * normalized to the screen, 0..1 on both axes. Ported from T3 Code's
 * `fetchDeviceAxTree`, read through the device channel.
 */
import type { DevicePlatform } from "@threadlines/contracts";

import type { DeviceHubTransport } from "./hubTransport.ts";

export interface DeviceAxElement {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DeviceAxTree {
  readonly elements: ReadonlyArray<DeviceAxElement>;
  readonly errors: ReadonlyArray<string>;
}

const AX_ELEMENT_LIMIT = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** serve-sim's tree: nested nodes with `frame` in points, the first root covering the screen. */
export function flattenIosAxTree(roots: ReadonlyArray<unknown>): ReadonlyArray<DeviceAxElement> {
  const first = roots[0];
  const rootFrame = isRecord(first) && isRecord(first.frame) ? first.frame : null;
  const screenWidth = Math.max(1, numberOr(rootFrame?.width, 1));
  const screenHeight = Math.max(1, numberOr(rootFrame?.height, 1));
  const elements: DeviceAxElement[] = [];
  const visit = (node: unknown, path: string) => {
    if (elements.length >= AX_ELEMENT_LIMIT || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    const width = numberOr(frame.width, 0);
    const height = numberOr(frame.height, 0);
    const coversScreen =
      Math.abs(width - screenWidth) < 0.5 && Math.abs(height - screenHeight) < 0.5;
    if (!coversScreen && width > 0 && height > 0) {
      elements.push({
        id: typeof node.AXUniqueId === "string" ? node.AXUniqueId : path,
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

/** serve-emu's list: flat nodes with `bounds` in pixels, the first one the screen. */
export function flattenAndroidAxTree(
  nodes: ReadonlyArray<unknown>,
): ReadonlyArray<DeviceAxElement> {
  const framed = nodes.filter(
    (node): node is Record<string, unknown> => isRecord(node) && isRecord(node.bounds),
  );
  const root = framed[0]?.bounds as Record<string, unknown> | undefined;
  const screenWidth = Math.max(1, numberOr(root?.right, 1));
  const screenHeight = Math.max(1, numberOr(root?.bottom, 1));
  return framed.slice(1, AX_ELEMENT_LIMIT + 1).flatMap((node): DeviceAxElement[] => {
    const bounds = node.bounds as Record<string, unknown>;
    const left = numberOr(bounds.left, 0);
    const top = numberOr(bounds.top, 0);
    const width = (numberOr(bounds.right, left) - left) / screenWidth;
    const height = (numberOr(bounds.bottom, top) - top) / screenHeight;
    const text = typeof node.text === "string" ? node.text : "";
    const description = typeof node.contentDescription === "string" ? node.contentDescription : "";
    const label = text || description;
    if (width >= 0.95 && height >= 0.9) return [];
    if (!label && node.clickable !== true) return [];
    const className = typeof node.className === "string" ? node.className : "";
    return [
      {
        id: String(node.id ?? ""),
        label,
        role: className.split(".").at(-1) ?? "",
        x: left / screenWidth,
        y: top / screenHeight,
        width,
        height,
      },
    ];
  });
}

/** The tree on screen now. Errors come back in `errors`; a failed request throws. */
export async function fetchDeviceAxTree(
  transport: DeviceHubTransport,
  target: { readonly platform: DevicePlatform; readonly deviceId: string },
  signal?: AbortSignal,
): Promise<DeviceAxTree> {
  const device = encodeURIComponent(target.deviceId);
  const response = await transport.fetch(
    target.platform === "ios"
      ? `/vendor/serve-sim/helper/${device}/ax`
      : `/vendor/serve-emu/api/accessibility?device=${device}`,
    signal ? { signal } : {},
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The accessibility tree answered with status ${response.status}.`);
  }
  const payload: unknown = await response.json();
  const errorOf = (value: unknown) =>
    isRecord(value) && typeof value.error === "string" ? value.error : null;
  if (target.platform === "ios") {
    return Array.isArray(payload)
      ? { elements: flattenIosAxTree(payload), errors: [] }
      : { elements: [], errors: [errorOf(payload) ?? "Unexpected accessibility payload."] };
  }
  return isRecord(payload) && Array.isArray(payload.nodes)
    ? { elements: flattenAndroidAxTree(payload.nodes), errors: [] }
    : { elements: [], errors: [errorOf(payload) ?? "Unexpected accessibility payload."] };
}
