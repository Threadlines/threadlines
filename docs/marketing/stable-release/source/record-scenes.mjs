import { connect } from "./capture-session.mjs";
const scene = process.argv[2];
const take = process.argv[3] || `refresh-${scene}-${Date.now()}`;
const { page, browser, record, click, move, pause } = await connect();
const button = (name) => page.getByRole("button", { name, exact: true });
const tab = (name) => page.getByRole("tab", { name, exact: true });
try {
  const terminal = button("Toggle terminal drawer");
  if ((await terminal.count()) && (await terminal.getAttribute("aria-pressed")) === "true")
    await terminal.click();
  if (await page.getByRole("textbox", { name: "Terminal input", exact: true }).isVisible())
    throw new Error("Close the terminal drawer before recording this scene.");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    localStorage.setItem("threadlines:theme", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "threadlines:theme", newValue: "dark" }),
    );
  });
  await record(take, async () => {
    switch (scene) {
      case "workspace":
        await click(button("Checks"), 1250);
        await page.keyboard.press("Escape");
        await pause(350);
        await click(button("Open diff for docs/stable-release.md"), 1000);
        await click(button("Previous file"), 1100);
        await click(tab("Source"), 700);
        break;
      case "source-control":
        await click(button("Open diff for docs/stable-release.md"), 1300);
        await click(button("Previous file"), 1500);
        await click(tab("Source"), 700);
        break;
      case "files":
        await click(button("Browse project files"), 400);
        if (!(await button("stable-release.md").count())) await click(button("docs"), 300);
        await click(button("stable-release.md").last(), 950);
        await click(button("Edit file"), 800);
        await click(button("Close file viewer"), 700);
        break;
      case "inbox":
        await click(button("Wrapped (2)"), 700);
        await click(button("Wrapped (2)"), 650);
        await move(button("#301 PR open: Refresh the release page and review flow").first());
        await pause(1100);
        await click(button("All projects"), 1600);
        await page.keyboard.press("Escape");
        break;
      case "git-history":
        await click(
          page.getByRole("button", { name: /^Commit .*docs: clarify the final review steps/ }),
          1400,
        );
        await click(tab("Source"), 400);
        await click(
          page.getByRole("button", { name: /^Commit .*docs: outline the review workflow/ }),
          1400,
        );
        await click(tab("Source"), 450);
        break;
      case "pull-requests":
        await click(tab("Code 2"), 1300);
        await click(button("Fix this finding with an agent"), 1400);
        await click(button("Checks"), 2400);
        break;
      case "activity":
        await click(button("Thread activity"), 900);
        await click(button("Show all 4 steps"), 1250);
        await page.keyboard.press("Escape");
        await click(button("Open Layout review transcript"), 1300);
        await page.keyboard.press("Escape");
        break;
      case "context":
        await click(
          page.getByRole("dialog", { name: "Project files" }).locator('[data-column-number="3"]'),
          850,
        );
        await click(button("Add selection to chat"), 1100);
        await move(page.getByRole("textbox").first());
        await page
          .getByRole("textbox")
          .first()
          .pressSequentially("Check the review order on this line.", { delay: 45 });
        await pause(1000);
        break;
      case "provider-switch":
        await click(button("GPT-5.6-Sol"), 850);
        await click(tab("Claude"), 1300);
        await click(
          page.getByRole("option", { name: "Fable 5.1 Add to favorites Ctrl+2", exact: true }),
          1500,
        );
        break;
      case "browser":
        await click(button("Browser options"), 250);
        await click(page.getByRole("menuitem", { name: "Find in page", exact: true }), 300);
        await page
          .getByRole("textbox", { name: "Find in page", exact: true })
          .pressSequentially("Manuals", { delay: 90 });
        await pause(850);
        await click(button("Close find"), 300);
        await click(button("Capture screenshot"), 1300);
        await click(button("Close browser"), 1500);
        break;
      default:
        throw new Error("Scene not yet rehearsed: " + scene);
    }
  });
  if (scene === "pull-requests") await page.keyboard.press("Escape");
} finally {
  await browser.close();
}
