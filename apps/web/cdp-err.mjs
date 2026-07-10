import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
await page.getByText("Show error details").click().catch(() => {});
await page.waitForTimeout(500);
console.log("details:", JSON.stringify(await page.evaluate(() => document.body.innerText.slice(0, 1200))));
const probe = await page.evaluate(async () => {
  const out = {};
  out.bridge = typeof window.desktopBridge;
  try { out.bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap?.() ?? null; } catch (e) { out.bootstrap = "ERR " + e; }
  try { const r = await fetch("http://127.0.0.1:14601/api/auth/session", { credentials: "include" }); out.fetch14601 = r.status; } catch (e) { out.fetch14601 = "ERR " + e; }
  return out;
});
console.log(JSON.stringify(probe, null, 2).slice(0, 1500));
await browser.close();
