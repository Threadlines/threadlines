import {
  type MessageId,
  ProjectId,
  type ProjectSetupStartInput,
  ThreadId,
  WS_METHODS,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { deriveLogicalProjectKey } from "../logicalProject";
import { __setProjectSetupsClientForTests } from "../environments/projectSetups/projectSetups";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import {
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PROJECT_ID,
  PROJECT_SETUP_SOURCE,
  WIDE_FOOTER_VIEWPORT,
  FLEET_REMOTE_ENVIRONMENT_ID,
  FLEET_OFFLINE_ENVIRONMENT_ID,
  createSnapshotForTargetUser,
  fakeProjectSetupsClient,
  injectRemoteEnvironmentProjects,
  isoAt,
  mountChatView,
  projectRepositoryIdentity,
  projectSetupJob,
  registerChatViewSuiteHooks,
  saveFleetComputers,
  waitForServerConfigToApply,
  withProjectRepository,
  withProjectSetupFixture,
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

/** The ignored files this computer's server reads for a start. */
const READ_FILES = [
  { path: ".env", contentBase64: "QVBJX0tFWT0x", mode: 0o600 },
  { path: "apps/web/.env.local", contentBase64: "UE9SVD0z", mode: 0o644 },
] as const;

/**
 * This computer has the project; Mac mini (connected, takes setups) doesn't,
 * and keeps its other projects in ~/code; Windows PC has it already. Answers
 * this computer's setup reads, and gives back Mac mini's stand-in server.
 */
async function mountWithTwoComputers(
  readFiles: Array<NormalizedWsRpcRequestBody>,
  at?: { readonly draftId: DraftId },
) {
  const mac = fakeProjectSetupsClient();
  __setProjectSetupsClientForTests(FLEET_OFFLINE_ENVIRONMENT_ID, mac.client);
  const snapshot = withProjectRepository(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-project-setup" as MessageId,
      targetText: "project setup",
    }),
  );
  const mounted = await mountChatView({
    viewport: WIDE_FOOTER_VIEWPORT,
    ...(at !== undefined ? { initialPath: `/draft/${at.draftId}` } : {}),
    snapshot: at !== undefined ? { ...snapshot, threads: [] } : snapshot,
    configureFixture: withProjectSetupFixture,
    resolveRpc: (body) => {
      if (body._tag === WS_METHODS.projectSetupsSource) return PROJECT_SETUP_SOURCE;
      if (body._tag === WS_METHODS.projectSetupsReadFiles) {
        readFiles.push(body);
        return { files: READ_FILES };
      }
      return undefined;
    },
  });
  await waitForServerConfigToApply();
  await saveFleetComputers([
    {
      environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
      label: "Mac mini",
      os: "darwin",
      state: "connected",
    },
    {
      environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
      label: "Windows PC",
      os: "windows",
      state: "connected",
    },
  ]);
  injectRemoteEnvironmentProjects(FLEET_OFFLINE_ENVIRONMENT_ID, [
    {
      id: ProjectId.make("project-mac-other"),
      name: "Other",
      cwd: "/Users/me/code/other",
      repositoryIdentity: projectRepositoryIdentity({
        canonicalKey: "github.com/acme/other",
        rootPath: "/Users/me/code/other",
      }),
    },
  ]);
  injectRemoteEnvironmentProjects(FLEET_REMOTE_ENVIRONMENT_ID, [
    {
      id: ProjectId.make("project-windows"),
      name: "Project",
      cwd: "C:\\code\\project",
      repositoryIdentity: projectRepositoryIdentity({ rootPath: "C:\\code\\project" }),
    },
  ]);
  // Mac mini's setups stream once it is connected and says it takes setups.
  await vi.waitFor(() => {
    expect(mac.subscribed()).toBe(true);
  });
  return { mounted, mac };
}

/** The project's menu in the sidebar, the way its ⋯ button opens it. */
async function openProjectMenuItem(label: string): Promise<void> {
  await page.getByTestId("inbox-scope-trigger").click();
  await page.getByRole("button", { name: "Manage Project" }).click();
  await page.getByRole("button", { name: label }).click();
}

function fileRows(): Array<{ path: string; checked: string | null }> {
  return [...document.querySelectorAll<HTMLElement>('[data-testid^="project-setup-file-"]')].map(
    (row) => ({
      path: row.dataset.testid!.slice("project-setup-file-".length),
      checked: row.dataset.checked ?? null,
    }),
  );
}

