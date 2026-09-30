import type { EnvironmentId, ServerSettings } from "@threadlines/contracts";
import { roomsEnabled } from "@threadlines/shared/serverSettings";

import { usePrimaryEnvironmentId } from "../environments/primary/context";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useServerConfig } from "../rpc/serverState";

/**
 * Whether Rooms is on for a computer: its own switch, which every device
 * connected to it follows (a phone through phone link included). On until
 * someone turns it off.
 */
export const roomsEnabledFor = (
  serverSettings: Pick<ServerSettings, "enableRooms"> | null | undefined,
): boolean => roomsEnabled(serverSettings);

/**
 * Rooms for the computer a thread lives on. Without one, the computer this
 * app talks to for settings (the paired computer on a phone).
 */
export function useRoomsEnabled(environmentId?: EnvironmentId | null): boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const backendConfig = useServerConfig();
  const environmentConfig = useSavedEnvironmentRuntimeStore((state) =>
    environmentId && environmentId !== primaryEnvironmentId
      ? (state.byId[environmentId]?.serverConfig ?? null)
      : null,
  );
  return roomsEnabledFor((environmentConfig ?? backendConfig)?.settings);
}
