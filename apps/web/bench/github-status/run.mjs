// GitHub pull request status benchmark: how fresh and how in step the app's
// surfaces are, and how many `gh` runs that costs. See README.md.
//
//   node bench/github-status/run.mjs [--scenarios A,B,C,D,F] [--runs 3] [--cap 660]
//       [--away 90] [--stagger 90] [--jitter 60] [--startup 3] [--transition 2]
//       [--steady 10] [--latency 400] [--port 14931] [--out <file>] [--keep]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, createStack, ghRate } from "./lib.mjs";
import { printSummary } from "./report.mjs";
import { scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF } from "./scenarios.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const scenarios = flag("scenarios", "A,B,C,D,F")
  .split(",")
  .map((name) => name.trim().toUpperCase())
  .filter(Boolean)
  // E measures a quiet app, so it goes before anything that adds threads.
  .toSorted((a, b) => (a === "E" ? -1 : b === "E" ? 1 : a.localeCompare(b)));
const options = {
  runs: Number(flag("runs", "3")),
  capSeconds: Number(flag("cap", "660")),
  awaySeconds: Number(flag("away", "90")),
  staggerSeconds: Number(flag("stagger", "90")),
  jitterSeconds: Number(flag("jitter", "60")),
  startupMinutes: Number(flag("startup", "3")),
  transitionMinutes: Number(flag("transition", "2")),
  steadyMinutes: Number(flag("steady", "10")),
  latencyMs: Number(flag("latency", "400")),
  port: Number(flag("port", "14931")),
  scenarios,
};
const runOptions = {
  ...options,
  capMs: options.capSeconds * 1000,
  awayMs: options.awaySeconds * 1000,
  staggerMs: options.staggerSeconds * 1000,
  jitterMs: options.jitterSeconds * 1000,
};
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const out = flag(
  "out",
  path.join(fs.realpathSync(os.tmpdir()), `tl-ghbench-results-${stamp}.json`),
);
const keep = args.includes("--keep");

const gitOut = (...gitArgs) => {
  try {
    return execFileSync("git", gitArgs, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const results = {
  meta: {
    commit: gitOut("rev-parse", "--short", "HEAD"),
    branch: gitOut("rev-parse", "--abbrev-ref", "HEAD"),
    startedAt: new Date().toISOString(),
    options,
  },
  scenarios: {},
};
const save = () => {
  try {
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(`could not save results to ${out}:`, error);
  }
};

/** What the fake gh saw over the whole run; read after the server has stopped. */
function recordGhCalls(stack) {
  try {
    const calls = stack.readGhCalls();
    results.ghCallsTotal = calls.length;
    results.unknownGhCalls = calls.filter((call) => call.kind === "UNKNOWN");
    results.failedGhCalls = calls
      .filter((call) => call.exit !== 0 && call.exit !== null && call.kind !== "UNKNOWN")
      .slice(0, 50);
    // Started and never answered: the server gave up on them (or stopped).
    results.unfinishedGhCalls = calls.filter((call) => call.kind === "unfinished").slice(0, 50);
    results.refusedSsh = stack
      .readGitRemoteCalls()
      .filter((call) => call.service === "refused-ssh");
    rereadWindows(results.scenarios, calls);
  } catch (error) {
    results.ghCallsError = String(error);
  }
}

/**
 * Reads every saved window's `gh` rates again from the final log, which has
 * an answer for calls that were still running when the window was saved.
 */
function rereadWindows(node, calls) {
  if (Array.isArray(node)) {
    for (const item of node) rereadWindows(item, calls);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const rate = (window) => ghRate(calls, window.from, window.to);
  if (node.ghWindow) node.ghAllClients = rate(node.ghWindow);
  if (node.awayGhWindow) node.ghAway = rate(node.awayGhWindow);
  if (node.returnGhWindow) node.ghAfterReturn = rate(node.returnGhWindow);
  if (node.firstWindow && node.steadyWindow) {
    node[node.mode === "focused" ? "startup" : "transition"] = rate(node.firstWindow);
    node.steady = rate(node.steadyWindow);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "changes" && key !== "before" && key !== "final") rereadWindows(value, calls);
  }
}

const stack = await createStack(runOptions);
console.log(`stack: ${stack.root}\nresults: ${out}`);
let failed = null;
// Stopping the run stops what it started, then keeps what it measured so far.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stack.close().finally(() => {
      results.error = `stopped by ${signal}`;
      recordGhCalls(stack);
      save();
      process.exit(130);
    });
  });
}
try {
  stack.addRepo("bench/alpha");
  stack.addRepo("bench/beta");
  await stack.startServer();
  await stack.openBrowser();
  await stack.createProject("bench/alpha");
  await stack.createProject("bench/beta");
  results.meta.setupDoneAt = new Date().toISOString();
  const home = { threadId: await stack.createThread({ slug: "bench/alpha", title: "Home" }) };
  const table = {
    A: scenarioA,
    B: scenarioB,
    C: scenarioC,
    D: scenarioD,
    E: scenarioE,
    F: scenarioF,
  };
  for (const name of scenarios) {
    const scenario = table[name];
    if (!scenario) throw new Error(`no scenario ${name}`);
    const startedAt = Date.now();
    console.log(`\n== scenario ${name}`);
    const scenarioOut = { startedAt: new Date(startedAt).toISOString() };
    results.scenarios[name] = scenarioOut;
    await scenario(stack, runOptions, { out: scenarioOut, save, home });
    scenarioOut.minutes = Number(((Date.now() - startedAt) / 60_000).toFixed(1));
    save();
  }
} catch (error) {
  failed = error;
  results.error = String(error?.stack ?? error);
} finally {
  await stack.close();
  recordGhCalls(stack);
  save();
  if (keep) console.log(`kept ${stack.root}`);
  else fs.rmSync(stack.root, { recursive: true, force: true });
}
console.log(`\n${printSummary(results)}\n\nresults: ${out}`);
if (failed) {
  console.error(failed);
  process.exitCode = 1;
} else if ((results.unknownGhCalls?.length ?? 0) > 0) {
  console.error(
    `${results.unknownGhCalls.length} gh requests the fake did not understand; see results.`,
  );
  process.exitCode = 2;
}