describe("ChatView (full app): setting a project up on another computer", () => {
  registerChatViewSuiteHooks();

  it("copies the project to the computer that lacks it, with the suggested files, and follows the job", async () => {
    const readFiles: Array<NormalizedWsRpcRequestBody> = [];
    const { mounted, mac } = await mountWithTwoComputers(readFiles);
    try {
      await openProjectMenuItem("Set up on another computer…");
      const dialog = page.getByTestId("project-setup-dialog");
      await expect.element(dialog).toMatchTextContent("Set up Project on another computer");
      // Windows PC has it already, so Mac mini is the one place it can go: no picker.
      expect(dialog.getByTestId("project-setup-target").elements()).toHaveLength(0);
      // Mac mini keeps its projects in ~/code, so the copy goes there too.
      await expect
        .element(dialog.getByTestId("project-setup-folder"))
        .toHaveValue("/Users/me/code/project");
      await expect
        .element(dialog.getByTestId("project-setup-destination"))
        .toHaveTextContent("A new folder.");
      expect(mac.inspectDestination).toHaveBeenLastCalledWith({
        path: "/Users/me/code/project",
        repositoryKey: PROJECT_SETUP_SOURCE.repositoryKey,
        remotes: PROJECT_SETUP_SOURCE.remotes,
      });

      // The suggested files come ticked and first; one too large can't be.
      expect(fileRows()).toEqual([
        { path: ".env", checked: "true" },
        { path: "apps/web/.env.local", checked: "true" },
        { path: "notes.txt", checked: "false" },
        { path: "fixtures/big.bin", checked: "false" },
      ]);
      await expect
        .element(dialog.getByTestId("project-setup-file-fixtures/big.bin"))
        .toMatchTextContent("Over 1 MB");
      await expect
        .element(dialog.getByTestId("project-setup-files-note"))
        .toHaveTextContent("Sent encrypted to Mac mini. Nothing else leaves this computer.");

      // It clones over the source's own protocol unless the user switches.
      await expect
        .element(dialog.getByTestId("project-setup-clone-url"))
        .toHaveTextContent("git@github.com:acme/project.git");
      await dialog.getByTestId("project-setup-protocol-https").click();
      await expect
        .element(dialog.getByTestId("project-setup-clone-url"))
        .toHaveTextContent("https://github.com/acme/project.git");

      // How much it will download, before Start and while it runs.
      await expect
        .element(dialog.getByTestId("project-setup-size"))
        .toHaveTextContent("About 50 MB to download.");
      await dialog.getByTestId("project-setup-start").click();
      await expect
        .element(dialog.getByTestId("project-setup-stage"))
        .toHaveTextContent("Downloading · 12%");
      await expect
        .element(dialog.getByTestId("project-setup-detail"))
        .toHaveTextContent("1.2 MB of about 50 MB · 600 KB/s");
      // The ticked files were read here, then went to Mac mini inside the start.
      expect(readFiles).toEqual([
        expect.objectContaining({ projectId: PROJECT_ID, paths: [".env", "apps/web/.env.local"] }),
      ]);
      expect(mac.start).toHaveBeenCalledTimes(1);
      const started = mac.start.mock.calls[0]![0] as ProjectSetupStartInput;
      expect(started).toEqual(
        expect.objectContaining({
          source: expect.objectContaining({
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
          }),
          repositoryKey: PROJECT_SETUP_SOURCE.repositoryKey,
          primaryRemoteName: "origin",
          protocol: "https",
          destinationPath: "/Users/me/code/project",
          files: READ_FILES,
        }),
      );

      // Mac mini says how it goes, then that it's done.
      mac.push([
        projectSetupJob({
          setupId: started.setupId,
          stage: "copying",
          updatedAt: isoAt(5),
        }),
      ]);
      await expect
        .element(dialog.getByTestId("project-setup-stage"))
        .toHaveTextContent("Copying files");
      mac.push([
        projectSetupJob({
          setupId: started.setupId,
          stage: "done",
          projectId: ProjectId.make("project-mac-copy"),
          warnings: ["Submodules didn't download. Run git submodule update there."],
          updatedAt: isoAt(9),
        }),
      ]);
      await expect
        .element(dialog.getByTestId("project-setup-done"))
        .toMatchTextContent("Project is ready on Mac mini");
      await expect
        .element(dialog.getByTestId("project-setup-warnings"))
        .toHaveTextContent("Submodules didn't download. Run git submodule update there.");
      await expect.element(dialog.getByTestId("project-setup-start-thread")).toBeEnabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("tells of a setup that failed in the background, and shows it again with Retry", async () => {
    const { mounted, mac } = await mountWithTwoComputers([]);
    try {
      await openProjectMenuItem("Set up on another computer…");
      const dialog = page.getByTestId("project-setup-dialog");
      await expect
        .element(dialog.getByTestId("project-setup-destination"))
        .toHaveTextContent("A new folder.");
      await dialog.getByTestId("project-setup-start").click();
      await expect
        .element(dialog.getByTestId("project-setup-stage"))
        .toHaveTextContent("Downloading · 12%");
      const started = mac.start.mock.calls[0]![0] as ProjectSetupStartInput;
      await dialog.getByTestId("project-setup-background").click();
      await expect.element(page.getByTestId("project-setup-dialog")).not.toBeInTheDocument();

      mac.push([
        projectSetupJob({
          setupId: started.setupId,
          stage: "failed",
          error:
            "Mac mini couldn't sign in to github.com. Sign in to GitHub on Mac mini, then Retry.",
          updatedAt: isoAt(9),
        }),
      ]);
      await expect.element(page.getByText("Couldn't set up Project on Mac mini")).toBeVisible();
      await page.getByRole("button", { name: "Show" }).click();
      const reopened = page.getByTestId("project-setup-dialog");
      await expect
        .element(reopened.getByTestId("project-setup-error"))
        .toMatchTextContent("Sign in to GitHub on Mac mini, then Retry.");
      await expect.element(reopened.getByTestId("project-setup-retry")).toBeEnabled();
      await reopened.getByTestId("project-setup-close").click();

      // Mac mini's Fleet page lists it too, and Dismiss clears it there.
      await mounted.router.navigate({
        to: "/fleet/$environmentId",
        params: { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID },
      });
      const row = page.getByTestId(`fleet-project-setup-${started.setupId}`);
      await expect.element(row).toMatchTextContent("Sign in to GitHub on Mac mini, then Retry.");
      await row.getByRole("button", { name: "Dismiss" }).click();
      await expect.element(row).not.toBeInTheDocument();
      expect(mac.dismiss).toHaveBeenCalledWith({ setupId: started.setupId });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers the setup from a new thread's Runs on picker, then moves the draft to the copy", async () => {
    // A new thread in the project, with words in it already.
    const draftId = DraftId.make("draft-project-setup");
    const logicalProjectKey = deriveLogicalProjectKey({
      environmentId: LOCAL_ENVIRONMENT_ID,
      id: PROJECT_ID,
      kind: "workspace",
      cwd: "/repo/project",
      repositoryIdentity: projectRepositoryIdentity(),
    });
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: ThreadId.make("thread-project-setup-draft"),
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: { [logicalProjectKey]: draftId },
    });
    useComposerDraftStore.getState().setPrompt(draftId, "Fix the login page");
    const { mounted, mac } = await mountWithTwoComputers([], { draftId });
    try {
      // The project is on this computer only, yet the picker shows: Mac mini can get a copy.
      await page.getByRole("combobox", { name: "Run on" }).click();
      await page.getByTestId("runs-on-set-up-elsewhere").click();
      const dialog = page.getByTestId("project-setup-dialog");
      await expect
        .element(dialog.getByTestId("project-setup-destination"))
        .toHaveTextContent("A new folder.");
      await dialog.getByTestId("project-setup-start").click();
      await expect
        .element(dialog.getByTestId("project-setup-stage"))
        .toHaveTextContent("Downloading · 12%");
      const started = mac.start.mock.calls[0]![0] as ProjectSetupStartInput;

      // Done, and Mac mini's new project reaches the app: the draft moves there, words and all.
      const copy = ProjectId.make("project-mac-copy");
      mac.push([
        projectSetupJob({
          setupId: started.setupId,
          stage: "done",
          projectId: copy,
          updatedAt: isoAt(9),
        }),
      ]);
      injectRemoteEnvironmentProjects(FLEET_OFFLINE_ENVIRONMENT_ID, [
        {
          id: copy,
          name: "Project",
          cwd: "/Users/me/code/project",
          repositoryIdentity: projectRepositoryIdentity({ rootPath: "/Users/me/code/project" }),
        },
      ]);
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          projectId: copy,
        });
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
        "Fix the login page",
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
