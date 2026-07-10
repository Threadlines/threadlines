import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
console.log("url:", page.url());
console.log("body:", JSON.stringify(await page.evaluate(() => document.body.innerText.slice(0, 250))));
const probe = await page.evaluate(async () => {
  try { const r = await fetch("http://127.0.0.1:14607/api/auth/session", { credentials: "include" }); return "status " + r.status; } catch (e) { return "ERR " + e; }
});
console.log("backend fetch:", probe);
await browser.close();
