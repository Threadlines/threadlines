import type {
  DeviceActionInput,
  DeviceDetail,
  DeviceSummary,
  EnvironmentId,
} from "@threadlines/contracts";
import { useEffect, useRef, useState } from "react";

import { deviceErrorText, readDeviceDetail, runDeviceAction } from "./deviceState";

type ActionBody = DeviceActionInput extends infer A
  ? A extends { readonly type: string }
    ? Omit<A, "deviceId">
    : never
  : never;

/**
 * The Tools drawer's values and actions for one device. Reads the values when
 * it becomes visible; every action answers with the values read back, so the
 * drawer only ever shows what the device says. Actions run one at a time.
 * Mount it keyed by device.
 */
export function useDeviceControls(input: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceSummary;
  readonly visible: boolean;
}) {
  const { environmentId, device, visible } = input;
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Hiding does not cancel a command on the device, so actions stay one at a
  // time until each settles rather than letting a reopened drawer race it.
  const busy = useRef(false);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    readDeviceDetail(environmentId, device.id).then(
      (read) => {
        if (!current) return;
        setDetail(read);
        setError(null);
      },
      (cause: unknown) => {
        if (current) setError(deviceErrorText(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [device.id, environmentId, visible]);

  const act = async (body: ActionBody): Promise<boolean> => {
    if (busy.current || detail === null || !visible) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      setDetail(
        await runDeviceAction(environmentId, { ...body, deviceId: device.id } as DeviceActionInput),
      );
      return true;
    } catch (cause) {
      setError(deviceErrorText(cause));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return {
    detail,
    pending,
    error,
    act,
    disabled: pending || detail === null || !visible,
    foregroundApp: detail?.foregroundApp ?? null,
  };
}

export type DeviceControls = ReturnType<typeof useDeviceControls>;
