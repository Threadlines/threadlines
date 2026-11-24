import type { DevicePlatform, DeviceServiceState, EnvironmentId } from "@threadlines/contracts";
import {
  devicePlatformName,
  devicePlatformStatus,
  deviceToolInstallMessage,
  isDeviceHostBusy,
} from "@threadlines/client-runtime/deviceState";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { SETTINGS_GROUP_ROW_CLASS, SettingsGroup } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { deviceErrorText, refreshDevices, updateDeviceSettings } from "./deviceState";

/**
 * The Device tab's first open: what each step installs, before anything is.
 * Opening the tab downloads nothing; turning on "Use devices" lets the
 * computer install the device hub when devices are first listed, and agent
 * access installs agent-device.
 */
export function DeviceSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  /** Setup has started; the panel keeps showing it until Done. */
  readonly onStarted: () => void;
  readonly onDone: () => void;
}) {
  const { environmentId, state } = props;
  const [pending, setPending] = useState<"enable" | "agent" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = isDeviceHostBusy(state);
  const hubVersion = state.tools?.hub.requiredVersion;
  const agentVersion = state.tools?.agent.requiredVersion;

  const run = async (kind: NonNullable<typeof pending>, work: () => Promise<void>) => {
    setPending(kind);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(deviceErrorText(cause));
    } finally {
      setPending(null);
    }
  };

  const enable = (on: boolean) =>
    run("enable", async () => {
      if (on) props.onStarted();
      await updateDeviceSettings(
        environmentId,
        on ? { enableDevices: true } : { enableDevices: false, agentDeviceAccess: false },
      );
      // The listing is what starts the hub, installing it the first time.
      if (on) await refreshDevices(environmentId);
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="device-setup">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-3 py-4">
        <div className="space-y-1 px-1">
          <h2 className="text-[15px] leading-5 font-semibold">Set up devices</h2>
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">
            See and use iOS Simulators and Android Emulators on this computer. Nothing is installed
            until you turn it on.
          </p>
        </div>

        <Step number={1} title="Use devices">
          <div className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-start gap-3 px-3.5 py-2.5")}>
            <p className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-muted-foreground">
              Installs the device hub
              {hubVersion ? (
                <>
                  {" "}
                  (<span className="font-mono">expo-device-hub {hubVersion}</span>)
                </>
              ) : null}{" "}
              on this computer. It shows each simulator's screen here and passes your taps and
              typing to it.
            </p>
            <Switch
              aria-label="Use devices"
              checked={state.enabled}
              disabled={pending !== null}
              onCheckedChange={(checked) => void enable(Boolean(checked))}
            />
          </div>
          <HubStatus state={state} />
        </Step>

        <Step number={2} title="Simulators" dimmed={!state.enabled}>
          <PlatformRow platform="ios" state={state} />
          <PlatformRow platform="android" state={state} />
          <div className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-center gap-3 px-3.5 py-2")}>
            <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
              Either platform is enough.
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={!state.enabled || busy || pending !== null}
              onClick={() => void run("check", () => refreshDevices(environmentId))}
            >
              {pending === "check" ? <Spinner className="size-3.5" /> : null}
              Check again
            </Button>
          </div>
        </Step>

        <Step number={3} title="Agent access" dimmed={!state.enabled}>
          <div className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-start gap-3 px-3.5 py-2.5")}>
            <p className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-muted-foreground">
              Agents can open, tap through and screenshot devices too. Installs{" "}
              <span className="font-mono">
                agent-device{agentVersion ? ` ${agentVersion}` : ""}
              </span>{" "}
              and applies to agent sessions started after you turn it on.
            </p>
            <Switch
              aria-label="Agents can use devices"
              checked={state.agentAccessEnabled}
              disabled={!state.enabled || pending !== null}
              onCheckedChange={(checked) =>
                void run("agent", () =>
                  updateDeviceSettings(environmentId, { agentDeviceAccess: Boolean(checked) }),
                )
              }
            />
          </div>
        </Step>

        {error ? (
          <p role="alert" className="px-1 text-xs whitespace-pre-line text-destructive-foreground">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end px-1">
          <Button size="sm" disabled={!state.enabled || pending !== null} onClick={props.onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function Step(props: {
  readonly number: number;
  readonly title: string;
  readonly dimmed?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={props.title}>
      <h3
        className={cn(
          "px-1 text-[13px] font-medium",
          props.dimmed ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <span className="font-mono text-muted-foreground">{props.number}</span> {props.title}
      </h3>
      <SettingsGroup>{props.children}</SettingsGroup>
    </section>
  );
}

/** Where the device hub stands, while it installs or starts, or once it failed. */
export function HubStatus(props: { readonly state: DeviceServiceState }) {
  const { state } = props;
  if (!state.enabled) return null;
  const line =
    state.hostStatus === "installing"
      ? (state.hostStatusDetail ?? deviceToolInstallMessage("expo-device-hub", state.tools?.hub))
      : state.hostStatus === "starting"
        ? "Starting the device hub…"
        : state.hostStatus === "failed"
          ? (state.hostStatusDetail ?? "The device hub could not start.")
          : state.hostStatus === "ready"
            ? "The device hub is running."
            : null;
  if (line === null) return null;
  const failed = state.hostStatus === "failed";
  return (
    <div
      role={failed ? "alert" : "status"}
      className={cn(
        SETTINGS_GROUP_ROW_CLASS,
        "flex items-start gap-2 px-3.5 py-2 text-[12.5px] leading-[18px]",
        failed ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {failed ? (
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      ) : state.hostStatus === "ready" ? (
        <CheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : (
        <Spinner className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 whitespace-pre-line">{line}</span>
    </div>
  );
}

function PlatformRow(props: {
  readonly platform: DevicePlatform;
  readonly state: DeviceServiceState;
}) {
  const availability = props.state.platforms.find(
    (candidate) => candidate.platform === props.platform,
  );
  // A missing platform is known as soon as the computer has looked; a working
  // one only once the hub has listed its devices.
  const known =
    props.state.enabled &&
    (props.state.hostStatus === "ready" || availability?.available === false);
  const status = devicePlatformStatus(props.state, props.platform);
  return (
    <div className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-start gap-2 px-3.5 py-2")}>
      {known && status.ready ? (
        <CheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : (
        <CircleAlertIcon
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{devicePlatformName(props.platform)}</p>
        <p className="text-[12.5px] leading-[18px] text-muted-foreground">
          {known ? status.message : "Checked once devices are on."}
        </p>
      </div>
    </div>
  );
}
