import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
for (const url of ["http://127.0.0.1:14607/api/auth/session", "http://localhost:14607/api/auth/session", "http://localhost:5733/", "https://example.com/"]) {
  const r = await page.evaluate(async (u) => { try { const x = await fetch(u, { mode: "no-cors" }); return "ok " + x.status; } catch (e) { return "ERR"; } }, url);
  console.log(url, "->", r);
}
await browser.close();
