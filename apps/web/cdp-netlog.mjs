import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
page.on("requestfailed", (r) => console.log("[FAIL]", r.method(), r.url().slice(0, 90), "->", r.failure()?.errorText));
page.on("response", (r) => { if (r.url().includes("13773")) console.log("[resp]", r.status(), r.url().slice(0, 90)); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
console.log("body:", JSON.stringify(await page.evaluate(() => document.body.innerText.slice(0, 80))));
await browser.close();
