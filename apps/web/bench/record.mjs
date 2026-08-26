// Records a clip of the streaming benchmark and prints its numbers.
//
//   node bench/record.mjs <label> [--url http://localhost:5799/bench/stream.html] [--cpu 4]
//
// Writes bench/output/<label>.webm and bench/output/<label>.json. `--cpu N`
// throttles the CPU N× so a fast dev box behaves like a slow laptop.
// Needs a Vite dev server for apps/web on the given URL.
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const label = args.find((arg) => !arg.startsWith("--")) ?? "run";
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const url = readFlag("url", "http://localhost:5799/bench/stream.html");
const cpuRate = Number(readFlag("cpu", "1"));

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "output");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 960, height: 720 },
  colorScheme: "dark",
  recordVideo: { dir: outDir, size: { width: 960, height: 720 } },
});
const page = await context.newPage();
if (cpuRate > 1) {
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
}

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('[data-bench-status="done"]', { timeout: 120_000 });
const result = await page.evaluate(() => window.__streamBench);
await page.waitForTimeout(500);

const video = page.video();
await context.close();
await browser.close();

const recordedPath = await video.path();
const videoPath = path.join(outDir, `${label}.webm`);
await rename(recordedPath, videoPath);
await writeFile(
  path.join(outDir, `${label}.json`),
  JSON.stringify({ label, cpuRate, ...result }, null, 2),
);

console.log(JSON.stringify({ label, cpuRate, ...result }));
console.log(`video: ${videoPath}`);
console.log(`files: ${(await readdir(outDir)).join(", ")}`);
