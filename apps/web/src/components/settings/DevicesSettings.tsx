import type {
  DevicePlatform,
  DeviceServiceState,
  DeviceToolName,
  DeviceToolVersion,
  EnvironmentId,
} from "@threadlines/contracts";
import {
  devicePlatformName,
  devicePlatformStatus,
  deviceToolInstallMessage,
  deviceToolNeedsUpdate,
  deviceToolShownVersion,
} from "@threadlines/client-runtime/deviceState";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  deviceErrorText,
  updateDeviceTool,
  useDevicesSupported,
  useDeviceState,
} from "../device/deviceState";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  SettingsGroup,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsPlaceShown } from "./settingsPlaceAvailability";

/** The two tools Threadlines installs for devices, as the Device tools section lists them. */
const DEVICE_TOOLS: ReadonlyArray<{
  readonly tool: DeviceToolName;
  readonly title: string;
  /** The package's own name, as install lines say it. */
  readonly packageName: string;
  readonly description: string;
}> = [
  {
    tool: "hub",
    title: "Device hub",
    packageName: "expo-device-hub",
    description: "expo-device-hub streams a device's screen and takes your taps and typing.",
  },
  {
    tool: "agent",
    title: "agent-device",
    packageName: "agent-device",
    description:
      "The command line agents drive devices with. It installs once agents can use devices.",
  },
];

const PLATFORMS: ReadonlyArray<DevicePlatform> = ["ios", "android"];

/**
 * Settings › Devices: whether the Device tab shows this computer's iOS
 * Simulators and Android Emulators, whether agents can use them, and the
 * versions of the tools Threadlines installs for them (docs/design/devices.md).
 * Always the app's own computer.
 */
export function DevicesSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const supported = useDevicesSupported(environmentId);
  const shown = useSettingsPlaceShown();
  const state = useDeviceState(environmentId, supported);
  const settingOn = useSettings((settings) => settings.enableDevices);
  // One answer for the whole page: the computer's device state once it has
  // said, the setting until then.
  const enabled = state?.enabled ?? settingOn;

  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/devices" />
      {shown("devices.simulators") ? (
        <>
          <SettingsSection place="devices.simulators">
            <UseDevicesRow />
            <AgentDeviceAccessRow />
            {state !== null && enabled
              ? PLATFORMS.map((platform) => (
                  <PlatformStatusRow key={platform} state={state} platform={platform} />
                ))
              : null}
          </SettingsSection>
          <SettingsSection
            place="devices.tools"
            description={
              enabled && state?.toolInspectionError ? state.toolInspectionError : undefined
            }
          >
            {enabled ? (
              DEVICE_TOOLS.map((entry) => (
                <DeviceToolRow
                  key={entry.tool}
                  entry={entry}
                  environmentId={environmentId}
                  state={state}
                />
              ))
            ) : (
              <p className="px-3.5 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground">
                Nothing is installed until Use devices is on.
              </p>
            )}
          </SettingsSection>
        </>
      ) : (
        <SettingsGroup>
          <p className="px-3.5 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground">
            This computer's Threadlines doesn't have devices yet. Update it to use them.
          </p>
        </SettingsGroup>
      )}
    </SettingsPageContainer>
  );
}

export function UseDevicesRow() {
  const on = useSettings((settings) => settings.enableDevices);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="devices.enable"
      control={
        <Switch
          checked={on}
          // Agent access needs devices, so turning devices off turns it off too.
          onCheckedChange={(checked) =>
            updateSettings(
              checked
                ? { enableDevices: true }
                : { enableDevices: false, agentDeviceAccess: false },
            )
          }
          aria-label="Use devices"
        />
      }
    />
  );
}

export function AgentDeviceAccessRow() {
  const devicesOn = useSettings((settings) => settings.enableDevices);
  const on = useSettings((settings) => settings.agentDeviceAccess);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="devices.agentAccess"
      control={
        <Switch
          checked={devicesOn && on}
          disabled={!devicesOn}
          onCheckedChange={(checked) => updateSettings({ agentDeviceAccess: Boolean(checked) })}
          aria-label="Agents can use devices"
        />
      }
    />
  );
}

/** One platform and whether it works here, in the words the Device tab uses. */
function PlatformStatusRow({
  state,
  platform,
}: {
  readonly state: DeviceServiceState;
  readonly platform: DevicePlatform;
}) {
  const status = devicePlatformStatus(state, platform);
  return <SettingsRow title={devicePlatformName(platform)} description={status.message} />;
}

/** A tool's version line: what is on disk, and the version Threadlines needs when that differs. */
function ToolVersionLine({ tool }: { readonly tool: DeviceToolVersion | undefined }) {
  const shownVersion = deviceToolShownVersion(tool);
  if (shownVersion === null) {
    return tool === undefined ? (
      <>Not installed</>
    ) : (
      <>
        Not installed · Uses <span className="font-mono">{tool.requiredVersion}</span>
      </>
    );
  }
  return (
    <>
      Installed <span className="font-mono">{shownVersion}</span>
      {tool !== undefined && shownVersion !== tool.requiredVersion ? (
        <>
          {" "}
          · Needs <span className="font-mono">{tool.requiredVersion}</span>
        </>
      ) : null}
    </>
  );
}

function DeviceToolRow({
  entry,
  environmentId,
  state,
}: {
  readonly entry: (typeof DEVICE_TOOLS)[number];
  readonly environmentId: EnvironmentId | null;
  readonly state: DeviceServiceState | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tool = state?.tools?.[entry.tool];
  // The server says only that the host installs; a tool installs then when its version isn't on disk yet.
  const installing =
    state?.hostStatus === "installing" &&
    (entry.tool === "hub" || state.agentAccessEnabled) &&
    (tool === undefined || !tool.installedVersions.includes(tool.requiredVersion));
  const hostFailure =
    entry.tool === "hub" && state?.hostStatus === "failed" ? state.hostStatusDetail : undefined;

  const update = () => {
    if (environmentId === null) return;
    setPending(true);
    setError(null);
    updateDeviceTool(environmentId, entry.tool)
      .catch((cause: unknown) => setError(deviceErrorText(cause)))
      .finally(() => setPending(false));
  };

  return (
    <SettingsRow
      title={entry.title}
      description={entry.description}
      status={
        <div className="space-y-0.5">
          <div>
            {installing ? (
              deviceToolInstallMessage(entry.packageName, tool)
            ) : (
              <ToolVersionLine tool={tool} />
            )}
          </div>
          {hostFailure !== undefined ? (
            <div className="text-destructive-foreground">{hostFailure}</div>
          ) : null}
          {error !== null ? (
            <div className="text-destructive-foreground" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      }
      control={
        deviceToolNeedsUpdate(tool) || pending ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending || installing || environmentId === null}
            onClick={update}
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            Update
          </Button>
        ) : null
      }
    />
  );
}
