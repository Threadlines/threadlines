import { ORCHESTRATION_WS_METHODS, MessageId, WS_METHODS } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { __setEnvironmentApiOverrideForTests } from "../environmentApi";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { isMacPlatform } from "../lib/utils";

import {
  REMOTE_ENVIRONMENT_ID,
  UUID_ROUTE_RE,
  NOW_ISO,
  ADD_PROJECT_SUBMENU_PLACEHOLDER,
  fixture,
  wsRequests,
  DEFAULT_VIEWPORT,
  createMockEnvironmentApi,
  createSnapshotForTargetUser,
  createSnapshotWithSecondaryProject,
  waitForURL,
  waitForServerConfigToApply,
  openCommandPaletteFromTrigger,
  waitForCommandPaletteShortcutLabel,
  waitForCommandPaletteInput,
  clickCommandPaletteAction,
  selectLocalFolderAction,
  getCommandPaletteLegendEntries,
  dispatchInputKey,
  mountChatView,
  registerChatViewSuiteHooks,
} from "./ChatView.browser-harness";

vi.mock("../lib/gitStatusState", () => ({
  // Read synchronously by the draft seeder to skip a checkout already known
  // to be missing; these suites never exercise a deleted checkout.
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

describe("ChatView (full app): add project", () => {
  registerChatViewSuiteHooks();

  it("shows clone destination controls after resolving an add project repository", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-remote" as MessageId,
        targetText: "command palette add project remote",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === WS_METHODS.sourceControlLookupRepository) {
          return {
            provider: "github",
            nameWithOwner: "t3-oss/t3-env",
            url: "https://github.com/t3-oss/t3-env",
            sshUrl: "git@github.com:t3-oss/t3-env.git",
          };
        }

        if (body._tag === WS_METHODS.sourceControlCloneRepository) {
          return {
            cwd: body.destinationPath,
            remoteUrl: body.remoteUrl,
            repository: null,
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("GitHub repository", { exact: true }).click();

      await waitForCommandPaletteInput("Enter GitHub repository (owner/repo)");
      await expect.element(palette.getByText("t3-oss/t3-env", { exact: true })).toBeVisible();
      await palette.getByText("t3-oss/t3-env", { exact: true }).click();

      await vi.waitFor(
        () => {
          const clonePathInput = document.querySelector<HTMLInputElement>(
            'input[placeholder="Enter path (e.g. ~/projects/my-app)"]',
          );
          expect(clonePathInput?.value).toBe("~/");
          expect(document.body.textContent).toContain("Repository");
          expect(document.body.textContent).toContain("t3-oss/t3-env");
          expect(document.body.textContent).toContain("https://github.com/t3-oss/t3-env");
          expect(document.body.textContent).toContain("Select where to clone");
          expect(document.body.textContent).toContain("Development");
          expect(document.body.textContent).toContain("Clone");
        },
        { timeout: 8_000, interval: 16 },
      );

      const clonePathInput = await waitForCommandPaletteInput(
        "Enter path (e.g. ~/projects/my-app)",
      );
      await dispatchInputKey(clonePathInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const cloneRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.sourceControlCloneRepository,
          ) as { destinationPath?: string; provider?: string; remoteUrl?: string } | undefined;
          expect(cloneRequest).toMatchObject({
            provider: "github",
            remoteUrl: "https://github.com/t3-oss/t3-env",
            destinationPath: "~/t3-env",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens add project browse mode from the sidebar add button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-trigger" as MessageId,
        targetText: "sidebar add project trigger",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await selectLocalFolderAction();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse && request.partialPath === "~/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts add project browse mode from the configured base directory", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-custom-base-dir" as MessageId,
        targetText: "sidebar add project custom base directory",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [{ name: "codething", fullPath: "~/Development/codething" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await selectLocalFolderAction();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/Development/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows create-folder affordances for missing project paths", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-create-missing-project" as MessageId,
        targetText: "command palette create missing project",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Desktop/") {
            return {
              parentPath: "~/Desktop/",
              entries: [{ name: "existing", fullPath: "~/Desktop/existing" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Desktop", fullPath: "~/Desktop" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await selectLocalFolderAction();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Desktop/fresh-project");

      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .toBeInTheDocument();
      await expect.element(palette.getByText("Will create this folder")).not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
                createWorkspaceRootIfMissing?: boolean;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Desktop/fresh-project",
            title: "fresh-project",
            createWorkspaceRootIfMissing: true,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show create affordances for an existing directory with a trailing slash", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-existing-trailing-directory" as MessageId,
        targetText: "command palette existing trailing directory",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/codex/") {
            return {
              parentPath: "~/Development/codex/",
              entries: [{ name: "Codex.app", fullPath: "~/Development/codex/Codex.app" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await selectLocalFolderAction();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/codex/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/codex/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development/codex",
            title: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects an environment before browsing when multiple environments are available", async () => {
    const remoteBrowseMock = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "~/workspaces/") {
        return {
          parentPath: "~/workspaces/",
          entries: [{ name: "codething", fullPath: "~/workspaces/codething" }],
        };
      }

      return {
        parentPath: "~/",
        entries: [{ name: "workspaces", fullPath: "~/workspaces" }],
      };
    });
    const remoteDispatchMock = vi.fn(async () => ({
      sequence: fixture.snapshot.snapshotSequence + 1,
    }));

    __setEnvironmentApiOverrideForTests(
      REMOTE_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: remoteBrowseMock,
        dispatchCommand: remoteDispatchMock,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-multi-env" as MessageId,
        targetText: "command palette add project multi env",
      }),
    });

    try {
      await waitForServerConfigToApply();
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: REMOTE_ENVIRONMENT_ID,
        label: "Staging",
        httpBaseUrl: "https://staging.example.test",
        wsBaseUrl: "wss://staging.example.test/ws",
        createdAt: NOW_ISO,
        lastConnectedAt: NOW_ISO,
      });
      // Adding a saved environment wakes the real connection service. Let its
      // missing-credential attempt settle before installing the connected
      // runtime fixture; otherwise that background patch can replace the
      // source-picker rows while the test is clicking one of them.
      await vi.waitFor(
        () => {
          expect(
            useSavedEnvironmentRuntimeStore.getState().byId[REMOTE_ENVIRONMENT_ID]?.authState,
          ).toBe("requires-auth");
        },
        { timeout: 8_000, interval: 16 },
      );
      useSavedEnvironmentRuntimeStore.getState().patch(REMOTE_ENVIRONMENT_ID, {
        connectionState: "connected",
        authState: "authenticated",
        descriptor: {
          ...fixture.serverConfig.environment,
          environmentId: REMOTE_ENVIRONMENT_ID,
          label: "Staging",
        },
        serverConfig: {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Staging",
          },
          settings: {
            ...fixture.serverConfig.settings,
            addProjectBaseDirectory: "~/workspaces",
          },
        },
        connectedAt: NOW_ISO,
      });

      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await expect.element(palette.getByText("Environments", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("This device", { exact: true }).first())
        .toBeInTheDocument();
      await clickCommandPaletteAction("Staging");
      await selectLocalFolderAction();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/workspaces/");

      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({ partialPath: "~/workspaces/" });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/workspaces/");
      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({ partialPath: "~/workspaces/" });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(palette.getByText("codething", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          expect(remoteDispatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "project.create",
              workspaceRoot: "~/workspaces",
              title: "workspaces",
            }),
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a remote project.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("picks a local project from the native file manager", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/julius/Projects/finder-picked");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-file-manager" as MessageId,
        targetText: "command palette add project file manager",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Applications/") {
            return {
              parentPath: "~/Applications/",
              entries: [{ name: "Utilities", fullPath: "~/Applications/Utilities" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Applications", fullPath: "~/Applications" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      window.desktopBridge = {
        pickFolder,
        setTheme: vi.fn().mockResolvedValue(undefined),
      } as unknown as NonNullable<typeof window.desktopBridge>;

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await selectLocalFolderAction();
      const browseInput = palette.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await browseInput.fill("~/Applications/access");

      // Named after the primary computer, which the harness makes a Mac
      // whatever runs the test.
      const fileManagerLabel = "Open in Finder";
      await palette.getByRole("button", { name: fileManagerLabel }).click();

      await vi.waitFor(
        () => {
          expect(pickFolder).toHaveBeenCalledWith({ initialPath: "~/Applications" });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "/Users/julius/Projects/finder-picked",
            title: "finder-picked",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project from the native file manager.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Mod+Enter when a directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-mod-enter" as MessageId,
        targetText: "command palette add project mod enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await selectLocalFolderAction();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "ArrowDown" });

      const addButtonLabel = isMacPlatform(navigator.platform)
        ? "Add (\u2318 Enter)"
        : "Add (Ctrl Enter)";
      await vi.waitFor(
        () => {
          const legendEntries = getCommandPaletteLegendEntries();
          expect(legendEntries).toContain("Enter Select");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(palette.getByRole("button", { name: addButtonLabel }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, {
        key: "Enter",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
      });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Mod+Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps project-context thread matches available when searching by project name", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Release checklist", { exact: true }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
