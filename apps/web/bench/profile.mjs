// CPU-profiles one benchmark run and prints the functions with the most self time.
//
//   node bench/profile.mjs [--url <bench url>] [--cpu 4] [--top 30]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const url = readFlag("url", "http://localhost:5799/bench/stream.html");
const cpuRate = Number(readFlag("cpu", "1"));
const top = Number(readFlag("top", "30"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 720 }, colorScheme: "dark" });
const cdp = await page.context().newCDPSession(page);
if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.send("Profiler.start");
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('[data-bench-status="done"]', { timeout: 180_000 });
const result = await page.evaluate(() => window.__streamBench);
const { profile } = await cdp.send("Profiler.stop");
await browser.close();

const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const selfMs = new Map();
for (let i = 0; i < profile.samples.length; i += 1) {
  const node = byId.get(profile.samples[i]);
  const dt = (profile.timeDeltas[i] ?? 0) / 1000;
  const frame = node.callFrame;
  const file = frame.url.replace(/^.*\/(node_modules|src)\//, "$1/").replace(/\?.*$/, "");
  const key = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`;
  selfMs.set(key, (selfMs.get(key) ?? 0) + dt);
}
const total = [...selfMs.values()].reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify({
    stalls: result.stalls,
    worstFrameMs: result.worstFrameMs,
    longTaskLog: result.longTaskLog,
  }),
);
console.log(`total sampled ${Math.round(total)}ms; top ${top} by self time:`);
for (const [key, ms] of [...selfMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${String(Math.round(ms)).padStart(6)}ms  ${key}`);
}
