/**
 * Turning agents on and off, for the setup screen and the Providers settings
 * page.
 *
 * Both flip `enabled` on the instance envelope through
 * `buildProviderInstanceUpdatePatch`, which promotes a default slot to an
 * explicit instance the first time it is edited. Setup flips up to six at
 * once, so changes fold over one working copy of the settings: patching each
 * from the original would let the last write drop the others, and building a
 * fresh instance map would drop custom instances.
 *
 * Text-generation selections are deliberately left alone. The server resolves
 * a selection that points at a turned-off instance at read time and keeps the
 * preference for when it comes back on, so a client-side reset could only pick
 * a worse fallback than the server would.
 *
 * @module providerEnablement
 */
import type { ServerSettings, UnifiedSettings } from "@threadlines/contracts";

import { MAINTAINED_PROVIDER_DRIVER_KINDS } from "../../providerInstances";
import {
  buildProviderInstanceUpdatePatch,
  deriveProviderSettingsRows,
  type ProviderSettingsRow,
} from "./SettingsPanels.logic";

type ProviderSettingsState = Pick<ServerSettings, "providers" | "providerInstances">;

export interface ProviderEnablementChange {
  readonly row: ProviderSettingsRow;
  readonly enabled: boolean;
}

/** Every row the Providers page lists, defaults first within each driver. */
export function deriveMaintainedProviderRows(
  settings: ProviderSettingsState,
): ReadonlyArray<ProviderSettingsRow> {
  return deriveProviderSettingsRows({
    settings,
    maintainedDriverKinds: MAINTAINED_PROVIDER_DRIVER_KINDS,
  });
}

export function isProviderRowEnabled(row: ProviderSettingsRow): boolean {
  return row.instance.enabled ?? true;
}

/**
 * One settings patch for any number of on/off changes. Rows already in the
 * requested state are skipped, so an empty patch means nothing to write.
 */
export function buildProviderEnablementPatch(input: {
  readonly settings: ProviderSettingsState;
  readonly changes: ReadonlyArray<ProviderEnablementChange>;
}): Partial<UnifiedSettings> {
  let providers = input.settings.providers;
  let providerInstances = input.settings.providerInstances;
  let providersChanged = false;
  let instancesChanged = false;

  for (const { row, enabled } of input.changes) {
    if (isProviderRowEnabled(row) === enabled) {
      continue;
    }
    const patch = buildProviderInstanceUpdatePatch({
      settings: { providers, providerInstances },
      instanceId: row.instanceId,
      instance: { ...row.instance, enabled },
      driver: row.driver,
      isDefault: row.isDefault,
    });
    if (patch.providers !== undefined) {
      providers = patch.providers;
      providersChanged = true;
    }
    if (patch.providerInstances !== undefined) {
      providerInstances = patch.providerInstances;
      instancesChanged = true;
    }
  }

  return {
    ...(providersChanged ? { providers } : {}),
    ...(instancesChanged ? { providerInstances } : {}),
  };
}
