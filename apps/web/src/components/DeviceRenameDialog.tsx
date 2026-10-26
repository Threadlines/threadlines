/**
 * Renaming a computer, or a phone, tablet or browser using this one.
 *
 * A computer's name lives on that computer (its `computerName` setting), so
 * every device and linked computer sees the same one; it is saved through
 * this app's connection to it. A device's name lives on the computer it uses
 * (its sign-in there), saved through this computer's own server. Either way
 * an empty name goes back to the default: the name the computer's system
 * gives it, or what the device called itself.
 *
 * Every entry point asks through openComputerRenameDialog or
 * openDeviceRenameDialog; the host mounted once at the root shows it.
 */
import {
  type AuthSessionId,
  DEVICE_NAME_MAX_LENGTH,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
} from "@threadlines/contracts";
import { create } from "zustand";

import { readEnvironmentApi, useEnvironmentApiAvailable } from "../environmentApi";
import { renameServerClientSession } from "../environments/primary";
import {
  readEnvironmentConnection,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useServerConfig } from "../rpc/serverState";
import { RenameDialogForm } from "./RenameDialogForm";
import { Dialog } from "./ui/dialog";

/** A computer that can be renamed from here right now, as the dialog needs it. */
export interface ComputerNaming {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The name its system gives it, which an empty name goes back to. */
  readonly systemLabel: string;
  readonly os: ExecutionEnvironmentPlatformOs;
}

type DeviceRenameRequest =
  | ({ readonly id: number; readonly kind: "computer" } & ComputerNaming)
  | {
      readonly id: number;
      readonly kind: "device";
      readonly sessionId: AuthSessionId;
      /** How the list shows it, which can add when it paired. */
      readonly shownAs: string;
      /** Its name now. */
      readonly label: string;
      /** What it called itself, which an empty name goes back to. */
      readonly deviceLabel: string;
    };

type DeviceRenameAsk =
  | ({ readonly kind: "computer" } & ComputerNaming)
  | Omit<Extract<DeviceRenameRequest, { kind: "device" }>, "id">;

const useDeviceRenameDialogStore = create<{ request: DeviceRenameRequest | null }>(() => ({
  request: null,
}));

/** Never reused, so a save that lands late can't close a later ask. */
let lastRequestId = 0;

function open(ask: DeviceRenameAsk): void {
  lastRequestId += 1;
  useDeviceRenameDialogStore.setState({
    request: { ...ask, id: lastRequestId } as DeviceRenameRequest,
  });
}

/** Opens the rename dialog for a computer, as useComputerNaming describes it. */
export function openComputerRenameDialog(computer: ComputerNaming): void {
  open({ kind: "computer", ...computer });
}

/** Opens the rename dialog for a device using this computer. */
export function openDeviceRenameDialog(device: {
  readonly sessionId: AuthSessionId;
  readonly shownAs: string;
  readonly label: string;
  readonly deviceLabel: string;
}): void {
  open({ kind: "device", ...device });
}

/** Closes the dialog; with `requestId`, only if it still shows that ask. */
function closeDeviceRenameDialog(requestId?: number): void {
  const { request } = useDeviceRenameDialogStore.getState();
  if (requestId !== undefined && request?.id !== requestId) return;
  useDeviceRenameDialogStore.setState({ request: null });
}

/**
 * The computer as its Rename needs it, or null when it can't be renamed from
 * here now: not connected, or a server too old to take a name.
 */
export function useComputerNaming(environmentId: EnvironmentId | null): ComputerNaming | null {
  const primaryConfig = useServerConfig();
  const savedConfig = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.serverConfig ?? null),
  );
  const reachable = useEnvironmentApiAvailable(environmentId);
  const config =
    environmentId === null
      ? null
      : primaryConfig?.environment.environmentId === environmentId
        ? primaryConfig
        : savedConfig;
  if (config === null || !reachable || config.environment.capabilities.deviceNames !== true) {
    return null;
  }
  const { environment } = config;
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    systemLabel: environment.systemLabel ?? environment.label,
    os: environment.platform.os,
  };
}

const SYSTEM_NAMES: Record<ExecutionEnvironmentPlatformOs, string> = {
  darwin: "macOS",
  windows: "Windows",
  linux: "Linux",
  unknown: "its system",
};

/** Mounted once at the root; shows whatever the open functions ask. */
export function DeviceRenameDialogHost() {
  const request = useDeviceRenameDialogStore((state) => state.request);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) closeDeviceRenameDialog();
      }}
    >
      {request === null ? null : request.kind === "computer" ? (
        <ComputerRenameContent key={request.id} request={request} />
      ) : (
        <DeviceRenameContent key={request.id} request={request} />
      )}
    </Dialog>
  );
}

function ComputerRenameContent({
  request,
}: {
  readonly request: Extract<DeviceRenameRequest, { kind: "computer" }>;
}) {
  return (
    <RenameDialogForm
      title={`Rename ${request.label}`}
      description="Your phones and other computers see it by this name."
      inputLabel="Computer name"
      initialValue={request.label}
      placeholder={request.systemLabel}
      hint={`Leave it empty to use ${request.systemLabel}, the name ${SYSTEM_NAMES[request.os]} gives it.`}
      allowEmpty
      maxLength={DEVICE_NAME_MAX_LENGTH}
      failure="The computer couldn't be renamed."
      testId="computer-rename"
      onClose={() => closeDeviceRenameDialog()}
      onSave={async (name) => {
        const api = readEnvironmentApi(request.environmentId);
        if (!api) throw new Error(`${request.label} isn't connected.`);
        await api.settings.update({
          computerName: name.length === 0 || name === request.systemLabel ? null : name,
        });
        closeDeviceRenameDialog(request.id);
      }}
    />
  );
}

function DeviceRenameContent({
  request,
}: {
  readonly request: Extract<DeviceRenameRequest, { kind: "device" }>;
}) {
  return (
    <RenameDialogForm
      title={`Rename ${request.shownAs}`}
      description="This computer shows it by this name, and its agents see it on messages it sends."
      inputLabel="Device name"
      initialValue={request.label}
      placeholder={request.deviceLabel}
      hint={`Leave it empty to use ${request.deviceLabel}.`}
      allowEmpty
      maxLength={DEVICE_NAME_MAX_LENGTH}
      failure="The device couldn't be renamed."
      testId="device-rename"
      onClose={() => closeDeviceRenameDialog()}
      onSave={async (name) => {
        await renameServerClientSession(
          request.sessionId,
          name.length === 0 || name === request.deviceLabel ? null : name,
        );
        closeDeviceRenameDialog(request.id);
      }}
    />
  );
}
