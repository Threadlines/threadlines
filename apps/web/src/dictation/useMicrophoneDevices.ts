/**
 * The input devices offered in the composer's dictation menu.
 *
 * Only enumerated while the menu is open: `enumerateDevices` is cheap but the
 * `devicechange` listener is not free, and a closed menu has nothing to show.
 * Labels stay empty until the user has granted microphone access at least
 * once, so unnamed devices fall back to a stable position-based name, and
 * devices with no id yet (the same pre-permission state) are left out.
 *
 * @module useMicrophoneDevices
 */
import { useEffect, useState } from "react";

export interface MicrophoneDevice {
  readonly deviceId: string;
  readonly label: string;
}

export function useMicrophoneDevices(enabled: boolean): ReadonlyArray<MicrophoneDevice> {
  const [devices, setDevices] = useState<ReadonlyArray<MicrophoneDevice>>([]);

  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    let cancelled = false;

    const refresh = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (cancelled) {
            return;
          }
          // Before the first permission grant, browsers report inputs with an
          // empty id; those cannot be selected and would collide with the
          // "Default" entry, so only named-by-id devices are listed.
          setDevices(
            all
              .filter((device) => device.kind === "audioinput" && device.deviceId !== "")
              .map((device, index) => ({
                deviceId: device.deviceId,
                label: device.label.trim() || `Microphone ${index + 1}`,
              })),
          );
        })
        .catch(() => {
          if (!cancelled) {
            setDevices([]);
          }
        });
    };

    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [enabled]);

  return devices;
}
