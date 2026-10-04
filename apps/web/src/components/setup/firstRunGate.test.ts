import { EnvironmentId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  deriveFirstRunSetupGate,
  dismissFirstRunSetup,
  FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY,
  resetFirstRunSetupDismissalsForTests,
  useFirstRunSetupDismissalStore,
} from "./firstRunGate";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");

const PENDING = {
  isHostedStatic: false,
  environmentId: LOCAL,
  isDismissed: false,
  bootstrapComplete: true,
  hasUserMessagedThread: false,
} as const;

describe("first-run setup gate", () => {
  beforeEach(() => {
    removeLocalStorageItem(FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY);
    resetFirstRunSetupDismissalsForTests();
  });

  it("is pending on a fresh computer and done once it is used, finished or on a phone", () => {
    expect(deriveFirstRunSetupGate(PENDING)).toBe("pending");
    expect(deriveFirstRunSetupGate({ ...PENDING, hasUserMessagedThread: true })).toBe("done");
    expect(deriveFirstRunSetupGate({ ...PENDING, isDismissed: true })).toBe("done");
    expect(deriveFirstRunSetupGate({ ...PENDING, isHostedStatic: true })).toBe("done");
  });

  it("stays unknown until the computer has loaded", () => {
    // Treating "not loaded yet" as "set up" opened update prompts on top of
    // setup on a fresh install; treating it as "pending" would bounce
    // returning users through setup while their threads load.
    expect(deriveFirstRunSetupGate({ ...PENDING, bootstrapComplete: false })).toBe("unknown");
    expect(deriveFirstRunSetupGate({ ...PENDING, environmentId: null })).toBe("unknown");
  });

  it("remembers finishing or skipping per computer", () => {
    dismissFirstRunSetup(LOCAL);

    const { dismissedKeys } = useFirstRunSetupDismissalStore.getState();
    expect(dismissedKeys.has(String(LOCAL))).toBe(true);
    expect(dismissedKeys.has(String(REMOTE))).toBe(false);
    // Survives a reload: the store re-reads storage from scratch.
    resetFirstRunSetupDismissalsForTests();
    expect(useFirstRunSetupDismissalStore.getState().dismissedKeys.has(String(LOCAL))).toBe(true);
  });
});
