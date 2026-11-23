import { MessageId, ProviderInstanceId, type ThreadId, WS_METHODS } from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  PROJECT_ID,
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  dispatchInputKey,
  mountChatView,
  openCommandPaletteCommands,
  registerChatViewSuiteHooks,
  waitForCommandPaletteInput,
  waitForServerConfigToApply,
  wsRequests,
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

describe("ChatView (full app): bring in a Codex conversation", () => {
  registerChatViewSuiteHooks();

  it("opens a project-scoped Codex session browser and imports the selected conversation", async () => {
    const externalThreadsResult = {
      data: [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerThreadId: "native-codex-thread",
          sessionId: "native-codex-session",
          source: "cli" as const,
          name: "Finish parser migration",
          preview: "Finish the parser migration and verify its tests",
          cwd: "/repo/project",
          cliVersion: "0.145.0",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-03T12:00:00.000Z",
          status: "idle" as const,
          canImport: true,
        },
      ],
    };
    let resolveExternalThreads!: (value: typeof externalThreadsResult) => void;
    const externalThreadsPromise = new Promise<typeof externalThreadsResult>((resolve) => {
      resolveExternalThreads = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-external-codex-session" as MessageId,
        targetText: "external Codex session",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.6-sol",
                  name: "GPT-5.6 Sol",
                  isCustom: false,
                  isDefault: true,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.serverListExternalProviderThreads) {
          return externalThreadsPromise;
        }
        if (body._tag === WS_METHODS.serverImportExternalProviderThread) {
          return {
            threadId: (body as unknown as { readonly threadId: ThreadId }).threadId,
            importedMessageCount: 2,
          };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteCommands();
      const palette = page.getByTestId("command-palette");
      await expect
        .element(palette.getByText("Bring in Codex conversation…", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Bring in Codex conversation…", { exact: true }).click();
      await waitForCommandPaletteInput("Search other Codex conversations in Project...");
      const dialog = page.getByTestId("codex-import-dialog");

      await expect
        .element(dialog.getByTestId("command-palette-results-skeleton"))
        .toBeInTheDocument();
      resolveExternalThreads(externalThreadsResult);

      await expect
        .element(dialog.getByText("Finish parser migration", { exact: true }))
        .toBeInTheDocument();
      await expect
        .element(dialog.getByTestId("command-palette-results-skeleton"))
        .not.toBeInTheDocument();
      await expect
        .element(dialog.getByText("Codex CLI · Finish the parser migration and verify its tests"))
        .toBeInTheDocument();
      const requestedPaths: string[] = [];
      const stopRecording = mounted.router.subscribe("onBeforeNavigate", (event) => {
        requestedPaths.push(event.toLocation.pathname);
      });
      await dialog.getByText("Finish parser migration", { exact: true }).click();

      await vi.waitFor(
        () => {
          const listRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.serverListExternalProviderThreads,
          );
          expect(listRequest).toMatchObject({
            providerInstanceId: "codex",
            cwd: "/repo/project",
            limit: 20,
          });
          const importRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.serverImportExternalProviderThread,
          );
          expect(importRequest).toMatchObject({
            providerInstanceId: "codex",
            providerThreadId: "native-codex-thread",
            projectId: PROJECT_ID,
            modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
            runtimeMode: "full-access",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      // The session that started the import is still open, so it closes and
      // asks for the new thread.
      const importedThreadId = (
        wsRequests.find(
          (request) => request._tag === WS_METHODS.serverImportExternalProviderThread,
        ) as unknown as { readonly threadId: ThreadId }
      ).threadId;
      await expect.element(dialog).not.toBeInTheDocument();
      await vi.waitFor(
        () => {
          expect(requestedPaths.some((path) => path.endsWith(`/${importedThreadId}`))).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      stopRecording();
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks which Codex account first when there are two, and goes back to the choice", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-codex-import-two-accounts" as MessageId,
        targetText: "codex import two accounts",
      }),
      configureFixture: (nextFixture) => {
        const codex = {
          ...nextFixture.serverConfig.providers[0]!,
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              isDefault: true,
              capabilities: createModelCapabilities({ optionDescriptors: [] }),
            },
          ],
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            { ...codex, displayName: "Codex Personal" },
            {
              ...codex,
              instanceId: ProviderInstanceId.make("codex-work"),
              displayName: "Codex Work",
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.serverListExternalProviderThreads) {
          return { data: [] };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteCommands();
      await page
        .getByTestId("command-palette")
        .getByText("Bring in Codex conversation…", { exact: true })
        .click();
      const dialog = page.getByTestId("codex-import-dialog");
      await waitForCommandPaletteInput("Choose a Codex account...");
      await expect.element(dialog.getByText("Codex Personal", { exact: true })).toBeInTheDocument();
      await dialog.getByText("Codex Work", { exact: true }).click();

      await waitForCommandPaletteInput("Search other Codex conversations in Project...");
      await vi.waitFor(
        () => {
          expect(
            wsRequests.find(
              (request) => request._tag === WS_METHODS.serverListExternalProviderThreads,
            ),
          ).toMatchObject({ providerInstanceId: "codex-work", cwd: "/repo/project" });
        },
        { timeout: 8_000, interval: 16 },
      );

      const searchInput = await waitForCommandPaletteInput(
        "Search other Codex conversations in Project...",
      );
      await dispatchInputKey(searchInput, { key: "Backspace" });
      await waitForCommandPaletteInput("Choose a Codex account...");
    } finally {
      await mounted.cleanup();
    }
  });
});
