import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  buildFirstRunSetupDismissalKey,
  canStartFirstThread,
  deriveFirstRunProjectRow,
  deriveFirstRunProviderRows,
  dismissFirstRunSetup,
  FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY,
  isFirstRunSetupDismissed,
  shouldShowFirstRunSetupCard,
  type FirstRunSetupProvider,
} from "./firstRunSetup";

function provider(overrides: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly version?: string | null;
  readonly auth?: ServerProvider["auth"];
  readonly message?: string;
}): FirstRunSetupProvider {
  const driverKind = ProviderDriverKind.make(overrides.driver);
  const snapshot: ServerProvider = {
    driver: driverKind,
    instanceId: ProviderInstanceId.make(overrides.instanceId),
    displayName: overrides.displayName,
    enabled: overrides.enabled ?? true,
    installed: overrides.installed ?? true,
    version: overrides.version ?? null,
    status: "ready",
    auth: overrides.auth ?? { status: "authenticated" },
    checkedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    slashCommands: [],
    skills: [],
    models: [],
    ...(overrides.message ? { message: overrides.message } : {}),
  };
  return {
    instanceId: snapshot.instanceId,
    driverKind,
    displayName: overrides.displayName,
    enabled: snapshot.enabled,
    snapshot,
  };
}

const signedInCodex = provider({
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  version: "0.146.1",
  auth: { status: "authenticated", label: "ChatGPT Plus Subscription" },
});

const signedOutCodex = provider({
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  version: "0.146.1",
  auth: { status: "unauthenticated" },
});

const missingClaude = provider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  installed: false,
  auth: { status: "unknown" },
});

const READY_PROJECT_ROW = deriveFirstRunProjectRow({
  projectName: "B-git-project",
  projectCwd: "C:/code/B-git-project",
  isOnlyWorkspaceProject: true,
});
const MISSING_PROJECT_ROW = deriveFirstRunProjectRow({
  projectName: null,
  projectCwd: null,
  isOnlyWorkspaceProject: false,
});

const SHOWN_INPUT = {
  isHostedStatic: false,
  isDraftThread: true,
  isGeneralChat: false,
  bootstrapComplete: true,
  hasUserMessagedThread: false,
  isDismissed: false,
} as const;

describe("shouldShowFirstRunSetupCard", () => {
  it("shows on a cold draft thread that has never been messaged", () => {
    expect(shouldShowFirstRunSetupCard(SHOWN_INPUT)).toBe(true);
  });

  it("hides once any thread in the environment carries a user message", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, hasUserMessagedThread: true })).toBe(
      false,
    );
  });

  it("hides once dismissed", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isDismissed: true })).toBe(false);
  });

  it("never renders on hosted phone surfaces, general chat, or a server thread", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isHostedStatic: true })).toBe(false);
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isGeneralChat: true })).toBe(false);
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isDraftThread: false })).toBe(false);
  });

  it("waits for the environment bootstrap before deciding", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, bootstrapComplete: false })).toBe(false);
  });
});

describe("first-run setup dismissal", () => {
  beforeEach(() => {
    removeLocalStorageItem(FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY);
  });

  it("persists per environment", () => {
    const local = buildFirstRunSetupDismissalKey(EnvironmentId.make("environment-local"));
    const remote = buildFirstRunSetupDismissalKey(EnvironmentId.make("environment-remote"));

    expect(isFirstRunSetupDismissed(local)).toBe(false);

    dismissFirstRunSetup(local);

    expect(isFirstRunSetupDismissed(local)).toBe(true);
    expect(isFirstRunSetupDismissed(remote)).toBe(false);
  });
});

describe("deriveFirstRunProviderRows", () => {
  it("routes each provider state to its own dot, copy, and action affordance", () => {
    const rows = deriveFirstRunProviderRows([signedOutCodex, missingClaude, signedInCodex]);

    expect(rows.map((row) => row.state)).toEqual(["needsSignIn", "notInstalled", "ready"]);
    expect(rows[0]?.signInCommand).toBe("codex login");
    expect(rows[0]?.versionLabel).toBe("v0.146.1");
    expect(rows[0]?.description).toContain("Not authenticated");
    // Nothing to sign in to yet, so the row must not offer a login command.
    expect(rows[1]?.signInCommand).toBeNull();
    expect(rows[1]?.description).toContain("CLI not detected on PATH");
    expect(rows[2]?.description).toBe("Signed in · ChatGPT Plus Subscription");
    expect(new Set(rows.map((row) => row.dotClassName)).size).toBe(3);
  });

  it("leaves out instances the user disabled", () => {
    const rows = deriveFirstRunProviderRows([{ ...signedInCodex, enabled: false }, missingClaude]);

    expect(rows.map((row) => row.name)).toEqual(["Claude"]);
  });
});

describe("deriveFirstRunProjectRow", () => {
  it("claims the launch folder only for the workspace's sole project", () => {
    expect(READY_PROJECT_ROW.description).toBe("B-git-project · the folder you launched from");
    expect(
      deriveFirstRunProjectRow({
        projectName: "other",
        projectCwd: "C:/code/other",
        isOnlyWorkspaceProject: false,
      }).description,
    ).toBe("other · C:/code/other");
  });

  it("asks for a folder when there is none", () => {
    expect(MISSING_PROJECT_ROW.state).toBe("missing");
    expect(MISSING_PROJECT_ROW.actionLabel).toBe("Choose a folder");
  });
});

describe("canStartFirstThread", () => {
  it("stays disabled until a usable provider and a project both exist", () => {
    const unusable = deriveFirstRunProviderRows([signedOutCodex, missingClaude]);
    const usable = deriveFirstRunProviderRows([signedOutCodex, signedInCodex]);

    expect(canStartFirstThread({ providerRows: unusable, projectRow: READY_PROJECT_ROW })).toBe(
      false,
    );
    expect(canStartFirstThread({ providerRows: usable, projectRow: MISSING_PROJECT_ROW })).toBe(
      false,
    );
    expect(canStartFirstThread({ providerRows: usable, projectRow: READY_PROJECT_ROW })).toBe(true);
  });
});
