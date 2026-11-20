import type { DeviceSummary, EnvironmentId, ThreadId } from "@threadlines/contracts";
import { threadDeviceSessions } from "@threadlines/client-runtime/deviceState";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DevicePicker } from "./DevicePicker";
import { DeviceSetup } from "./DeviceSetup";
import {
  closeDevice,
  deviceErrorText,
  openDevice,
  refreshDevices,
  selectThreadDevice,
  shutdownDevice,
  useDevicesSupported,
  useDeviceState,
  useSelectedThreadDevice,
} from "./deviceState";
import { DeviceWorkspace } from "./DeviceWorkspace";

/**
 * The Device tab (docs/design/devices.md): setup on first use, the device
 * picker, and the open device. Stays mounted while its tab is in the strip;
 * `visible` says whether it is the tab on screen, and only then does a
 * device stream.
 */
export function DevicePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly visible: boolean;
}) {
  const { environmentId, threadId, threadKey, visible } = props;
  const supported = useDevicesSupported(environmentId);
  const state = useDeviceState(environmentId, supported);
  const selectedId = useSelectedThreadDevice(threadKey);
  const [inSetup, setInSetup] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Devices on and nothing started yet: list them, which starts the hub. Once
  // per panel, and only while the tab is on screen.
  const listed = useRef(false);
  const enabled = state?.enabled === true;
  const idle = state?.hostStatus === "idle";
  useEffect(() => {
    if (!visible || !enabled || !idle || listed.current) return;
    listed.current = true;
    refreshDevices(environmentId).catch((cause: unknown) => setError(deviceErrorText(cause)));
  }, [enabled, environmentId, idle, visible]);

  if (!supported) {
    return (
      <PanelMessage>
        This computer runs a Threadlines without devices. Update it to use the Device tab.
      </PanelMessage>
    );
  }
  if (state === null) {
    return <PanelMessage>Loading devices…</PanelMessage>;
  }
  if (!state.enabled || inSetup) {
    return (
      <DeviceSetup
        environmentId={environmentId}
        state={state}
        onStarted={() => setInSetup(true)}
        onDone={() => setInSetup(false)}
      />
    );
  }

  const sessions = threadDeviceSessions(state, threadId);
  const activeSession = sessions.find((session) => session.deviceId === selectedId);
  const activeDevice = activeSession
    ? state.devices.find((device) => device.id === activeSession.deviceId)
    : undefined;

  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(deviceErrorText(cause));
    }
  };

  const open = (device: DeviceSummary) => {
    if (sessions.some((session) => session.deviceId === device.id)) {
      selectThreadDevice(threadKey, device.id);
      return;
    }
    setPending(device.id);
    void run(async () => {
      await openDevice(environmentId, { threadId, deviceId: device.id, platform: device.platform });
      selectThreadDevice(threadKey, device.id);
    }).finally(() => setPending(null));
  };

  const close = (shutdown: boolean) => {
    if (!activeSession) return;
    selectThreadDevice(threadKey, null);
    void run(() =>
      closeDevice(environmentId, { threadId, deviceId: activeSession.deviceId, shutdown }),
    );
  };

  const errorLine = error ? (
    <div
      role="alert"
      className="flex items-start gap-2 px-3 py-1.5 text-xs text-destructive-foreground"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 whitespace-pre-line">{error}</p>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss"
        className="-my-1"
        onClick={() => setError(null)}
      >
        <XIcon />
      </Button>
    </div>
  ) : null;

  if (activeDevice && activeSession) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="device-panel">
        {errorLine}
        <DeviceWorkspace
          key={`${environmentId}\u0000${activeDevice.id}`}
          environmentId={environmentId}
          device={activeDevice}
          visible={visible}
          onBack={() => selectThreadDevice(threadKey, null)}
          onClose={() => close(false)}
          onPowerOff={() => close(true)}
        />
      </div>
    );
  }

  const pendingDevice =
    pending === null ? undefined : state.devices.find((device) => device.id === pending);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="device-panel">
      {errorLine}
      {pendingDevice ? (
        <DeviceLoadingView
          name={pendingDevice.name}
          description={pendingDevice.version}
          message={pendingDevice.booted ? "Opening…" : "Starting… This can take a minute."}
        />
      ) : (
        <DevicePicker
          state={state}
          sessions={sessions}
          pendingDeviceId={pending}
          refreshing={refreshing}
          onOpen={open}
          onPowerOff={(device) =>
            void run(() =>
              shutdownDevice(environmentId, { deviceId: device.id, platform: device.platform }),
            )
          }
          onRefresh={() => {
            setRefreshing(true);
            void run(() => refreshDevices(environmentId)).finally(() => setRefreshing(false));
          }}
        />
      )}
    </div>
  );
}

function PanelMessage(props: { readonly children: string }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{props.children}</p>;
}
