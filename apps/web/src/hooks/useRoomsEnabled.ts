import type { EnvironmentId, ServerSettings } from "@threadlines/contracts";

import { usePrimaryEnvironmentId } from "../environments/primary/context";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useServerConfig } from "../rpc/serverState";
import { useSettings } from "./useSettings";

const deviceRoomsSwitch = (settings: { readonly roomsEnabled: boolean }) => settings.roomsEnabled;

/**
 * Whether Rooms is on for a computer: its own switch, which every device
 * connected to it follows (a phone through phone link included), or, until
 * that computer has one, this device's old per-device switch.
 */
export const roomsEnabledFor = (
  serverSettings: Pick<ServerSettings, "enableRooms"> | null | undefined,
  deviceRoomsEnabled: boolean,
): boolean => serverSettings?.enableRooms ?? deviceRoomsEnabled;

/**
 * Rooms for the computer a thread lives on. Without one, the computer this
 * app talks to for settings (the paired computer on a phone).
 */
export function useRoomsEnabled(environmentId?: EnvironmentId | null): boolean {
  const deviceRoomsEnabled = useSettings(deviceRoomsSwitch);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const backendConfig = useServerConfig();
  const environmentConfig = useSavedEnvironmentRuntimeStore((state) =>
    environmentId && environmentId !== primaryEnvironmentId
      ? (state.byId[environmentId]?.serverConfig ?? null)
      : null,
  );
  return roomsEnabledFor((environmentConfig ?? backendConfig)?.settings, deviceRoomsEnabled);
}
