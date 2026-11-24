import type {
  DeviceActionInput,
  DeviceDetail,
  DeviceForegroundApp,
  DeviceSummary,
  EnvironmentId,
} from "@threadlines/contracts";
import {
  createDeviceHubTransport,
  subscribeDeviceForeground,
} from "@threadlines/client-runtime/device";
import { useEffect, useRef, useState } from "react";

import {
  deviceChannelApi,
  deviceErrorText,
  readDeviceDetail,
  runDeviceAction,
} from "./deviceState";

type ActionBody = DeviceActionInput extends infer A
  ? A extends { readonly type: string }
    ? Omit<A, "deviceId">
    : never
  : never;

/**
 * The Tools drawer's values and actions for one device. Reads the values when
 * it becomes visible; every action answers with the values read back, so the
 * drawer only ever shows what the device says. Actions run one at a time.
 * On iOS the app in front comes from the device's serve-sim helper, asked
 * every two seconds while the drawer is open (`simctl` cannot report it). Mount it keyed by device.
 */
export function useDeviceControls(input: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceSummary;
  readonly visible: boolean;
  /** Poll iOS `/foreground` only while Tools or a recording needs it. */
  readonly pollForeground?: boolean;
}) {
  const { environmentId, device, visible, pollForeground = visible } = input;
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Hiding does not cancel a command on the device, so actions stay one at a
  // time until each settles rather than letting a reopened drawer race it.
  const busy = useRef(false);
  // undefined: no live reading (Android, or the stream failed); then the detail's answer stands.
  const [liveForeground, setLiveForeground] = useState<DeviceForegroundApp | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!visible || !pollForeground || device.platform !== "ios") return;
    const transport = createDeviceHubTransport(deviceChannelApi(environmentId));
    const stop = subscribeDeviceForeground(transport, device.id, setLiveForeground);
    return () => {
      stop();
      setLiveForeground(undefined);
    };
  }, [device.id, device.platform, environmentId, pollForeground, visible]);

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
    foregroundApp: liveForeground === undefined ? (detail?.foregroundApp ?? null) : liveForeground,
  };
}

export type DeviceControls = ReturnType<typeof useDeviceControls>;
