/**
 * One server setting of the computer a thread runs on: this computer's live
 * settings, or a linked computer's as its connection last reported them. What
 * that computer does follows its own settings, so what this app shows for its
 * threads does too. A computer not connected yet reads as the default.
 *
 * @module useEnvironmentServerSetting
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ServerSettings,
} from "@threadlines/contracts";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useServerSettings } from "../rpc/serverState";

export function useEnvironmentServerSetting<K extends keyof ServerSettings>(
  environmentId: EnvironmentId | null | undefined,
  key: K,
): ServerSettings[K] {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = environmentId == null || environmentId === primaryEnvironmentId;
  const primaryValue = useServerSettings()[key];
  const linkedValue = useSavedEnvironmentRuntimeStore((state) =>
    isPrimary ? undefined : state.byId[environmentId]?.serverConfig?.settings[key],
  );
  if (isPrimary) return primaryValue;
  return linkedValue ?? DEFAULT_SERVER_SETTINGS[key];
}
