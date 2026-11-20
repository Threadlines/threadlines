import type { DeviceServiceState, DeviceSession, DeviceSummary } from "@threadlines/contracts";
import {
  devicePlatformName,
  groupDevicesByPlatform,
  isDeviceHostBusy,
} from "@threadlines/client-runtime/deviceState";
import { PowerIcon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { SETTINGS_GROUP_ROW_CLASS, SettingsGroup } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { HubStatus } from "./DeviceSetup";

/**
 * The devices on the thread's computer, by platform, booted first. Picking
 * one opens it for the thread (starting it when it is off); a running one
 * can be powered off from its row.
 */
export function DevicePicker(props: {
  readonly state: DeviceServiceState;
  /** This thread's open devices. */
  readonly sessions: ReadonlyArray<DeviceSession>;
  readonly pendingDeviceId: string | null;
  readonly refreshing: boolean;
  readonly onOpen: (device: DeviceSummary) => void;
  readonly onPowerOff: (device: DeviceSummary) => void;
  readonly onRefresh: () => void;
}) {
  const { state } = props;
  const groups = groupDevicesByPlatform(state.devices);
  // Platforms that cannot run, and working ones with a note (Android without Java).
  const unavailable = state.platforms.filter(
    (platform) => !platform.available || platform.reason !== undefined,
  );
  const busy = isDeviceHostBusy(state);
  const booting = state.bootingDevices;
  const heldIds = new Set(props.sessions.map((session) => session.deviceId));
  const startedByUs = new Set(
    state.sessions.filter((session) => session.bootedByThreadlines).map((s) => s.deviceId),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="device-picker">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {state.devices.length === 1 ? "1 device" : `${state.devices.length} devices`}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh devices"
          tooltip="Refresh devices"
          disabled={props.refreshing || busy}
          onClick={props.onRefresh}
        >
          {props.refreshing ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {state.hostStatus !== "ready" && state.hostStatus !== "idle" ? (
          <SettingsGroup>
            <HubStatus state={state} />
          </SettingsGroup>
        ) : null}
        {booting.length > 0 ? (
          <p role="status" className="px-1 text-xs text-muted-foreground">
            Starting {booting.map((device) => device.name).join(", ")}. This can take a minute.
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.platform} className="space-y-1.5">
            <h3 className="px-1 text-[12px] font-medium text-muted-foreground">
              {group.platform === "ios" ? "iOS Simulators" : "Android Emulators"}
            </h3>
            <SettingsGroup>
              {group.devices.map((device) => {
                const held = heldIds.has(device.id);
                const pending = props.pendingDeviceId === device.id;
                return (
                  <div
                    key={device.id}
                    className={cn(SETTINGS_GROUP_ROW_CLASS, "group/device-row flex items-center")}
                  >
                    <button
                      type="button"
                      data-testid={`device-row-${device.id}`}
                      disabled={props.pendingDeviceId !== null}
                      aria-label={`${held || device.booted ? "Open" : "Start"} ${device.name}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-3.5 py-2 text-left outline-none focus-ring hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
                      onClick={() => props.onOpen(device)}
                    >
                      <SmartphoneIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] leading-[19px]">
                          {device.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          <span className="font-mono">{device.version}</span>
                          {" · "}
                          {held
                            ? "Open in this thread"
                            : device.booted
                              ? startedByUs.has(device.id)
                                ? "Running, started by Threadlines"
                                : "Running"
                              : "Off"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {pending ? (
                          <Spinner className="size-3.5" />
                        ) : held || device.booted ? (
                          "Open"
                        ) : (
                          "Start"
                        )}
                      </span>
                    </button>
                    {device.booted ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="mr-2 opacity-0 group-hover/device-row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                        aria-label={`Power off ${device.name}`}
                        tooltip="Power off"
                        onClick={() => props.onPowerOff(device)}
                      >
                        <PowerIcon />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </SettingsGroup>
          </section>
        ))}
        {groups.length === 0 && state.hostStatus === "ready" ? (
          <p className="px-1 text-xs text-muted-foreground">
            No simulators or emulators on this computer yet.
          </p>
        ) : null}
        {unavailable.length > 0 ? (
          <div className="space-y-1 px-1">
            {unavailable.map((platform) => (
              <p key={platform.platform} className="text-xs text-muted-foreground">
                {devicePlatformName(platform.platform)}:{" "}
                {platform.reason ??
                  (platform.platform === "ios"
                    ? "needs a Mac with Xcode."
                    : "needs the Android SDK with the emulator.")}
              </p>
            ))}
          </div>
        ) : null}
        {state.incompletePlatforms.length > 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            The {state.incompletePlatforms.map(devicePlatformName).join(" and ")} list may be
            missing devices. Refresh to try again.
          </p>
        ) : null}
      </div>
    </div>
  );
}
