// @effect-diagnostics globalTimers:off - The overlay polls on a plain timer while it is shown.
import type { DevicePlatform } from "@threadlines/contracts";
import {
  type DeviceAxElement,
  type DeviceHubTransport,
  readDeviceAxElements,
} from "@threadlines/client-runtime/device";
import { useEffect, useState } from "react";

import { deviceErrorText } from "./deviceState";

/** Read again this often while the overlay shows: screens change under it. */
const AX_POLL_INTERVAL_MS = 2_000;

export interface DeviceAccessibility {
  readonly elements: ReadonlyArray<DeviceAxElement>;
  /** Why the last read failed; the last elements read stay meanwhile. */
  readonly error: string | null;
}

const EMPTY: DeviceAccessibility = { elements: [], error: null };

/**
 * The accessibility elements on a device's screen while `enabled`, read one
 * request at a time every two seconds. Turning it off cancels the read and
 * forgets what was read.
 */
export function useDeviceAccessibility(input: {
  readonly transport: DeviceHubTransport;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly enabled: boolean;
}): DeviceAccessibility {
  const { transport, platform, deviceId, enabled } = input;
  const [result, setResult] = useState<DeviceAccessibility>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      readDeviceAxElements(transport, { platform, deviceId }, controller.signal)
        .then((elements) => {
          if (!controller.signal.aborted) setResult({ elements, error: null });
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setResult((current) => ({ ...current, error: deviceErrorText(cause) }));
        })
        .finally(() => {
          if (!controller.signal.aborted) timer = setTimeout(read, AX_POLL_INTERVAL_MS);
        });
    };
    read();
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      setResult(EMPTY);
    };
  }, [transport, platform, deviceId, enabled]);
  return result;
}
