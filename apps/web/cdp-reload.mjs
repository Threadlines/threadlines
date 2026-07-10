import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5733"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
console.log("body:", JSON.stringify(await page.evaluate(() => document.body.innerText.slice(0, 300))));
await browser.close();
