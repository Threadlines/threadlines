import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
if (!page) { console.log("no page"); process.exit(1); }
await page.waitForTimeout(4000);
const body = await page.evaluate(() => document.body.innerText.slice(0, 200));
if (body.includes("Something went wrong")) {
  console.log("error state, clicking Try again");
  await page.getByText("Try again").click().catch(() => {});
  await page.waitForTimeout(6000);
}
console.log("state:", JSON.stringify((await page.evaluate(() => document.body.innerText.slice(0, 150)))));

async function clickAndMeasure(name, loc) {
  const n = await loc.count().catch(() => 0);
  if (n === 0) { console.log("SKIP", name); return; }
  const t0 = Date.now();
  await loc.first().click({ timeout: 8000 }).catch((e) => console.log(name, "click failed:", String(e).slice(0, 80)));
  await page.waitForFunction(
    () => new Promise((r) => { const s = performance.now(); requestAnimationFrame(() => r(performance.now() - s < 60)); }),
    { timeout: 30000, polling: 120 },
  ).catch(() => console.log(name, "settle timeout"));
  console.log(`MEASURE ${name}: wall=${Date.now() - t0}ms`);
}
await clickAndMeasure("thread-scroll-test", page.locator("a, button").filter({ hasText: "Generate Scroll Test Text" }).last());
await page.waitForTimeout(400);
await clickAndMeasure("thread-markdown", page.locator("a, button").filter({ hasText: "Edit or create test markdown" }).last());
await page.waitForTimeout(400);
await clickAndMeasure("settings", page.getByRole("button", { name: /settings/i }));
await page.waitForTimeout(400);
await clickAndMeasure("thread-revert", page.locator("a, button").filter({ hasText: "Test thread-specific revert" }).last());
await browser.close();
