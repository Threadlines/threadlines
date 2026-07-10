import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const contexts = browser.contexts();
let page = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    const u = p.url();
    if (u.includes("localhost:5733")) page = p;
  }
}
if (!page) { console.log("pages:", contexts.flatMap((c) => c.pages().map((p) => p.url()))); process.exit(1); }
console.log("attached to", page.url());
await page.waitForTimeout(6000);

async function clickAndMeasure(name, loc) {
  const n = await loc.count().catch(() => 0);
  if (n === 0) { console.log("SKIP", name); return; }
  const t0 = Date.now();
  await loc.first().click({ timeout: 8000 }).catch((e) => console.log(name, "click failed:", String(e).slice(0, 100)));
  await page.waitForFunction(
    () => new Promise((r) => { const s = performance.now(); requestAnimationFrame(() => r(performance.now() - s < 60)); }),
    { timeout: 30000, polling: 120 },
  ).catch(() => console.log(name, "settle timeout"));
  console.log(`MEASURE ${name}: wall=${Date.now() - t0}ms`);
}

await clickAndMeasure("thread-scroll-test", page.locator("a, button").filter({ hasText: "Generate Scroll Test Text" }).last());
await page.waitForTimeout(500);
await clickAndMeasure("thread-markdown", page.locator("a, button").filter({ hasText: "Edit or create test markdown" }).last());
await page.waitForTimeout(500);
await clickAndMeasure("settings", page.getByRole("button", { name: /settings/i }));
await page.waitForTimeout(500);
await clickAndMeasure("thread-revert", page.locator("a, button").filter({ hasText: "Test thread-specific revert changes" }).last());
await browser.close();
