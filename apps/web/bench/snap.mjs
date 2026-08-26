// Screenshots the bench page mid-stream: node bench/snap.mjs <label> --url <u> --at 1500,3000,5000
import { chromium } from "playwright";
const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith("--")) ?? "snap";
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const url = flag("url", "http://localhost:5798/bench/stream.html");
const ats = flag("at", "1500,3000,5000").split(",").map(Number);
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 960, height: 720 }, colorScheme: "dark" });
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
const t0 = Date.now();
await p.goto(url);
for (const at of ats) {
  const wait = at - (Date.now() - t0);
  if (wait > 0) await p.waitForTimeout(wait);
  await p.screenshot({ path: `bench/output/${label}-${at}.png` });
}
await b.close();
