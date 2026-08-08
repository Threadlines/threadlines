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
  groupFirstRunProviderRows,
  isFirstRunSetupDismissed,
  resetFirstRunSetupDismissalsForTests,
  shouldShowFirstRunSetupCard,
  useFirstRunSetupDismissalStore,
  type FirstRunSetupProvider,
  type FirstRunSetupSurface,
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
  readonly installCommand?: string;
  readonly updateState?: ServerProvider["updateState"];
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
    ...(overrides.updateState ? { updateState: overrides.updateState } : {}),
    ...(overrides.installCommand
      ? {
          versionAdvisory: {
            status: "unknown" as const,
            currentVersion: null,
            latestVersion: null,
            updateCommand: null,
            canUpdate: false,
            installCommand: overrides.installCommand,
            canInstall: true,
            checkedAt: null,
            message: null,
          },
        }
      : {}),
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

const DRAFT_SURFACE = {
  kind: "draftThread",
  isDraftThread: true,
  isGeneralChat: false,
} as const satisfies FirstRunSetupSurface;
const NO_THREAD_SURFACE = { kind: "noThread" } as const satisfies FirstRunSetupSurface;

const SHOWN_INPUT = {
  surface: DRAFT_SURFACE,
  isHostedStatic: false,
  bootstrapComplete: true,
  hasUserMessagedThread: false,
  isDismissed: false,
} as const;

describe("shouldShowFirstRunSetupCard", () => {
  it("shows on a cold draft thread that has never been messaged", () => {
    expect(shouldShowFirstRunSetupCard(SHOWN_INPUT)).toBe(true);
  });

  it("shows on the no-thread canvas a project-less desktop launch lands on", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, surface: NO_THREAD_SURFACE })).toBe(true);
  });

  it("hides once any thread in the environment carries a user message", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, hasUserMessagedThread: true })).toBe(
      false,
    );
  });

  it("hides once dismissed, on either canvas", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isDismissed: true })).toBe(false);
    expect(
      shouldShowFirstRunSetupCard({
        ...SHOWN_INPUT,
        surface: NO_THREAD_SURFACE,
        isDismissed: true,
      }),
    ).toBe(false);
  });

  it("never renders on hosted phone surfaces, general chat, or a server thread", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isHostedStatic: true })).toBe(false);
    expect(
      shouldShowFirstRunSetupCard({
        ...SHOWN_INPUT,
        surface: NO_THREAD_SURFACE,
        isHostedStatic: true,
      }),
    ).toBe(false);
    expect(
      shouldShowFirstRunSetupCard({
        ...SHOWN_INPUT,
        surface: { ...DRAFT_SURFACE, isGeneralChat: true },
      }),
    ).toBe(false);
    expect(
      shouldShowFirstRunSetupCard({
        ...SHOWN_INPUT,
        surface: { ...DRAFT_SURFACE, isDraftThread: false },
      }),
    ).toBe(false);
  });

  it("waits for the environment bootstrap before deciding", () => {
    expect(shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, bootstrapComplete: false })).toBe(false);
  });
});

describe("first-run setup dismissal", () => {
  beforeEach(() => {
    removeLocalStorageItem(FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY);
    resetFirstRunSetupDismissalsForTests();
  });

  it("persists per environment", () => {
    const local = buildFirstRunSetupDismissalKey(EnvironmentId.make("environment-local"));
    const remote = buildFirstRunSetupDismissalKey(EnvironmentId.make("environment-remote"));

    expect(isFirstRunSetupDismissed(local)).toBe(false);

    dismissFirstRunSetup(local);

    expect(isFirstRunSetupDismissed(local)).toBe(true);
    expect(isFirstRunSetupDismissed(remote)).toBe(false);
  });

  it("is shared: skipping on one surface is skipping on every surface", () => {
    const local = buildFirstRunSetupDismissalKey(EnvironmentId.make("environment-local"));

    // The draft canvas, the no-thread canvas, and the update prompt all read
    // this store, so one write has to settle it for all of them in the same
    // tick -- not only after the next reload.
    useFirstRunSetupDismissalStore.getState().dismiss(local);

    expect(useFirstRunSetupDismissalStore.getState().dismissedKeys.has(local)).toBe(true);
    expect(
      shouldShowFirstRunSetupCard({ ...SHOWN_INPUT, isDismissed: isFirstRunSetupDismissed(local) }),
    ).toBe(false);
    expect(
      shouldShowFirstRunSetupCard({
        ...SHOWN_INPUT,
        surface: NO_THREAD_SURFACE,
        isDismissed: isFirstRunSetupDismissed(local),
      }),
    ).toBe(false);
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

  it("offers a one-click install only when the server derived one", () => {
    const installableClaude = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      installed: false,
      auth: { status: "unknown" },
      installCommand: "npm install -g @anthropic-ai/claude-code@latest",
      updateState: {
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
        message: "Installing provider.",
        output: null,
      },
    });

    const [installableRow] = deriveFirstRunProviderRows([installableClaude]);
    expect(installableRow?.install).toEqual({
      command: "npm install -g @anthropic-ai/claude-code@latest",
      status: "running",
      message: "Installing provider.",
      lastOutputLine: null,
    });

    // No derived command means no button: the row keeps the install guide.
    expect(deriveFirstRunProviderRows([missingClaude])[0]?.install).toBeNull();
    // An installed provider never offers an install, whatever else is true.
    expect(deriveFirstRunProviderRows([signedOutCodex])[0]?.install).toBeNull();
  });

  it("leaves out instances the user disabled", () => {
    const rows = deriveFirstRunProviderRows([{ ...signedInCodex, enabled: false }, missingClaude]);

    expect(rows.map((row) => row.name)).toEqual(["Claude"]);
  });

  it("orders rows by actionability: sign-in, install, then ready", () => {
    // Settings order is Claude-first here, but the checklist leads with the
    // provider that is one browser window from working.
    const rows = deriveFirstRunProviderRows([missingClaude, signedInCodex, signedOutCodex]);

    expect(rows.map((row) => row.state)).toEqual(["needsSignIn", "notInstalled", "ready"]);
  });

  it("collapses providers past the visible cap into an overflow group", () => {
    const rows = deriveFirstRunProviderRows([
      signedOutCodex,
      missingClaude,
      provider({ instanceId: "cursor", driver: "cursor", displayName: "Cursor", installed: false }),
      provider({ instanceId: "opencode", driver: "opencode", displayName: "OpenCode" }),
    ]);
    const groups = groupFirstRunProviderRows(rows);

    expect(groups.visible).toHaveLength(3);
    // Priority puts the ready OpenCode row last, so it is the one collapsed.
    expect(groups.overflow?.map((row) => row.name)).toEqual(["OpenCode"]);
  });

  it("keeps every row visible while at or under the cap", () => {
    const rows = deriveFirstRunProviderRows([signedOutCodex, missingClaude]);

    expect(groupFirstRunProviderRows(rows)).toEqual({ visible: rows, overflow: null });
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
