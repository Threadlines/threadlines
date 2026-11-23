// @effect-diagnostics globalTimers:off - Browser transport code, run without an Effect runtime.
import type { DeviceForegroundApp } from "@threadlines/contracts";

import type { DeviceHubTransport } from "./hubTransport.ts";

/** How often the open Tools drawer asks which app is in front. */
export const FOREGROUND_POLL_MS = 2_000;
const FOREGROUND_TIMEOUT_MS = 5_000;
const UNKNOWN_APP = Symbol("unknown");

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
  let last: string | null | typeof UNKNOWN_APP | undefined;

  const report = (app: DeviceForegroundApp | null | undefined) => {
    if (stopped) return;
    const key = app === undefined ? UNKNOWN_APP : app === null ? null : app.id;
    if (key === last) return;
    last = key;
    onChange(app);
  };

  const ask = async () => {
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), FOREGROUND_TIMEOUT_MS);
    try {
      const response = await transport.fetch(
        `/vendor/serve-sim/helper/${encodeURIComponent(deviceId)}/foreground`,
        { signal: request.signal },
      );
      if (stopped) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        report(undefined);
      } else {
        const body: unknown = await response.json();
        report(parseForeground(body));
      }
    } catch {
      report(undefined);
    } finally {
      clearTimeout(timeout);
      if (controller === request) controller = null;
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
