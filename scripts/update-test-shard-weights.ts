// @effect-diagnostics nodeBuiltinImport:off - a maintenance script with no Effect
// runtime; it shells out to gh and reads and writes files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Rewrites a sharded suite's weights (see scripts/lib/test-shards.ts) from the
 * per-file timings its CI shards uploaded. Reads the newest three green CI runs
 * on main (or the run ids given after the suite) and keeps each file's median,
 * since one file's time can swing by a third between runs; files missing from
 * the newest run are dropped. Local runs make poor weights: the server's
 * git-heavy files run several times slower on a Mac than on CI's Linux
 * runners. Needs a signed-in `gh`.
 *
 * Run with `node --run test:shard-weights -- <server|browser> [run-id ...]`.
 */

const SUITES = {
  server: { artifacts: "server-test-timings-*", weights: "apps/server/vitest.shard-weights.json" },
  browser: {
    artifacts: "browser-test-timings-*",
    weights: "apps/web/vitest.browser.shard-weights.json",
  },
} as const;
const TIMINGS_FILE = "test-timings.json";
const RUNS_TO_READ = 3;

const suiteName = process.argv[2];
if (suiteName !== "server" && suiteName !== "browser") {
  throw new Error("Usage: node --run test:shard-weights -- <server|browser> [run-id ...]");
}
const suite = SUITES[suiteName];
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const gh = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const givenRunIds = process.argv.slice(3);
const runIds =
  givenRunIds.length > 0
    ? givenRunIds
    : gh([
        "run",
        "list",
        "--workflow=ci.yml",
        "--branch=main",
        "--event=push",
        "--status=success",
        `--limit=${RUNS_TO_READ}`,
        "--json=databaseId",
        "--jq=.[].databaseId",
      ])
        .split("\n")
        .filter(Boolean);
if (runIds.length === 0) {
  throw new Error("Found no green CI run on main to read test timings from.");
}

const downloadDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "threadlines-shard-weights-"),
);
// One map of file -> seconds per run, newest run first.
const runs: Array<Map<string, number>> = [];
try {
  for (const runId of runIds) {
    const runDir = NodePath.join(downloadDir, runId);
    gh(["run", "download", runId, `--pattern=${suite.artifacts}`, `--dir=${runDir}`]);
    const reports = NodeFS.readdirSync(runDir, { recursive: true, encoding: "utf8" }).filter(
      (entry) => NodePath.basename(entry) === TIMINGS_FILE,
    );
    if (reports.length === 0) {
      throw new Error(`CI run ${runId} has no ${suiteName} test timings.`);
    }
    const timings = new Map<string, number>();
    for (const entry of reports) {
      const report: Record<string, number> = JSON.parse(
        NodeFS.readFileSync(NodePath.join(runDir, entry), "utf8"),
      );
      for (const [file, seconds] of Object.entries(report)) timings.set(file, seconds);
    }
    runs.push(timings);
    console.log(`Read ${reports.length} shard reports from CI run ${runId}.`);
  }
} finally {
  NodeFS.rmSync(downloadDir, { recursive: true, force: true });
}

const median = (values: ReadonlyArray<number>): number => {
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const value =
    ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
  return Math.round(value * 10) / 10;
};
const [newest, ...older] = runs;
const sorted = [...newest!.keys()].toSorted().map((file) => {
  const samples = [newest!.get(file)!, ...older.flatMap((run) => run.get(file) ?? [])];
  return [file, median(samples)] as const;
});
NodeFS.writeFileSync(
  NodePath.join(repoRoot, suite.weights),
  `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`,
);
console.log(`Recorded ${sorted.length} files in ${suite.weights}.`);
