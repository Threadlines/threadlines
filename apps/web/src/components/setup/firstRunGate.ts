/**
 * Whether this computer still needs first-run setup, and the record of having
 * finished or skipped it.
 *
 * Setup is about the computer this app's backend runs on (the primary
 * environment): the same one Settings › Providers, install and sign-in act on.
 * The gate is three-way because "not loaded yet" is neither answer: a launch
 * prompt that treated it as "set up" opened on top of setup on a fresh
 * install, and a redirect that treated it as "pending" would bounce returning
 * users through setup while their threads load.
 *
 * @module firstRunGate
 */
import type { EnvironmentId } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  getLocalStorageItemWithLegacyKeys,
  setLocalStorageItem,
} from "../../hooks/useLocalStorage";

/**
 * Same key the first-run card used, so anyone who skipped or finished that
 * card is not walked through setup again.
 */
export const FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY = "threadlines:first-run-setup-dismissals:v1";
const LEGACY_FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEYS: readonly string[] = [];

const FirstRunSetupDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type FirstRunSetupDismissals = typeof FirstRunSetupDismissalsSchema.Type;

function readFirstRunSetupDismissals(): FirstRunSetupDismissals {
  try {
    return (
      getLocalStorageItemWithLegacyKeys(
        FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY,
        LEGACY_FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEYS,
        FirstRunSetupDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch {
    return { keys: [] };
  }
}

function writeFirstRunSetupDismissals(document: FirstRunSetupDismissals): void {
  try {
    setLocalStorageItem(
      FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY,
      document,
      FirstRunSetupDismissalsSchema,
    );
  } catch {
    // Best-effort UI state; a storage failure must not block leaving setup.
  }
}

/**
 * The dismissal record, live. Finishing or skipping setup has to reach the
 * redirect and the launch prompts in the same tick, so it lives in a store
 * rather than in component state.
 */
interface FirstRunSetupDismissalStore {
  readonly dismissedKeys: ReadonlySet<string>;
  readonly dismiss: (environmentId: EnvironmentId) => void;
}

export const useFirstRunSetupDismissalStore = create<FirstRunSetupDismissalStore>((set, get) => ({
  dismissedKeys: new Set(readFirstRunSetupDismissals().keys),
  dismiss: (environmentId) => {
    const key = String(environmentId);
    if (get().dismissedKeys.has(key)) {
      return;
    }
    const document = readFirstRunSetupDismissals();
    if (!document.keys.includes(key)) {
      writeFirstRunSetupDismissals({ keys: [...document.keys, key] });
    }
    set((state) => ({ dismissedKeys: new Set(state.dismissedKeys).add(key) }));
  },
}));

/** Test seam: forgets in-memory dismissals so a suite can start from a cold install. */
export function resetFirstRunSetupDismissalsForTests(): void {
  useFirstRunSetupDismissalStore.setState({
    dismissedKeys: new Set(readFirstRunSetupDismissals().keys),
  });
}

/** Marks setup finished (or skipped) for an environment. Permanent. */
export function dismissFirstRunSetup(environmentId: EnvironmentId | null | undefined): void {
  if (!environmentId) return;
  useFirstRunSetupDismissalStore.getState().dismiss(environmentId);
}

export function useFirstRunSetupDismissed(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const key = environmentId ? String(environmentId) : null;
  return useFirstRunSetupDismissalStore((store) =>
    key === null ? false : store.dismissedKeys.has(key),
  );
}

export type FirstRunSetupGate = "pending" | "done" | "unknown";

/**
 * Every clause is a reason setup would be noise: a hosted phone pairs with a
 * computer instead of setting one up; a finished or skipped setup stays
 * finished; and a computer where someone has already sent a message is not a
 * first run. Until the environment has loaded, the answer is `unknown`.
 */
export function deriveFirstRunSetupGate(input: {
  readonly isHostedStatic: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly isDismissed: boolean;
  readonly bootstrapComplete: boolean;
  readonly hasUserMessagedThread: boolean;
}): FirstRunSetupGate {
  if (input.isHostedStatic || input.isDismissed) {
    return "done";
  }
  if (input.environmentId === null || !input.bootstrapComplete) {
    return "unknown";
  }
  return input.hasUserMessagedThread ? "done" : "pending";
}
