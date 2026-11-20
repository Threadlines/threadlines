// @effect-diagnostics globalTimers:off - Browser transport code, run without an Effect runtime.
import type { DeviceForegroundApp } from "@threadlines/contracts";

import type { DeviceHubTransport } from "./hubTransport.ts";

/** How often the open Tools drawer asks which app is in front. */
export const FOREGROUND_POLL_MS = 2_000;

/**
 * The app in front on an iOS Simulator, as it changes, while the caller
 * listens. `simctl` has no way to ask, so this asks the device's serve-sim
 * helper (`/vendor/serve-sim/helper/<udid>/foreground`, JSON with
 * `bundleId`), which exists while the device's screen is streaming. Calls
 * `onChange` with the app, `null` for the home screen, and `undefined` when
 * the helper could not answer (the caller keeps whatever else it knows).
 * Repeats every FOREGROUND_POLL_MS until the returned stop.
 */
export function subscribeDeviceForeground(
  transport: DeviceHubTransport,
  deviceId: string,
  onChange: (app: DeviceForegroundApp | null | undefined) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: string | undefined;

  const report = (app: DeviceForegroundApp | null | undefined) => {
    const key = app === undefined ? "?" : app === null ? "" : app.id;
    if (key === last) return;
    last = key;
    onChange(app);
  };

  const ask = async () => {
    controller = new AbortController();
    try {
      const response = await transport.fetch(
        `/vendor/serve-sim/helper/${encodeURIComponent(deviceId)}/foreground`,
        { signal: controller.signal },
      );
      report(response.ok ? parseForeground(await response.json()) : undefined);
    } catch {
      if (!stopped) report(undefined);
    }
    if (!stopped) timer = setTimeout(() => void ask(), FOREGROUND_POLL_MS);
  };

  void ask();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    controller?.abort();
  };
}

/** The helper's answer: the app, `null` for the home screen, `undefined` for anything else. */
export function parseForeground(body: unknown): DeviceForegroundApp | null | undefined {
  if (typeof body !== "object" || body === null || !("bundleId" in body)) return undefined;
  const bundleId = (body as { readonly bundleId: unknown }).bundleId;
  if (bundleId === null || bundleId === "") return null;
  return typeof bundleId === "string" ? { id: bundleId } : undefined;
}
