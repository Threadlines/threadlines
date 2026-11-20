// @effect-diagnostics globalTimers:off - This browser transport runs without an Effect runtime, like the live stream.
import type { DevicePlatform } from "@threadlines/contracts";

import type { DeviceHubTransport } from "./hubTransport.ts";
import { extractPng } from "./png.ts";
import { deviceHubPaths } from "./stream.ts";

const SCREENSHOT_TIMEOUT_MS = 20_000;

/** A PNG of the device's screen, through the hub's screenshot route. */
export async function captureDeviceScreenshot(
  transport: DeviceHubTransport,
  target: { readonly platform: DevicePlatform; readonly deviceId: string },
): Promise<Blob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCREENSHOT_TIMEOUT_MS);
  try {
    const response = await transport.fetch(
      deviceHubPaths.screenshot(target.platform, encodeURIComponent(target.deviceId)),
      { method: "POST", signal: controller.signal },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The screenshot failed (${response.status}). Try again.`);
    }
    const png = extractPng(new Uint8Array(await response.arrayBuffer()));
    if (!png) throw new Error("The device sent an incomplete screenshot. Try again.");
    return new Blob([png as BlobPart], { type: "image/png" });
  } catch (cause) {
    if (controller.signal.aborted)
      throw new Error("The screenshot took too long. Try again.", { cause });
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}
