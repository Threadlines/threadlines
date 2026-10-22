// @effect-diagnostics nodeBuiltinImport:off - a maintenance script with no Effect
// runtime; it shells out to gh and reads and writes files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Rewrites a sharded suite's weights (see scripts/lib/test-shards.ts) from the
 * per-file timings its CI shards uploaded: from the newest green CI run on
 * main, or the run id given after the suite. Local runs make poor weights:
 * the server's git-heavy files run several times slower on a Mac than on CI's
 * Linux runners. Needs a signed-in `gh`.
 *
 * Run with `node --run test:shard-weights -- <server|browser> [run-id]`.
 */

const SUITES = {
  server: { artifacts: "server-test-timings-*", weights: "apps/server/vitest.shard-weights.json" },
  browser: {
    artifacts: "browser-test-timings-*",
    weights: "apps/web/vitest.browser.shard-weights.json",
  },
} as const;
const TIMINGS_FILE = "test-timings.json";

const suiteName = process.argv[2];
if (suiteName !== "server" && suiteName !== "browser") {
  throw new Error("Usage: node --run test:shard-weights -- <server|browser> [run-id]");
}
const suite = SUITES[suiteName];
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const gh = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const runId =
  process.argv[3] ??
  gh([
    "run",
    "list",
    "--workflow=ci.yml",
    "--branch=main",
    "--event=push",
    "--status=success",
    "--limit=1",
    "--json=databaseId",
    "--jq=.[0].databaseId",
  ]);
if (!runId) {
  throw new Error("Found no green CI run on main to read test timings from.");
}

const downloadDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "threadlines-shard-weights-"),
);
const weights = new Map<string, number>();
try {
  gh(["run", "download", runId, `--pattern=${suite.artifacts}`, `--dir=${downloadDir}`]);
  const reports = NodeFS.readdirSync(downloadDir, { recursive: true, encoding: "utf8" }).filter(
    (entry) => NodePath.basename(entry) === TIMINGS_FILE,
  );
  if (reports.length === 0) {
    throw new Error(`CI run ${runId} has no ${suiteName} test timings.`);
  }
  for (const entry of reports) {
    const timings: Record<string, number> = JSON.parse(
      NodeFS.readFileSync(NodePath.join(downloadDir, entry), "utf8"),
    );
    for (const [file, seconds] of Object.entries(timings)) weights.set(file, seconds);
  }
  console.log(`Read ${reports.length} shard reports from CI run ${runId}.`);
} finally {
  NodeFS.rmSync(downloadDir, { recursive: true, force: true });
}

const sorted = [...weights].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
NodeFS.writeFileSync(
  NodePath.join(repoRoot, suite.weights),
  `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`,
);
console.log(`Recorded ${sorted.length} files in ${suite.weights}.`);
