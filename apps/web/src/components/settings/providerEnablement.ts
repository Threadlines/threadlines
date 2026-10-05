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
 * Rows the Providers page keeps where they are for a moment, by instance id:
 * `true` holds a row under "In use", `false` under "Not in use".
 */
export type HeldProviderRows = ReadonlyMap<string, boolean>;

/**
 * The page's two groups. A row sits in the group its switch says, except a
 * held one, which stays where it was when it was switched: the row a reader
 * just clicked must not jump away from under the pointer, and a wrong click
 * should be one click to undo. The page lets go of held rows when the pointer
 * or focus leaves the list.
 */
export function groupProviderRows(
  rows: ReadonlyArray<ProviderSettingsRow>,
  held: HeldProviderRows,
): {
  readonly inUse: ReadonlyArray<ProviderSettingsRow>;
  readonly notInUse: ReadonlyArray<ProviderSettingsRow>;
} {
  const sitsInUse = (row: ProviderSettingsRow) =>
    held.get(row.instanceId) ?? isProviderRowEnabled(row);
  return {
    inUse: rows.filter(sitsInUse),
    notInUse: rows.filter((row) => !sitsInUse(row)),
  };
}

/**
 * Drops holds that no longer say anything: the row is gone, or it sits in the
 * group it is held in (it was switched back, or a failed write rolled back).
 * Without this an old hold could come back to life on a later change. Returns
 * the same map when nothing was dropped.
 */
export function pruneHeldProviderRows(
  held: HeldProviderRows,
  rows: ReadonlyArray<ProviderSettingsRow>,
): HeldProviderRows {
  if (held.size === 0) return held;
  const enabledById = new Map<string, boolean>(
    rows.map((row) => [row.instanceId, isProviderRowEnabled(row)]),
  );
  const kept = [...held].filter(
    ([instanceId, sitsInUse]) =>
      enabledById.has(instanceId) && enabledById.get(instanceId) !== sitsInUse,
  );
  return kept.length === held.size ? held : new Map(kept);
}

/**
 * The held rows after a row's switch was flipped. The row is held in the group
 * it was sitting in; flipping it back lets it go, since it is home again.
 */
export function holdProviderRow(
  held: HeldProviderRows,
  row: ProviderSettingsRow,
  nextEnabled: boolean,
): HeldProviderRows {
  const sittingInUse = held.get(row.instanceId) ?? isProviderRowEnabled(row);
  const next = new Map(held);
  if (sittingInUse === nextEnabled) {
    next.delete(row.instanceId);
  } else {
    next.set(row.instanceId, sittingInUse);
  }
  return next;
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
