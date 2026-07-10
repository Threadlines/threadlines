import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
page.on("console", (m) => { if (m.type() === "error") console.log("[err]", m.text().slice(0, 180)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 180)));
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => document.body.innerText.slice(0, 120));
  console.log(`t+${(i + 1) * 3}s:`, JSON.stringify(t.slice(0, 100)));
  if (t.length > 10) break;
}
await page.screenshot({ path: "/tmp/tl-x-state.png" });
await browser.close();
