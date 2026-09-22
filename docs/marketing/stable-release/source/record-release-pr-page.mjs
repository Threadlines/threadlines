// Operates only the owned release studio; never sends a provider turn.
import { connect } from "./capture-session.mjs";
const { page, browser, record, click, move, pause } = await connect();
try {
  // Validate the active fixture before navigation, draft edits, or recorded input.
  // A known port alone does not prove that this is still the owned demo state.
  if (!process.argv.includes("--inspect")) {
    await page.evaluate(async (recording) => {
      const root = "C:/Users/Public/Documents/Threadlines Release Studio";
      const fixture = window.threadlinesCaptureStates;
      if (
        location.origin !== "http://127.0.0.1:6039" ||
        fixture?.kind !== "release-pr-page" ||
        fixture.captureRoot !== root ||
        !(fixture.expiresAt > Date.now()) ||
        typeof fixture.setCheckState !== "function"
      ) {
        throw new Error("Stage the owned PR page capture fixture before changing the UI.");
      }
      const { useStore } = await import("/src/store.ts");
      const state = useStore.getState();
      const environment = state.environmentStateById[fixture.environmentId];
      const thread = environment?.threadShellById[fixture.threadId];
      const project = thread && environment.projectById[thread.projectId];
      if (
        state.activeEnvironmentId !== fixture.environmentId ||
        project?.cwd?.replaceAll("\\", "/") !== `${root}/Threadlines` ||
        (recording && !location.pathname.split("/").includes(fixture.threadId))
      ) {
        throw new Error("Open the staged release thread in the owned studio before recording.");
      }
    }, process.argv.includes("--record"));
  }
  if (process.argv.includes("--inspect")) {
    console.log(await page.locator("body").innerText());
    console.log(
      await page.locator('button, a, [role="tab"]').evaluateAll((nodes) =>
        nodes.map((n) => ({
          tag: n.tagName,
          role: n.getAttribute("role"),
          label: n.getAttribute("aria-label"),
          text: n.textContent.trim().slice(0, 100),
        })),
      ),
    );
  } else if (process.argv.includes("--reset")) {
    await page.goto("http://127.0.0.1:6039/pull-requests?state=open");
    await page.getByTestId("pull-requests-view").waitFor({ state: "visible" });
    console.log("Pull Requests page ready");
  } else if (process.argv.includes("--page")) {
    await page.getByRole("button", { name: /^Pull Requests/ }).click();
    await pause(800);
    console.log(await page.locator("body").innerText());
  } else if (process.argv.includes("--open")) {
    await page.getByTestId("pull-requests-row").click();
    await pause(800);
    console.log(await page.locator("body").innerText());
    console.log(
      await page.locator("button").evaluateAll((nodes) =>
        nodes.map((n) => ({
          label: n.getAttribute("aria-label"),
          text: n.textContent.trim().slice(0, 90),
        })),
      ),
    );
  } else if (process.argv.includes("--failure")) {
    await page.evaluate(() => window.threadlinesCaptureStates.setCheckState("failure"));
    await pause(500);
    await page
      .getByRole("button", { name: "Fix Browser tests with an agent", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Message" })
      .waitFor({ state: "visible", timeout: 1500 })
      .catch(() => {});
    await pause(2500);
    console.log(await page.locator("body").innerText());
  } else if (process.argv.includes("--record")) {
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill("");
    const closeAgents = page.getByRole("button", { name: "Close Agents", exact: true });
    if (await closeAgents.isVisible()) await closeAgents.click();
    await page.evaluate(() => window.threadlinesCaptureStates.setCheckState("pending"));
    await pause(800);
    await record("release-pr-page-03", async () => {
      await pause(1100);
      await click(page.getByRole("button", { name: /^Pull Requests/ }), 1600);
      await page.getByTestId("pull-requests-view").waitFor({ state: "visible" });
      const close = page.getByRole("button", { name: "Close pull request details", exact: true });
      if (await close.isVisible()) await click(close, 450);
      await click(page.getByTestId("pull-requests-row"), 1400);
      await page.getByRole("tab", { name: "Summary", exact: true }).waitFor({ state: "visible" });
      await click(page.getByRole("button", { name: "1 of 6 running", exact: true }), 4200);
      await page.evaluate(() => window.threadlinesCaptureStates.setCheckState("failure"));
      await pause(2400);
      const fix = page.getByRole("button", {
        name: "Fix Browser tests with an agent",
        exact: true,
      });
      await move(fix, 700);
      await pause(1100);
      await click(fix, 2500);
      await editor.waitFor({ state: "visible" });
      if (!(await editor.innerText()).includes("Failing check:"))
        throw new Error("Failure context missing");
      await click(editor, 1000);
      await page.keyboard.press("Control+Home");
      await page.keyboard.type("Please fix this failing browser check.", { delay: 55 });
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.press("Shift+Enter");
      await pause(4200);
    });
  } else {
    throw new Error("Recording flow not rehearsed yet");
  }
} finally {
  await browser.close();
}
