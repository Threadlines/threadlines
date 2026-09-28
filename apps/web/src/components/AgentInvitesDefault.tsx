import { useEffect } from "react";

import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { useServerConfig } from "../rpc/serverState";

/**
 * Agents bringing in other agents is part of Rooms: the first time a device
 * with Rooms on sees a server where nobody chose yet, it picks "Ask me first"
 * (docs/design/rooms-agent-invites.md). The server applies it only if still
 * nobody chose, so a choice another device made meanwhile ("Off" included)
 * is never overwritten.
 */
export function AgentInvitesDefault() {
  const roomsEnabled = useSettings((settings) => settings.roomsEnabled);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const serverConfig = useServerConfig();
  const unchosen = serverConfig !== null && serverConfig.settings.agentInvites === undefined;
  useEffect(() => {
    if (clientSettingsHydrated && roomsEnabled && unchosen) {
      void ensureLocalApi()
        .server.updateSettings({ agentInvitesDefault: "ask" })
        .catch(() => undefined);
    }
  }, [clientSettingsHydrated, roomsEnabled, unchosen]);
  return null;
}
