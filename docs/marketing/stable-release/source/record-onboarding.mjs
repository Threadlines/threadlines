// Recreated first-run state in the owned release renderer. No installs, sign-ins,
// provider turns, or real user data. Reloading the renderer clears this fixture.
import { connect } from "./capture-session.mjs";
const { page, browser, record, click, move, pause } = await connect();
try {
  if (process.argv.includes("--clear")) {
    await page.evaluate(() => window.onboardingCapture?.stop());
    await page.reload();
    console.log("Onboarding renderer fixture cleared by reload.");
  }
  if (process.argv.includes("--stage")) {
    console.log(
      await page.evaluate(async () => {
        if (location.origin !== "http://127.0.0.1:6039") throw new Error("Wrong capture renderer");
        window.threadlinesCaptureStates?.stop();
        const [{ useStore }, config, setup, api, runtime, discoveryState] = await Promise.all([
          import("/src/store.ts"),
          import("/src/rpc/serverState.ts"),
          import("/src/components/chat/firstRunSetup.ts"),
          import("/src/environmentApi.ts"),
          import("/src/environments/runtime/service.ts"),
          import("/src/lib/sourceControlDiscoveryState.ts"),
        ]);
        const state = useStore.getState();
        const environmentId = state.activeEnvironmentId;
        const baseline = state.environmentStateById[environmentId];
        const project = Object.values(baseline.projectById).find((p) => p.name === "Threadlines");
        if (
          !project?.cwd
            .replaceAll("\\", "/")
            .startsWith("C:/Users/Public/Documents/Threadlines Release Studio/")
        )
          throw new Error("Not the owned studio");
        const serverConfig = config.getServerConfig();
        const originalApi = api.readEnvironmentApi(environmentId);
        const blocked = async () => {
          throw new Error("Onboarding capture blocks external actions");
        };
        const connection = runtime.requireEnvironmentConnection(environmentId);
        const discovery = await connection.client.server.discoverSourceControl();
        const safeDiscovery = {
          ...discovery,
          sourceControlProviders: discovery.sourceControlProviders.map((p) => ({
            ...p,
            auth: {
              ...p.auth,
              status: "unauthenticated",
              account: { _tag: "None" },
              host: { _tag: "None" },
              detail: { _tag: "None" },
            },
          })),
        };
        connection.client.server.discoverSourceControl = async () => safeDiscovery;
        connection.client.server.updateProvider = blocked;
        connection.client.server.updateSourceControlTool = blocked;
        connection.client.server.startGitHubAuth = blocked;
        connection.client.providerAuth.start = blocked;
        discoveryState.sourceControlDiscoveryManager.storeResult({ key: "primary" }, safeDiscovery);
        api.__setEnvironmentApiOverrideForTests(environmentId, {
          ...originalApi,
          orchestration: { ...originalApi.orchestration, dispatchCommand: blocked },
        });
        localStorage.removeItem(setup.FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY);
        setup.useFirstRunSetupDismissalStore.setState({ dismissedKeys: new Set() });
        const providers = serverConfig.providers
          .filter((p) => ["codex", "claudeAgent"].includes(p.driver))
          .map((p) => ({
            ...p,
            enabled: true,
            status: p.driver === "codex" ? "ready" : "error",
            installed: p.driver === "codex",
            version: p.driver === "codex" ? p.version : null,
            auth: p.driver === "codex" ? { status: "authenticated" } : { status: "unknown" },
            versionAdvisory:
              p.driver === "codex"
                ? undefined
                : {
                    status: "unknown",
                    currentVersion: null,
                    latestVersion: null,
                    updateCommand: null,
                    canUpdate: false,
                    installCommand: "npm install -g @anthropic-ai/claude-code@latest",
                    canInstall: true,
                    checkedAt: null,
                    message: null,
                  },
          }));
        config.setServerConfigSnapshot({ ...serverConfig, providers });
        const apply = () =>
          useStore.setState((s) => ({
            environmentStateById: {
              ...s.environmentStateById,
              [environmentId]: {
                ...s.environmentStateById[environmentId],
                projectIds: [project.id],
                projectById: { [project.id]: project },
                threadIds: [],
                threadShellById: {},
                threadSessionById: {},
                threadTurnStateById: {},
                sidebarThreadSummaryById: {},
                messageByThreadId: {},
                activityByThreadId: {},
                activityIdsByThreadId: {},
              },
            },
          }));
        apply();
        const timer = setInterval(apply, 1000);
        window.onboardingCapture = {
          stop() {
            clearInterval(timer);
          },
        };
        await window.__TSR_ROUTER__.navigate({ to: "/" });
        return {
          fixture: "One ready provider, one optional install; existing folder; no history",
          project: project.name,
        };
      }),
    );
    await pause(1800);
  }
  if (process.argv.includes("--inspect")) {
    console.log(await page.locator("body").innerText());
    console.log(
      await page
        .locator("button")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({ label: n.getAttribute("aria-label"), text: n.textContent.trim() })),
        ),
    );
  }
  if (process.argv.includes("--record")) {
    await record("onboarding-first-thread-1", async () => {
      await pause(2800);
      await move(page.getByRole("button", { name: /^Install Claude/ }));
      await pause(2400);
      await move(page.getByText("You can start once one agent is signed in.", { exact: true }));
      await pause(2200);
      await move(page.getByTestId("first-run-setup-start"));
      await pause(900);
      await click(page.getByTestId("first-run-setup-start"), 2000);
      const composer = page.locator('[contenteditable="true"]').first();
      await click(composer, 500);
      await composer.pressSequentially("Help me update the Threadlines release page.", {
        delay: 55,
      });
      await pause(4200);
    });
  }
} finally {
  await browser.close();
}
