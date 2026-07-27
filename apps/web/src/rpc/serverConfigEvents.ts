import type { ServerConfig, ServerConfigStreamEvent } from "@threadlines/contracts";

/**
 * Folds a server config stream event into the config it updates.
 *
 * The same stream feeds two consumers: app-level server state (the atom in
 * `serverState.ts`) and each saved environment's runtime record. Both must
 * apply live provider/keybinding/settings updates the same way, so the
 * reduction lives here rather than in either consumer.
 *
 * Returns `null` for a non-snapshot event that arrives before any snapshot —
 * there is nothing to patch yet, and the snapshot that follows carries the
 * same state.
 */
export function applyServerConfigStreamEvent(
  config: ServerConfig | null,
  event: ServerConfigStreamEvent,
): ServerConfig | null {
  if (event.type === "snapshot") {
    return event.config;
  }
  if (!config) {
    return null;
  }
  switch (event.type) {
    case "keybindingsUpdated": {
      return {
        ...config,
        keybindings: event.payload.keybindings,
        issues: event.payload.issues,
      };
    }
    case "providerStatuses": {
      return { ...config, providers: event.payload.providers };
    }
    case "settingsUpdated": {
      return { ...config, settings: event.payload.settings };
    }
  }
}
