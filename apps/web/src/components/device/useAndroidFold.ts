// @effect-diagnostics globalTimers:off - A fold command gives up on a plain timer.
import {
  type AndroidFoldPosture,
  type AndroidFoldState,
  type DeviceHubTransport,
  readAndroidFold,
  setAndroidFold,
} from "@threadlines/client-runtime/device";
import { useEffect, useRef, useState } from "react";

import { deviceErrorText } from "./deviceState";

const FOLD_TIMEOUT_MS = 12_000;

export interface AndroidFold {
  /** Null until read, and on an emulator that cannot say. */
  readonly fold: AndroidFoldState | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly change: (posture: AndroidFoldPosture) => void;
}

/**
 * An Android emulator's fold, read while `active` and again whenever its
 * screen changes size (folding resizes it, so the posture may have changed
 * from the emulator's own window too). A change in flight owns the posture.
 */
export function useAndroidFold(input: {
  readonly transport: DeviceHubTransport;
  readonly deviceId: string;
  readonly active: boolean;
  /** Changes when the screen's size does; null before the first frame, when nothing is read. */
  readonly screenKey: string | null;
}): AndroidFold {
  const { transport, deviceId, active, screenKey } = input;
  const [fold, setFold] = useState<AndroidFoldState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!active || pending || screenKey === null) return;
    const controller = new AbortController();
    readAndroidFold(transport, deviceId, controller.signal)
      .then(setFold)
      // A phone without a hinge answers `supported: false`; a failed read just shows no controls.
      .catch(() => {});
    return () => controller.abort();
  }, [transport, deviceId, active, pending, screenKey]);

  const change = (posture: AndroidFoldPosture) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FOLD_TIMEOUT_MS);
    setAndroidFold(transport, deviceId, posture, controller.signal)
      .then(setFold)
      .catch((cause: unknown) =>
        setError(
          controller.signal.aborted ? "The emulator did not fold in time." : deviceErrorText(cause),
        ),
      )
      .finally(() => {
        clearTimeout(timeout);
        busy.current = false;
        setPending(false);
      });
  };
  return { fold, pending, error, change };
}
