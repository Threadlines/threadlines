import type { DeviceSummary, EnvironmentId, ThreadId } from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { threadDeviceSessions } from "@threadlines/client-runtime/deviceState";
import { CircleAlertIcon, DownloadIcon, PictureInPicture2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { Button } from "../ui/button";
import { DeviceChips } from "./DeviceChips";
import { useFloatingDevice } from "./DeviceFloatingWindow";
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
} from "./deviceState";
import { dismissKeptDeviceRecording, useKeptDeviceRecordings } from "./deviceRecordingHandoff";
import {
  dockDeviceFloat,
  floatDevice,
  orderDeviceChips,
  removeDeviceChip,
  renameDeviceChip,
  useThreadDeviceViews,
} from "./deviceViewStore";
import { DeviceWorkspace } from "./DeviceWorkspace";

/**
 * The Device tab (docs/design/devices.md): setup on first use, the device
 * picker, and the thread's open devices as chips above the one shown. Stays
 * mounted while its tab is in the strip; `visible` says whether it is the
 * tab on screen, and only then does the shown device stream. Hidden chips
 * hold no channel, and a device floating over the chat streams there instead.
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
  const views = useThreadDeviceViews(threadKey);
  const selectedId = views.selected;
  const float = useFloatingDevice(threadKey);
  // The phone layout has no room to float a device over the chat.
  const phoneLayout = useIsMobile();
  const kept = useKeptDeviceRecordings((recordings) => recordings[threadKey]);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
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
  const chips = orderDeviceChips(views, sessions).flatMap((session) => {
    const device = state.devices.find((entry) => entry.id === session.deviceId);
    return device
      ? [
          {
            deviceId: device.id,
            name: views.names[device.id] ?? device.name,
            deviceName: device.name,
            floating: float?.deviceId === device.id,
          },
        ]
      : [];
  });
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

  const close = (deviceId: string, shutdown: boolean) => {
    removeDeviceChip(threadKey, deviceId, sessions);
    void run(() => closeDevice(environmentId, { threadId, deviceId, shutdown }));
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

  const chipRow =
    chips.length > 0 ? (
      <DeviceChips
        chips={chips}
        selectedId={activeSession ? activeSession.deviceId : null}
        onSelect={(deviceId) => selectThreadDevice(threadKey, deviceId)}
        onRename={(deviceId, name) => renameDeviceChip(threadKey, deviceId, name)}
        onClose={(deviceId) => close(deviceId, false)}
      />
    ) : null;

  // One line per recording kept for download, oldest first.
  const keptLine = kept?.map((entry) => {
    const only = entry.files.length === 1 ? entry.files[0] : undefined;
    const label = only ? only.fileName : `${entry.files.length} files`;
    return (
      <div
        key={entry.id}
        role="status"
        className="flex h-8 shrink-0 items-center gap-1.5 pr-1.5 pl-3 text-xs"
      >
        <p className="min-w-0 flex-1 truncate text-muted-foreground" title={entry.message}>
          {entry.message}
        </p>
        {only ? (
          <Button
            size="xs"
            variant="outline"
            tooltip={only.fileName}
            render={<a href={only.url} download={only.fileName} />}
          >
            <DownloadIcon />
            Download
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            tooltip={entry.files.map((file) => file.fileName).join(", ")}
            onClick={() => downloadKeptFiles(entry.files)}
          >
            <DownloadIcon />
            Download {entry.files.length}
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Dismiss ${label}`}
          onClick={() => dismissKeptDeviceRecording(threadKey, entry.id)}
        >
          <XIcon />
        </Button>
      </div>
    );
  });

  if (activeDevice && activeSession) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="device-panel">
        {errorLine}
        {keptLine}
        {chipRow}
        {float?.deviceId === activeDevice.id ? (
          <FloatingPlaceholder
            name={views.names[activeDevice.id] ?? activeDevice.name}
            onDock={() => dockDeviceFloat(threadKey)}
          />
        ) : (
          <DeviceWorkspace
            key={`${environmentId}\u0000${activeDevice.id}`}
            environmentId={environmentId}
            device={activeDevice}
            visible={visible}
            threadRef={threadRef}
            threadKey={threadKey}
            onBack={() => selectThreadDevice(threadKey, null)}
            onClose={() => close(activeDevice.id, false)}
            onPowerOff={() => close(activeDevice.id, true)}
            {...(phoneLayout ? {} : { onFloat: () => floatDevice(threadKey, activeDevice.id) })}
          />
        )}
      </div>
    );
  }

  const pendingDevice =
    pending === null ? undefined : state.devices.find((device) => device.id === pending);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="device-panel">
      {errorLine}
      {keptLine}
      {chipRow}
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

/** Downloads each kept file, one link click apiece (no archive format is bundled). */
function downloadKeptFiles(
  files: ReadonlyArray<{ readonly fileName: string; readonly url: string }>,
) {
  for (const file of files) {
    const link = document.createElement("a");
    link.href = file.url;
    link.download = file.fileName;
    document.body.append(link);
    link.click();
    link.remove();
  }
}

/** What the tab shows for a chip whose device floats over the chat. */
function FloatingPlaceholder(props: { readonly name: string; readonly onDock: () => void }) {
  return (
    <div
      data-testid="device-floating-placeholder"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <PictureInPicture2Icon aria-hidden="true" className="size-5 text-muted-foreground" />
      <p className="text-[13px] text-muted-foreground">{props.name} is floating over the chat.</p>
      <Button size="sm" variant="outline" onClick={props.onDock}>
        Show it here
      </Button>
    </div>
  );
}

function PanelMessage(props: { readonly children: string }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{props.children}</p>;
}
