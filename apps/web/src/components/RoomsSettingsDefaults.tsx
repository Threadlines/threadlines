import { useEffect, useRef } from "react";
import type { EnvironmentId, ServerSettingsPatch } from "@threadlines/contracts";

import {
  readEnvironmentConnection,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useRoomsEnabled } from "../hooks/useRoomsEnabled";
import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { useServerConfig } from "../rpc/serverState";

const legacyRoomsEnabled = (settings: { readonly roomsEnabled: boolean }) => settings.roomsEnabled;

/**
 * Settles the Rooms settings of the computers this device talks to. Each
 * server applies a default only while nobody has chosen, so a choice another
 * device made meanwhile ("off" included) is never overwritten.
 *
 * - Rooms: a device whose old per-device switch is on lifts it onto every
 *   computer it is connected to, so every device connected to one of them
 *   agrees, a phone included.
 * - Agent invites are part of Rooms: the first time a device with Rooms on
 *   sees a server where nobody chose yet, it picks "Ask me first"
 *   (docs/design/rooms-agent-invites.md).
 */
export function RoomsSettingsDefaults() {
  const deviceRoomsEnabled = useSettings(legacyRoomsEnabled);
  const roomsEnabled = useRoomsEnabled();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const serverConfig = useServerConfig();
  const roomsUnchosen = serverConfig !== null && serverConfig.settings.enableRooms === undefined;
  const invitesUnchosen = serverConfig !== null && serverConfig.settings.agentInvites === undefined;
  useEffect(() => {
    if (!clientSettingsHydrated) return;
    const patch: ServerSettingsPatch = {
      ...(deviceRoomsEnabled && roomsUnchosen ? { enableRoomsDefault: true } : {}),
      ...(roomsEnabled && invitesUnchosen ? { agentInvitesDefault: "ask" as const } : {}),
    };
    if (Object.keys(patch).length > 0) {
      void ensureLocalApi()
        .server.updateSettings(patch)
        .catch(() => undefined);
    }
  }, [clientSettingsHydrated, deviceRoomsEnabled, invitesUnchosen, roomsEnabled, roomsUnchosen]);

  // The other computers: each is asked once per launch, so one that cannot
  // take the setting (an older version) is not asked again on every change.
  const unchosenSavedComputers = useSavedEnvironmentRuntimeStore((state) =>
    Object.entries(state.byId)
      .filter(([, runtime]) => runtime.serverConfig?.settings.enableRooms === undefined)
      .filter(([, runtime]) => runtime.serverConfig != null)
      .map(([environmentId]) => environmentId)
      .join(","),
  );
  const askedComputers = useRef(new Set<string>());
  useEffect(() => {
    if (!clientSettingsHydrated || !deviceRoomsEnabled || unchosenSavedComputers === "") return;
    for (const environmentId of unchosenSavedComputers.split(",")) {
      if (askedComputers.current.has(environmentId)) continue;
      const connection = readEnvironmentConnection(environmentId as EnvironmentId);
      if (connection === null) continue;
      askedComputers.current.add(environmentId);
      void connection.client.server
        .updateSettings({ enableRoomsDefault: true })
        .catch(() => undefined);
    }
  }, [clientSettingsHydrated, deviceRoomsEnabled, unchosenSavedComputers]);
  return null;
}
